-- DOCVAPE POS: expenses (cash / non-cash) and staff attendance with selfies.

create type expense_kind as enum ('cash', 'non_cash');
create type punch_kind as enum ('in', 'out');

create table expenses (
  id         uuid primary key,
  branch_id  uuid not null references branches(id),
  shift_id   uuid references shifts(id),        -- required for cash (paid from that drawer)
  staff_id   uuid not null references staff(id),
  name       text not null check (trim(name) <> ''),
  amount     numeric(12,2) not null check (amount > 0),
  kind       expense_kind not null,
  created_at timestamptz not null default now(),
  check (kind = 'non_cash' or shift_id is not null)
);
create index expenses_branch_time on expenses(branch_id, created_at);

create table attendance (
  id              uuid primary key,
  staff_id        uuid not null references staff(id),
  branch_id       uuid not null references branches(id),
  kind            punch_kind not null,
  at              timestamptz not null,
  photo_path      text,               -- object in the private "attendance" storage bucket
  no_photo_reason text,
  created_at      timestamptz not null default now()  -- photo_path is set after the selfie uploads
);
create index attendance_branch_time on attendance(branch_id, at);

alter table expenses enable row level security;
alter table attendance enable row level security;
create policy expenses_read on expenses for select to authenticated using (can_access_branch(branch_id));
create policy attendance_read on attendance for select to authenticated using (can_access_branch(branch_id));

-- {id, branch_id, shift_id?, staff_id, name, amount, kind, created_at}
create function add_expense(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'id')::uuid; v_branch uuid := (p->>'branch_id')::uuid; v_shift uuid := (p->>'shift_id')::uuid;
begin
  if exists (select 1 from expenses where id = v_id) then return v_id; end if;
  if not can_access_branch(v_branch) then raise exception 'not allowed'; end if;
  if v_shift is not null and not exists (select 1 from shifts where id = v_shift and branch_id = v_branch) then
    raise exception 'shift not found for this branch';
  end if;
  insert into expenses (id, branch_id, shift_id, staff_id, name, amount, kind, created_at)
  values (v_id, v_branch, v_shift, (p->>'staff_id')::uuid, trim(p->>'name'), (p->>'amount')::numeric,
          (p->>'kind')::expense_kind, coalesce((p->>'created_at')::timestamptz, now()));
  return v_id;
end $$;

-- {id, staff_id, branch_id, kind, at, no_photo_reason?}  (photo uploaded separately, then set_attendance_photo)
create function record_attendance(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'id')::uuid; v_branch uuid := (p->>'branch_id')::uuid;
begin
  if exists (select 1 from attendance where id = v_id) then return v_id; end if;
  if not can_access_branch(v_branch) then raise exception 'not allowed'; end if;
  insert into attendance (id, staff_id, branch_id, kind, at, no_photo_reason)
  values (v_id, (p->>'staff_id')::uuid, v_branch, (p->>'kind')::punch_kind,
          coalesce((p->>'at')::timestamptz, now()), nullif(p->>'no_photo_reason', ''));
  return v_id;
end $$;

create function set_attendance_photo(p_id uuid, p_path text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from attendance a where a.id = p_id and can_access_branch(a.branch_id)) then
    raise exception 'not allowed';
  end if;
  update attendance set photo_path = p_path where id = p_id;
end $$;

-- Private bucket for selfies: path "<branch_id>/<attendance_id>.jpg". Only runs on Supabase
-- (the local test database has no storage schema).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('attendance', 'attendance', false) on conflict do nothing;
    execute $p$create policy attendance_upload on storage.objects for insert to authenticated
      with check (bucket_id = 'attendance' and can_access_branch((storage.foldername(name))[1]::uuid))$p$;
    execute $p$create policy attendance_view on storage.objects for select to authenticated
      using (bucket_id = 'attendance' and can_access_branch((storage.foldername(name))[1]::uuid))$p$;
  end if;
end $$;
