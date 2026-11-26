// Runs all Supabase migrations in an in-memory Postgres (PGlite) and checks the business rules.
// Usage: npm test
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';

const db = new PGlite({ extensions: { pgcrypto } });

// Minimal stand-in for what Supabase provides: auth.uid(), the API roles, default grants.
await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);
const dir = new URL('../../supabase/migrations/', import.meta.url);
for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('PASS', n); };
const bad = (n, m) => { fail++; console.log('FAIL', n, m ?? ''); };
const check = (n, cond, m) => (cond ? ok(n) : bad(n, m));
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const expectErr = async (n, fn, match) => {
  try { await fn(); bad(n, 'no error'); }
  catch (e) { (!match || e.message.includes(match)) ? ok(n) : bad(n, e.message); }
};
const asAdmin = () => db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`);
const asUser = (uid) => db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false)`);

// ---------- Seed (as admin) ----------
const ownerUid = randomUUID(), deviceUid = randomUUID(), device2Uid = randomUUID();
const b = (await one(`insert into branches(name) values('Main') returning id`)).id;
const b2 = (await one(`insert into branches(name) values('Branch 2') returning id`)).id;
const owner = (await one(`insert into staff(full_name, role, pin_hash, auth_user_id) values('Owner','owner','x',$1) returning id`, [ownerUid])).id;
const cashier = (await one(`insert into staff(full_name, role, pin_hash) values('Ana','cashier','x') returning id`)).id;
const manager = (await one(`insert into staff(full_name, role, pin_hash) values('Ben','manager','x') returning id`)).id;
await db.exec(`insert into staff_branches values ('${cashier}','${b}'), ('${manager}','${b}')`);
await db.exec(`insert into pos_devices values ('${deviceUid}','${b}','Main tablet'), ('${device2Uid}','${b2}','B2 tablet')`);
const p = (await one(`insert into products(name) values('Juice') returning id`)).id;
const dp = (await one(`insert into products(name, is_device) values('Pod Kit', true) returning id`)).id;
const v = (await one(`insert into variants(product_id, flavor, nicotine_mg, price, cost) values($1,'Mango',3,350,200) returning id`, [p])).id;
const dv = (await one(`insert into variants(product_id, color, price) values($1,'Black',1200) returning id`, [dp])).id;
await db.exec(`insert into stock_movements(type,variant_id,branch_id,quantity) values('stock_in','${v}','${b}',10),('stock_in','${dv}','${b}',5)`);

// ---------- Core schema rules ----------
const stockOf = async (variant) => (await one(`select quantity from stock where variant_id=$1 and branch_id=$2`, [variant, b])).quantity;
check('stock ledger updates stock', (await stockOf(v)) === 10);
await expectErr('sale without age check rejected', () => db.exec(`insert into sales(branch_id,staff_id) values('${b}','${cashier}')`));
await expectErr('transfer to same branch rejected', () => db.exec(`insert into transfers(from_branch_id,to_branch_id,sent_by) values('${b}','${b}','${cashier}')`));
await expectErr('Senior discount without ID rejected', async () => {
  const s = (await one(`insert into sales(branch_id,staff_id,age_verified) values('${b}','${cashier}',true) returning id`)).id;
  await db.exec(`insert into sale_discounts(sale_id,kind,value,amount) values('${s}','senior',20,70)`);
});

// ---------- PINs ----------
await asUser(ownerUid);
await db.query(`select set_staff_pin($1,'1234')`, [cashier]);
await db.query(`select set_staff_pin($1,'9999')`, [manager]);
await expectErr('PIN must be digits', () => db.query(`select set_staff_pin($1,'12a4')`, [cashier]), '4-6 digits');
await asAdmin();
check('PIN stored hashed', (await one(`select pin_hash from staff where id=$1`, [cashier])).pin_hash.startsWith('$2'));

await asUser(deviceUid);
check('correct PIN logs in', (await one(`select * from verify_pin($1,'1234')`, [b]))?.staff_id === cashier);
check('wrong PIN rejected', !(await one(`select * from verify_pin($1,'0000')`, [b])));
await expectErr('device cannot log in at other branch', () => db.query(`select * from verify_pin($1,'1234')`, [b2]), 'not allowed');
await expectErr('PIN hash not readable from app', () => db.query(`select pin_hash from staff`));

// ---------- Shift + checkout ----------
await asAdmin();
const shift = (await one(`insert into shifts(branch_id,opened_by,starting_cash) values($1,$2,1000) returning id`, [b, cashier])).id;
await expectErr('second open shift rejected', () => db.exec(`insert into shifts(branch_id,opened_by) values('${b}','${cashier}')`));

await asUser(deviceUid);
const sale = (over = {}) => ({
  id: randomUUID(), branch_id: b, shift_id: shift, staff_id: cashier, age_verified: true,
  manual_receipt_no: null,
  items: [{ variant_id: v, quantity: 2, unit_price: 350 }],
  discounts: [], payments: [{ method: 'cash', amount: 700, tendered: 1000 }], ...over,
});
const complete = (s) => db.query(`select complete_sale($1::jsonb) as id`, [JSON.stringify(s)]);

const s1 = sale({ manual_receipt_no: '0001' });
await complete(s1);
check('checkout records sale', (await one(`select total from sales where id=$1`, [s1.id]))?.total === '700.00');
check('checkout deducts stock (10-2=8)', (await stockOf(v)) === 8);
await complete(s1);
check('same sale synced twice is stored once', (await stockOf(v)) === 8);

await expectErr('payment mismatch rejected', () => complete(sale({ payments: [{ method: 'cash', amount: 500 }] })), 'do not match');
await expectErr('sale without age check rejected', () => complete(sale({ age_verified: false })));
await expectErr('duplicate receipt no. rejected', () => complete(sale({ manual_receipt_no: '0001' })));
await expectErr('GCash without reference rejected', () => complete(sale({ payments: [{ method: 'gcash', amount: 700 }] })));
await complete(sale({ payments: [{ method: 'gcash', amount: 700, reference_no: 'REF123' }] }));
ok('GCash with reference accepted');
await expectErr('reused GCash reference rejected', () => complete(sale({ payments: [{ method: 'gcash', amount: 700, reference_no: 'REF123' }] })));
await complete(sale({ payments: [{ method: 'cash', amount: 300 }, { method: 'maya', amount: 400, reference_no: 'M-1' }] }));
ok('split payment cash + Maya accepted');
await expectErr('device without serial rejected', () => complete(sale({ items: [{ variant_id: dv, quantity: 1, unit_price: 1200 }], payments: [{ method: 'cash', amount: 1200 }] })), 'serial');
await complete(sale({
  items: [{ variant_id: v, quantity: 1, unit_price: 350 }],
  discounts: [{ kind: 'senior', value: 20, amount: 70, id_holder: 'Lola', id_number: 'SC-1' }],
  payments: [{ method: 'cash', amount: 280 }],
}));
ok('Senior discount with ID accepted');

await expectErr('direct insert into sales blocked', () => db.exec(`insert into sales(branch_id,staff_id,age_verified) values('${b}','${cashier}',true)`));
await expectErr('direct stock edit blocked', () => db.exec(`update stock set quantity = 999`).then(async () => {
  if ((await stockOf(v)) !== 999) throw new Error('blocked');
}));

// ---------- Void ----------
const before = await stockOf(v);
await expectErr('void with cashier PIN rejected', () => db.query(`select void_sale($1,'wrong item','1234')`, [s1.id]), 'manager PIN');
await expectErr('void without reason rejected', () => db.query(`select void_sale($1,'','9999')`, [s1.id]), 'reason');
await db.query(`select void_sale($1,'wrong item','9999')`, [s1.id]);
check('void with manager PIN restores stock', (await stockOf(v)) === before + 2);
check('void is audited', !!(await one(`select 1 from audit_log where entity_id=$1 and action='void'`, [s1.id])));
await expectErr('double void rejected', () => db.query(`select void_sale($1,'again','9999')`, [s1.id]), 'already');

// ---------- Branch isolation ----------
await asUser(device2Uid);
check('other branch device cannot see Main sales', (await db.query(`select * from sales`)).rows.length === 0);
await expectErr('other branch device cannot sell into Main', () => complete(sale()), 'not allowed');
await asUser(ownerUid);
check('owner sees all branches', (await db.query(`select * from branches`)).rows.length === 2);

await asAdmin();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
