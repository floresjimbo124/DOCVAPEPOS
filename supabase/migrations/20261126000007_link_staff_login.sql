-- When someone signs in for the first time (invitation accepted), connect their login
-- to the staff record with the same email. Owners/managers are created in `staff`
-- with their email first; this links them without any manual step.

create function link_staff_login() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update staff set auth_user_id = new.id
  where lower(email) = lower(new.email) and auth_user_id is null and is_active;
  return new;
end $$;
revoke execute on function link_staff_login() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'auth' and tablename = 'users') then
    execute 'create trigger on_auth_user_created after insert on auth.users
             for each row execute function public.link_staff_login()';
    -- also link anyone who already exists
    update staff s set auth_user_id = u.id from auth.users u
    where lower(s.email) = lower(u.email) and s.auth_user_id is null;
  end if;
end $$;
