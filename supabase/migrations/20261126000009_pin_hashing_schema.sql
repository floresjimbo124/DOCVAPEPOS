-- Fix: on Supabase the PIN hashing functions (pgcrypto: crypt, gen_salt) live in the
-- "extensions" schema, so the PIN functions must look there too. Without this, setting
-- or checking a PIN on the server fails with "function gen_salt/crypt does not exist".
alter function pin_matches(text, text) set search_path = public, extensions;
alter function set_staff_pin(uuid, text) set search_path = public, extensions;
