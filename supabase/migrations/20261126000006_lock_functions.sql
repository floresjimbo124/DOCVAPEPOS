-- Defense in depth: no server function is callable without signing in.
-- (Supabase lets the anonymous role execute new functions by default; every function
-- already checks branch access, but anonymous callers shouldn't reach them at all.)
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
revoke execute on function approver_for(uuid, text) from authenticated;  -- internal helper only
alter default privileges in schema public revoke execute on functions from anon, public;
