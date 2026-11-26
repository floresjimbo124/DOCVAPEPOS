-- DOCVAPE POS: voids and refunds synced from the registers.
-- The register checks the manager PIN offline; the server re-checks that the approver
-- is an active owner/manager allowed at that branch. Both are idempotent by device id.

create table refunds (
  id          uuid primary key,
  sale_id     uuid not null references sales(id),
  shift_id    uuid references shifts(id),
  branch_id   uuid not null references branches(id),
  staff_id    uuid not null references staff(id),
  approved_by uuid not null references staff(id),
  reason      text not null check (trim(reason) <> ''),
  method      payment_method not null,
  amount      numeric(12,2) not null check (amount > 0),
  created_at  timestamptz not null default now()
);
create table refund_items (
  refund_id  uuid not null references refunds(id) on delete cascade,
  variant_id uuid not null references variants(id),
  quantity   int not null check (quantity > 0),
  amount     numeric(12,2) not null,
  primary key (refund_id, variant_id)
);
alter table refunds enable row level security;
alter table refund_items enable row level security;
create policy refunds_read on refunds for select to authenticated using (can_access_branch(branch_id));
create policy refund_items_read on refund_items for select to authenticated
  using (exists (select 1 from refunds r where r.id = refund_id and can_access_branch(r.branch_id)));

create function is_approver(p_staff uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s where s.id = p_staff and s.is_active and s.role in ('owner', 'manager')
                 and (s.role = 'owner' or exists (select 1 from staff_branches sb where sb.staff_id = s.id and sb.branch_id = p_branch)))
$$;

-- {id, sale_id, staff_id, approved_by, reason, created_at}
create function record_void(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_sale sales%rowtype; v_by uuid := (p->>'approved_by')::uuid;
begin
  select * into v_sale from sales where id = (p->>'sale_id')::uuid for update;
  if not found then raise exception 'sale not found'; end if;
  if not can_access_branch(v_sale.branch_id) then raise exception 'not allowed'; end if;
  if v_sale.status = 'voided' then return; end if;  -- already synced
  if v_sale.status <> 'completed' or exists (select 1 from refunds where sale_id = v_sale.id) then
    raise exception 'sale cannot be voided';
  end if;
  if not is_approver(v_by, v_sale.branch_id) then raise exception 'approver must be an owner or manager'; end if;
  if coalesce(trim(p->>'reason'), '') = '' then raise exception 'reason required'; end if;

  update sales set status = 'voided', void_reason = trim(p->>'reason'), approved_by = v_by where id = v_sale.id;
  insert into stock_movements (type, variant_id, branch_id, quantity, sale_id, staff_id, reason)
  select 'refund', variant_id, v_sale.branch_id, quantity, v_sale.id, v_by, 'void: ' || trim(p->>'reason')
  from sale_items where sale_id = v_sale.id;
  insert into audit_log (action, staff_id, branch_id, entity, entity_id, before, after)
  values ('void', v_by, v_sale.branch_id, 'sale', v_sale.id, jsonb_build_object('total', v_sale.total),
          jsonb_build_object('reason', trim(p->>'reason'), 'by', (p->>'staff_id')));
end $$;

-- {id, sale_id, shift_id, staff_id, approved_by, reason, method, amount, items:[{variant_id, quantity, amount}], created_at}
create function record_refund(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'id')::uuid; v_sale sales%rowtype; v_by uuid := (p->>'approved_by')::uuid;
        it jsonb; v_sold int; v_done int; v_total_done numeric;
begin
  if exists (select 1 from refunds where id = v_id) then return v_id; end if;
  select * into v_sale from sales where id = (p->>'sale_id')::uuid for update;
  if not found then raise exception 'sale not found'; end if;
  if not can_access_branch(v_sale.branch_id) then raise exception 'not allowed'; end if;
  if v_sale.status = 'voided' then raise exception 'sale was voided'; end if;
  if not is_approver(v_by, v_sale.branch_id) then raise exception 'approver must be an owner or manager'; end if;
  if jsonb_array_length(coalesce(p->'items', '[]')) = 0 then raise exception 'no items to refund'; end if;

  for it in select * from jsonb_array_elements(p->'items') loop
    select coalesce(sum(quantity), 0) into v_sold from sale_items where sale_id = v_sale.id and variant_id = (it->>'variant_id')::uuid;
    select coalesce(sum(ri.quantity), 0) into v_done from refund_items ri join refunds r on r.id = ri.refund_id
      where r.sale_id = v_sale.id and ri.variant_id = (it->>'variant_id')::uuid;
    if (it->>'quantity')::int > v_sold - v_done then raise exception 'cannot refund more than was sold'; end if;
  end loop;
  select coalesce(sum(amount), 0) into v_total_done from refunds where sale_id = v_sale.id;
  if (p->>'amount')::numeric > v_sale.total - v_total_done then raise exception 'refund exceeds amount paid'; end if;

  insert into refunds (id, sale_id, shift_id, branch_id, staff_id, approved_by, reason, method, amount, created_at)
  values (v_id, v_sale.id, (p->>'shift_id')::uuid, v_sale.branch_id, (p->>'staff_id')::uuid, v_by, trim(p->>'reason'),
          (p->>'method')::payment_method, (p->>'amount')::numeric, coalesce((p->>'created_at')::timestamptz, now()));
  insert into refund_items (refund_id, variant_id, quantity, amount)
  select v_id, (i->>'variant_id')::uuid, (i->>'quantity')::int, (i->>'amount')::numeric from jsonb_array_elements(p->'items') i;
  insert into stock_movements (type, variant_id, branch_id, quantity, sale_id, staff_id, reason)
  select 'refund', (i->>'variant_id')::uuid, v_sale.branch_id, (i->>'quantity')::int, v_sale.id, v_by, 'refund: ' || trim(p->>'reason')
  from jsonb_array_elements(p->'items') i;
  if (select coalesce(sum(amount), 0) from refunds where sale_id = v_sale.id) >= v_sale.total then
    update sales set status = 'refunded' where id = v_sale.id;
  end if;
  insert into audit_log (action, staff_id, branch_id, entity, entity_id, after)
  values ('refund', v_by, v_sale.branch_id, 'sale', v_sale.id, jsonb_build_object('refund_id', v_id, 'amount', p->>'amount', 'reason', trim(p->>'reason')));
  return v_id;
end $$;
