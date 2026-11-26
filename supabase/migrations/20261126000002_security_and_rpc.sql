-- DOCVAPE POS: access control, PIN login, checkout / void functions
--
-- Who connects to the database:
--   * Owners / managers sign in to the dashboard with email (Supabase auth) -> staff.auth_user_id
--   * Each POS tablet/phone signs in once with a device account bound to ONE branch -> pos_devices
--   * Cashiers then identify themselves on the device with a PIN (verify_pin)
-- Tables are readable according to branch access; money and stock change only through
-- the SECURITY DEFINER functions below, so the rules can't be bypassed from the app.

create extension if not exists pgcrypto;

create table pos_devices (
  auth_user_id uuid primary key,
  branch_id    uuid not null references branches(id),
  label        text not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ---------- Helpers ----------
create function current_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff where auth_user_id = auth.uid() and is_active
$$;

create function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where auth_user_id = auth.uid() and is_active and role = 'owner')
$$;

create function can_access_branch(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_owner()
      or exists (select 1 from staff s join staff_branches sb on sb.staff_id = s.id
                 where s.auth_user_id = auth.uid() and s.is_active and sb.branch_id = b)
      or exists (select 1 from pos_devices d
                 where d.auth_user_id = auth.uid() and d.is_active and d.branch_id = b)
$$;

-- ---------- PINs ----------
-- True only for a real bcrypt hash that matches. Staff without a PIN set yet
-- (placeholder hash) simply never match instead of breaking login for everyone.
create function pin_matches(p_hash text, p_pin text) returns boolean
language sql immutable as $$
  select case when p_hash ~ '^\$2[abxy]\$' then p_hash = crypt(p_pin, p_hash) else false end
$$;
create function set_staff_pin(p_staff uuid, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() and current_staff_id() is distinct from p_staff then
    raise exception 'not allowed';
  end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'PIN must be 4-6 digits'; end if;
  update staff set pin_hash = crypt(p_pin, gen_salt('bf')) where id = p_staff;
end $$;

-- Returns the staff member if the PIN matches and they may work at this branch.
create function verify_pin(p_branch uuid, p_pin text)
returns table (staff_id uuid, full_name text, role staff_role)
language plpgsql security definer set search_path = public as $$
begin
  if not can_access_branch(p_branch) then raise exception 'not allowed'; end if;
  return query
    select s.id, s.full_name, s.role from staff s
    where s.is_active and pin_matches(s.pin_hash, p_pin)
      and (s.role = 'owner' or exists (select 1 from staff_branches sb
                                       where sb.staff_id = s.id and sb.branch_id = p_branch));
end $$;

-- Internal: check that a PIN belongs to a manager/owner for this branch.
create function approver_for(p_branch uuid, p_pin text) returns uuid
language sql stable security definer set search_path = public as $$
  select s.id from staff s
  where s.is_active and s.role in ('owner', 'manager')
    and pin_matches(s.pin_hash, p_pin)
    and (s.role = 'owner' or exists (select 1 from staff_branches sb
                                     where sb.staff_id = s.id and sb.branch_id = p_branch))
  limit 1
$$;

-- ---------- Checkout ----------
-- p_sale is the JSON the POS builds. Its "id" is generated on the device, so a sale
-- sent twice by the offline sync is stored once (the second call returns the same id).
-- {
--   id, branch_id, shift_id, staff_id, customer_id?, manual_receipt_no?, age_verified,
--   client_created_at?,
--   items:     [{variant_id, quantity, unit_price, discount?, serial_no?, batch_id?}],
--   discounts: [{kind, value, amount, id_holder?, id_number?}],
--   payments:  [{method, amount, tendered?, reference_no?}]
-- }
create function complete_sale(p_sale jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id       uuid := (p_sale->>'id')::uuid;
  v_branch   uuid := (p_sale->>'branch_id')::uuid;
  v_shift    uuid := (p_sale->>'shift_id')::uuid;
  v_staff    uuid := (p_sale->>'staff_id')::uuid;
  v_subtotal numeric := 0;
  v_disc     numeric := 0;
  v_total    numeric;
  v_paid     numeric := 0;
  v_cash     numeric := 0;
  it         jsonb;
begin
  if v_id is null then raise exception 'sale id required'; end if;
  if exists (select 1 from sales where id = v_id) then return v_id; end if;  -- already synced
  if not can_access_branch(v_branch) then raise exception 'not allowed'; end if;
  -- The shift must be open, or (offline sync) the sale must have been made before it closed.
  if not exists (select 1 from shifts where id = v_shift and branch_id = v_branch
                 and (closed_at is null
                      or coalesce((p_sale->>'client_created_at')::timestamptz, now()) <= closed_at)) then
    raise exception 'no open shift for this branch';
  end if;
  if jsonb_array_length(coalesce(p_sale->'items', '[]')) = 0 then raise exception 'sale has no items'; end if;

  for it in select * from jsonb_array_elements(p_sale->'items') loop
    if exists (select 1 from variants v join products p on p.id = v.product_id
               where v.id = (it->>'variant_id')::uuid and p.is_device)
       and coalesce(it->>'serial_no', '') = '' then
      raise exception 'serial number required for device';
    end if;
    v_subtotal := v_subtotal + (it->>'quantity')::int * (it->>'unit_price')::numeric
                             - coalesce((it->>'discount')::numeric, 0);
  end loop;
  select coalesce(sum((d->>'amount')::numeric), 0) into v_disc
    from jsonb_array_elements(coalesce(p_sale->'discounts', '[]')) d;
  v_total := round(v_subtotal - v_disc, 2);
  if v_total < 0 then raise exception 'discount exceeds subtotal'; end if;

  select coalesce(sum((x->>'amount')::numeric), 0),
         coalesce(sum((x->>'amount')::numeric) filter (where x->>'method' = 'cash'), 0)
    into v_paid, v_cash
    from jsonb_array_elements(coalesce(p_sale->'payments', '[]')) x;
  if v_paid <> v_total then raise exception 'payments (%) do not match total (%)', v_paid, v_total; end if;

  insert into sales (id, branch_id, shift_id, staff_id, customer_id, subtotal, discount_total, total,
                     manual_receipt_no, age_verified, client_created_at)
  values (v_id, v_branch, v_shift, v_staff, (p_sale->>'customer_id')::uuid, v_subtotal, v_disc, v_total,
          nullif(p_sale->>'manual_receipt_no', ''), coalesce((p_sale->>'age_verified')::boolean, false),
          (p_sale->>'client_created_at')::timestamptz);

  insert into sale_items (sale_id, variant_id, quantity, unit_price, unit_cost, discount, serial_no, batch_id)
  select v_id, (i->>'variant_id')::uuid, (i->>'quantity')::int, (i->>'unit_price')::numeric,
         (select cost from variants where id = (i->>'variant_id')::uuid),
         coalesce((i->>'discount')::numeric, 0), nullif(i->>'serial_no', ''), (i->>'batch_id')::uuid
  from jsonb_array_elements(p_sale->'items') i;

  insert into sale_discounts (sale_id, kind, value, amount, id_holder, id_number)
  select v_id, (d->>'kind')::discount_kind, (d->>'value')::numeric, (d->>'amount')::numeric,
         d->>'id_holder', d->>'id_number'
  from jsonb_array_elements(coalesce(p_sale->'discounts', '[]')) d;

  insert into payments (sale_id, method, amount, tendered, reference_no)
  select v_id, (x->>'method')::payment_method, (x->>'amount')::numeric, (x->>'tendered')::numeric,
         nullif(x->>'reference_no', '')
  from jsonb_array_elements(p_sale->'payments') x;

  insert into stock_movements (type, variant_id, branch_id, quantity, sale_id, staff_id)
  select 'sale', variant_id, v_branch, -quantity, v_id, v_staff from sale_items where sale_id = v_id;

  update batches b set quantity = b.quantity - si.quantity
    from sale_items si where si.sale_id = v_id and si.batch_id = b.id;

  return v_id;
end $$;

-- ---------- Void ----------
-- Cashiers need a manager/owner PIN; managers/owners can approve their own void.
create function void_sale(p_sale uuid, p_reason text, p_approver_pin text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_sale     sales%rowtype;
  v_approver uuid;
begin
  select * into v_sale from sales where id = p_sale for update;
  if not found then raise exception 'sale not found'; end if;
  if not can_access_branch(v_sale.branch_id) then raise exception 'not allowed'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale is already %', v_sale.status; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason required'; end if;
  v_approver := approver_for(v_sale.branch_id, p_approver_pin);
  if v_approver is null then raise exception 'manager PIN required'; end if;

  update sales set status = 'voided', void_reason = p_reason, approved_by = v_approver where id = p_sale;

  insert into stock_movements (type, variant_id, branch_id, quantity, sale_id, staff_id, reason)
  select 'refund', variant_id, v_sale.branch_id, quantity, p_sale, v_approver, 'void: ' || p_reason
  from sale_items where sale_id = p_sale;

  update batches b set quantity = b.quantity + si.quantity
    from sale_items si where si.sale_id = p_sale and si.batch_id = b.id;

  insert into audit_log (action, staff_id, branch_id, entity, entity_id, before, after)
  values ('void', v_approver, v_sale.branch_id, 'sale', p_sale,
          jsonb_build_object('status', v_sale.status, 'total', v_sale.total),
          jsonb_build_object('status', 'voided', 'reason', p_reason));
end $$;

-- ---------- Row-level security ----------
-- Read access by branch; catalogue readable by any signed-in staff/device;
-- writes to catalogue & branches by owners only. Sales/stock/payments: no direct
-- writes at all (only through the functions above).
do $$
declare t text;
begin
  foreach t in array array['branches','staff','staff_branches','categories','suppliers','products',
    'variants','bundle_items','stock','batches','transfers','transfer_items','shifts','cash_movements',
    'customers','sales','sale_items','sale_discounts','payments','stock_movements','audit_log','pos_devices']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;

  -- catalogue: everyone signed in reads, owners write
  foreach t in array array['categories','suppliers','products','variants','bundle_items'] loop
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
    execute format('create policy %I on %I for all to authenticated using (is_owner()) with check (is_owner())', t || '_owner_write', t);
  end loop;

  -- branch-scoped, read-only from the app
  foreach t in array array['stock','batches','shifts','sales','stock_movements','audit_log'] loop
    execute format('create policy %I on %I for select to authenticated using (can_access_branch(branch_id))', t || '_read', t);
  end loop;
end $$;

create policy branches_read on branches for select to authenticated using (can_access_branch(id));
create policy branches_owner_write on branches for all to authenticated using (is_owner()) with check (is_owner());

create policy staff_read on staff for select to authenticated
  using (is_owner() or id = current_staff_id()
         or exists (select 1 from staff_branches sb where sb.staff_id = staff.id and can_access_branch(sb.branch_id)));
create policy staff_owner_write on staff for all to authenticated using (is_owner()) with check (is_owner());
create policy staff_branches_read on staff_branches for select to authenticated using (can_access_branch(branch_id));
create policy staff_branches_owner_write on staff_branches for all to authenticated using (is_owner()) with check (is_owner());
create policy pos_devices_owner on pos_devices for all to authenticated using (is_owner()) with check (is_owner());

create policy transfers_read on transfers for select to authenticated
  using (can_access_branch(from_branch_id) or can_access_branch(to_branch_id));
create policy transfer_items_read on transfer_items for select to authenticated
  using (exists (select 1 from transfers t where t.id = transfer_id
                 and (can_access_branch(t.from_branch_id) or can_access_branch(t.to_branch_id))));
create policy cash_movements_read on cash_movements for select to authenticated
  using (exists (select 1 from shifts s where s.id = shift_id and can_access_branch(s.branch_id)));
create policy sale_children_items on sale_items for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_id and can_access_branch(s.branch_id)));
create policy sale_children_discounts on sale_discounts for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_id and can_access_branch(s.branch_id)));
create policy sale_children_payments on payments for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_id and can_access_branch(s.branch_id)));
create policy customers_read on customers for select to authenticated using (true);
create policy customers_write on customers for insert to authenticated with check (true);

-- The staff PIN hash is never readable from the app.
-- (Supabase grants whole-table SELECT by default, so revoke it and grant the safe columns.)
revoke select on staff from authenticated, anon;
grant select (id, auth_user_id, full_name, role, email, is_active, created_at) on staff to authenticated;
revoke all on function approver_for(uuid, text) from public, anon, authenticated;
