-- DOCVAPE POS: core schema (MVP)
-- Every operational record belongs to a branch, so new branches need no schema change.

-- ---------- Enums ----------
create type staff_role      as enum ('owner', 'manager', 'cashier');
create type payment_method  as enum ('cash', 'gcash', 'maya');
create type sale_status     as enum ('completed', 'voided', 'refunded', 'held');
create type movement_type   as enum ('stock_in', 'stock_out', 'sale', 'refund', 'transfer_out', 'transfer_in', 'count_adjust');
create type transfer_status as enum ('sent', 'received', 'cancelled');
create type discount_kind   as enum ('percent', 'fixed', 'senior', 'pwd');

-- ---------- Organisation ----------
create table branches (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  address      text,
  gcash_qr_url text,           -- uploaded QR image (storage path)
  maya_qr_url  text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table staff (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,    -- Supabase auth user (owners/managers with dashboard login)
  full_name    text not null,
  role         staff_role not null,
  pin_hash     text not null,  -- hashed 4-6 digit PIN, never plain text
  email        text unique,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table staff_branches (
  staff_id  uuid not null references staff(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  primary key (staff_id, branch_id)
);

-- ---------- Catalogue ----------
create table categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int not null default 0
);

create table suppliers (
  id      uuid primary key default gen_random_uuid(),
  name    text not null unique,
  contact text,
  phone   text
);

create table products (
  id              uuid primary key default gen_random_uuid(),
  category_id     uuid references categories(id),
  name            text not null,
  brand           text,
  regulatory_no   text,                      -- DTI/FDA registration number
  is_device       boolean not null default false,  -- requires serial number on sale
  is_bundle       boolean not null default false,
  tracks_expiry   boolean not null default false,  -- e-liquids, pods
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

create table variants (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  flavor        text,
  nicotine_mg   numeric(5,1),
  size_ml       numeric(6,1),
  color         text,
  sku           text unique,
  barcode       text unique,
  price         numeric(12,2) not null check (price >= 0),
  cost          numeric(12,2) not null default 0 check (cost >= 0),
  is_active     boolean not null default true
);

create table bundle_items (
  bundle_product_id uuid not null references products(id) on delete cascade,
  variant_id        uuid not null references variants(id),
  quantity          int not null check (quantity > 0),
  primary key (bundle_product_id, variant_id)
);

-- ---------- Inventory ----------
create table stock (
  variant_id      uuid not null references variants(id) on delete cascade,
  branch_id       uuid not null references branches(id) on delete cascade,
  quantity        int not null default 0,
  low_stock_level int not null default 0,
  primary key (variant_id, branch_id)
);

create table batches (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references variants(id),
  branch_id   uuid not null references branches(id),
  batch_no    text not null,
  expiry_date date,
  quantity    int not null check (quantity >= 0),
  unique (variant_id, branch_id, batch_no)
);

create table transfers (
  id             uuid primary key default gen_random_uuid(),
  from_branch_id uuid not null references branches(id),
  to_branch_id   uuid not null references branches(id),
  status         transfer_status not null default 'sent',
  sent_by        uuid not null references staff(id),
  received_by    uuid references staff(id),
  sent_at        timestamptz not null default now(),
  received_at    timestamptz,
  check (from_branch_id <> to_branch_id)
);

create table transfer_items (
  transfer_id uuid not null references transfers(id) on delete cascade,
  variant_id  uuid not null references variants(id),
  quantity    int not null check (quantity > 0),
  primary key (transfer_id, variant_id)
);

-- ---------- Shifts ----------
create table shifts (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id),
  opened_by      uuid not null references staff(id),
  closed_by      uuid references staff(id),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  starting_cash  numeric(12,2) not null default 0,
  counted_cash   numeric(12,2),
  expected_cash  numeric(12,2),
  z_reading_no   int            -- sequential per branch, set on close
);
create unique index one_open_shift_per_branch on shifts(branch_id) where closed_at is null;

create table cash_movements (
  id         uuid primary key default gen_random_uuid(),
  shift_id   uuid not null references shifts(id),
  amount     numeric(12,2) not null,   -- positive = cash in, negative = cash out
  reason     text not null,
  staff_id   uuid not null references staff(id),
  created_at timestamptz not null default now()
);

-- ---------- Customers ----------
create table customers (
  id         uuid primary key default gen_random_uuid(),
  full_name  text not null,
  phone      text unique,
  created_at timestamptz not null default now()
);

-- ---------- Sales ----------
create table sales (
  id                 uuid primary key default gen_random_uuid(),
  branch_id          uuid not null references branches(id),
  shift_id           uuid references shifts(id),
  staff_id           uuid not null references staff(id),
  customer_id        uuid references customers(id),
  status             sale_status not null default 'completed',
  subtotal           numeric(12,2) not null default 0,
  discount_total     numeric(12,2) not null default 0,
  total              numeric(12,2) not null default 0,
  manual_receipt_no  text,              -- BIR booklet receipt number
  age_verified       boolean not null default false,  -- RA 11900 check
  void_reason        text,
  approved_by        uuid references staff(id),       -- manager PIN approval
  client_created_at  timestamptz,       -- device time (offline sales)
  created_at         timestamptz not null default now(),
  check (status in ('held', 'voided') or age_verified)
);
create unique index sales_receipt_no_per_branch on sales(branch_id, manual_receipt_no)
  where manual_receipt_no is not null;

create table sale_items (
  id             uuid primary key default gen_random_uuid(),
  sale_id        uuid not null references sales(id) on delete cascade,
  variant_id     uuid not null references variants(id),
  quantity       int not null check (quantity > 0),
  unit_price     numeric(12,2) not null,
  unit_cost      numeric(12,2) not null default 0,
  discount       numeric(12,2) not null default 0,
  serial_no      text,
  batch_id       uuid references batches(id)
);

create table sale_discounts (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references sales(id) on delete cascade,
  kind         discount_kind not null,
  value        numeric(12,2) not null,
  amount       numeric(12,2) not null,
  id_holder    text,   -- Senior/PWD name
  id_number    text,   -- Senior/PWD ID
  check (kind not in ('senior', 'pwd') or (id_holder is not null and id_number is not null))
);

create table payments (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references sales(id) on delete cascade,
  method       payment_method not null,
  amount       numeric(12,2) not null check (amount > 0),
  tendered     numeric(12,2),           -- cash given
  reference_no text,
  created_at   timestamptz not null default now(),
  check (method = 'cash' or reference_no is not null)
);
-- Same GCash/Maya reference can never be used twice, across all branches.
create unique index payments_unique_reference on payments(method, reference_no)
  where reference_no is not null;

-- ---------- Stock ledger ----------
create table stock_movements (
  id          uuid primary key default gen_random_uuid(),
  type        movement_type not null,
  variant_id  uuid not null references variants(id),
  branch_id   uuid not null references branches(id),
  quantity    int not null,   -- signed: + adds stock, - removes
  reason      text,
  sale_id     uuid references sales(id),
  transfer_id uuid references transfers(id),
  staff_id    uuid references staff(id),
  created_at  timestamptz not null default now()
);

-- Keep stock in sync with the ledger.
create function apply_stock_movement() returns trigger language plpgsql as $$
begin
  insert into stock (variant_id, branch_id, quantity)
  values (new.variant_id, new.branch_id, new.quantity)
  on conflict (variant_id, branch_id)
  do update set quantity = stock.quantity + excluded.quantity;
  return new;
end $$;

create trigger stock_movements_apply
after insert on stock_movements
for each row execute function apply_stock_movement();

-- ---------- Audit ----------
create table audit_log (
  id         bigint generated always as identity primary key,
  action     text not null,      -- void, refund, discount, price_change, login, ...
  staff_id   uuid references staff(id),
  branch_id  uuid references branches(id),
  entity     text,
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);

-- ---------- Indexes for reports ----------
create index sales_branch_time on sales(branch_id, created_at);
create index sale_items_variant on sale_items(variant_id);
create index stock_movements_variant_branch on stock_movements(variant_id, branch_id, created_at);
create index batches_expiry on batches(expiry_date) where quantity > 0;
