-- DOCVAPE POS: setting up tablets/phones as POS devices, and tighter read access.
--
-- A device signs in anonymously (its own account, kept on the device). An owner, or the
-- branch's manager, then approves it on that same device with their email login, which
-- binds the device account to ONE branch (register_device). Until approved, a device
-- account can read nothing.

-- Signed in as an active staff login or an approved device (not just "any account").
create function is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select current_staff_id() is not null
      or exists (select 1 from pos_devices d where d.auth_user_id = auth.uid() and d.is_active)
$$;

-- The catalogue and customers were readable by any signed-in account; limit them to members.
do $$
declare t text;
begin
  foreach t in array array['categories','suppliers','products','variants','bundle_items'] loop
    execute format('drop policy %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_member())', t || '_read', t);
  end loop;
end $$;
drop policy customers_read on customers;
drop policy customers_write on customers;
create policy customers_read on customers for select to authenticated using (is_member());
create policy customers_write on customers for insert to authenticated with check (is_member());

-- Approve this device account for a branch. Owners: any branch. Managers: their own branches.
create function register_device(p_device uuid, p_branch uuid, p_label text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (is_owner() or exists (
      select 1 from staff s join staff_branches sb on sb.staff_id = s.id
      where s.auth_user_id = auth.uid() and s.is_active and s.role = 'manager' and sb.branch_id = p_branch)) then
    raise exception 'only the owner or this branch''s manager can set up a device';
  end if;
  if not exists (select 1 from branches where id = p_branch and is_active) then raise exception 'branch not found'; end if;
  if p_device is null or p_device = auth.uid() or exists (select 1 from staff where auth_user_id = p_device) then
    raise exception 'not a device account';
  end if;
  if coalesce(trim(p_label), '') = '' then raise exception 'name this device'; end if;
  insert into pos_devices (auth_user_id, branch_id, label) values (p_device, p_branch, trim(p_label))
  on conflict (auth_user_id) do update set branch_id = excluded.branch_id, label = excluded.label, is_active = true;
  insert into audit_log (action, staff_id, branch_id, entity, entity_id, after)
  values ('device_register', current_staff_id(), p_branch, 'device', p_device, jsonb_build_object('label', trim(p_label)));
end $$;

-- What this device is (nothing if it is not approved or was switched off).
create function device_info() returns table (branch_id uuid, branch_name text, label text)
language sql stable security definer set search_path = public as $$
  select d.branch_id, b.name, d.label from pos_devices d join branches b on b.id = d.branch_id
  where d.auth_user_id = auth.uid() and d.is_active
$$;

-- The signed-in staff member (owner/manager email login), and whether their PIN is set.
create function my_profile() returns table (staff_id uuid, full_name text, role staff_role, pin_set boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.full_name, s.role, s.pin_hash ~ '^\$2[abxy]\$' from staff s
  where s.auth_user_id = auth.uid() and s.is_active
$$;

-- Link a login to its staff record only once the email is confirmed (someone signing up
-- with a staff member's address can't take over their record without that inbox).
create or replace function link_staff_login() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is null or new.email_confirmed_at is null then return new; end if;
  update staff set auth_user_id = new.id
  where lower(email) = lower(new.email) and auth_user_id is null and is_active;
  return new;
end $$;

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'auth' and tablename = 'users') then
    execute 'drop trigger if exists on_auth_user_created on auth.users';
    execute 'create trigger on_auth_user_created after insert or update of email_confirmed_at on auth.users
             for each row execute function public.link_staff_login()';
  end if;
end $$;

revoke execute on function is_member(), register_device(uuid, uuid, text), device_info(), my_profile() from public, anon;
grant execute on function is_member(), register_device(uuid, uuid, text), device_info(), my_profile() to authenticated;
