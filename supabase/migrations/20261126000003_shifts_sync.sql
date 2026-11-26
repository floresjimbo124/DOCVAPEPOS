-- DOCVAPE POS: shift sync functions and offline staff list for POS devices.
-- Every function takes the id generated on the device, so a retry after a
-- dropped connection is stored once.

-- Staff a POS device may log in offline: active staff assigned to the device's
-- branch, plus owners. Returns PIN hashes ONLY to signed-in POS device accounts.
create function device_staff()
returns table (id uuid, full_name text, role staff_role, pin_hash text)
language plpgsql stable security definer set search_path = public as $$
declare v_branch uuid;
begin
  select d.branch_id into v_branch from pos_devices d where d.auth_user_id = auth.uid() and d.is_active;
  if v_branch is null then raise exception 'not a POS device'; end if;
  return query
    select s.id, s.full_name, s.role, s.pin_hash from staff s
    where s.is_active and (s.role = 'owner'
      or exists (select 1 from staff_branches sb where sb.staff_id = s.id and sb.branch_id = v_branch));
end $$;

-- {id, branch_id, opened_by, starting_cash, opened_at}
create function open_shift(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'id')::uuid; v_branch uuid := (p->>'branch_id')::uuid;
begin
  if exists (select 1 from shifts where id = v_id) then return v_id; end if;
  if not can_access_branch(v_branch) then raise exception 'not allowed'; end if;
  insert into shifts (id, branch_id, opened_by, opened_at, starting_cash)
  values (v_id, v_branch, (p->>'opened_by')::uuid, coalesce((p->>'opened_at')::timestamptz, now()),
          coalesce((p->>'starting_cash')::numeric, 0));
  return v_id;
end $$;

-- {id, shift_id, staff_id, amount (+in / -out), reason, created_at}
create function add_cash_movement(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'id')::uuid; v_shift shifts%rowtype;
begin
  if exists (select 1 from cash_movements where id = v_id) then return v_id; end if;
  select * into v_shift from shifts where id = (p->>'shift_id')::uuid;
  if not found then raise exception 'shift not found'; end if;
  if not can_access_branch(v_shift.branch_id) then raise exception 'not allowed'; end if;
  if coalesce(trim(p->>'reason'), '') = '' then raise exception 'reason required'; end if;
  insert into cash_movements (id, shift_id, amount, reason, staff_id, created_at)
  values (v_id, v_shift.id, (p->>'amount')::numeric, trim(p->>'reason'), (p->>'staff_id')::uuid,
          coalesce((p->>'created_at')::timestamptz, now()));
  return v_id;
end $$;

-- {id, closed_by, counted_cash, expected_cash, closed_at}
-- The Z-reading number is assigned here, per branch, so several devices at one
-- branch never produce duplicate numbers (the device shows its own until synced).
create function close_shift(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_shift shifts%rowtype; v_z int;
begin
  select * into v_shift from shifts where id = (p->>'id')::uuid for update;
  if not found then raise exception 'shift not found'; end if;
  if not can_access_branch(v_shift.branch_id) then raise exception 'not allowed'; end if;
  if v_shift.closed_at is not null then return v_shift.z_reading_no; end if;  -- already synced
  select coalesce(max(z_reading_no), 0) + 1 into v_z from shifts where branch_id = v_shift.branch_id;
  update shifts set closed_at = coalesce((p->>'closed_at')::timestamptz, now()), closed_by = (p->>'closed_by')::uuid,
    counted_cash = (p->>'counted_cash')::numeric, expected_cash = (p->>'expected_cash')::numeric, z_reading_no = v_z
  where id = v_shift.id;
  insert into audit_log (action, staff_id, branch_id, entity, entity_id, after)
  values ('shift_close', (p->>'closed_by')::uuid, v_shift.branch_id, 'shift', v_shift.id,
          jsonb_build_object('counted', p->>'counted_cash', 'expected', p->>'expected_cash', 'z', v_z));
  return v_z;
end $$;
