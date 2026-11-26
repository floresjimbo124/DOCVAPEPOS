-- The client's owner account. Their login (Supabase Auth) links to this row
-- automatically when they accept the invitation (see link_staff_login trigger).
-- The PIN is set by the owner later in the back office; until then no PIN matches.
insert into staff (full_name, role, pin_hash, email)
select 'Owner', 'owner', 'not-set', 'docvapedapitan@gmail.com'
where not exists (select 1 from staff where lower(email) = 'docvapedapitan@gmail.com');

update staff s set auth_user_id = u.id from auth.users u
where lower(s.email) = lower(u.email) and s.auth_user_id is null;

select full_name, role, email, auth_user_id is not null as login_linked from staff order by created_at;
