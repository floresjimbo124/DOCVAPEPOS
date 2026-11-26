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

// ---------- Shift sync + device staff ----------
await asUser(deviceUid);
const ds = (await db.query(`select * from device_staff()`)).rows;
check('device gets its branch staff + owner for offline PIN login', ds.length === 3 && ds.every((r) => r.pin_hash));
await asUser(ownerUid);
await expectErr('non-device cannot pull PIN hashes', () => db.query(`select * from device_staff()`), 'not a POS device');

await asUser(deviceUid);
const rpc = (fn, p) => db.query(`select ${fn}($1::jsonb) as r`, [JSON.stringify(p)]).then((x) => x.rows[0].r);
const mv = { id: randomUUID(), shift_id: shift, staff_id: cashier, amount: '-200.00', reason: 'Bought water' };
await rpc('add_cash_movement', mv); await rpc('add_cash_movement', mv);
await asAdmin();
check('cash movement retried is stored once', (await one(`select count(*)::int n from cash_movements where shift_id=$1`, [shift])).n === 1);
await asUser(deviceUid);
await expectErr('cash movement needs reason', () => rpc('add_cash_movement', { ...mv, id: randomUUID(), reason: ' ' }), 'reason');

const closeAt = new Date(Date.now() + 60_000).toISOString();
const z1 = await rpc('close_shift', { id: shift, closed_by: cashier, counted_cash: '1000', expected_cash: '1000', closed_at: closeAt });
check('close_shift assigns Z #1 for the branch', z1 === 1);
check('close_shift retried returns same Z', (await rpc('close_shift', { id: shift, closed_by: cashier })) === 1);
await complete(sale({ client_created_at: new Date(Date.now()).toISOString() }));
ok('offline sale made before close is accepted after close');
await expectErr('sale made after close is rejected', () => complete(sale({ client_created_at: new Date(Date.now() + 120_000).toISOString() })), 'no open shift');

const shift2 = randomUUID();
const op = { id: shift2, branch_id: b, opened_by: manager, starting_cash: '500.00' };
await rpc('open_shift', op); await rpc('open_shift', op);
ok('open_shift retried is stored once');
check('next close gets Z #2', (await rpc('close_shift', { id: shift2, closed_by: manager, counted_cash: '500', expected_cash: '500' })) === 2);
await asUser(device2Uid);
await expectErr('other branch device cannot open shift here', () => rpc('open_shift', { id: randomUUID(), branch_id: b, opened_by: manager }), 'not allowed');

await asAdmin();
// ---------- Expenses + attendance ----------
await asUser(deviceUid);
const ex = { id: randomUUID(), branch_id: b, shift_id: shift2, staff_id: cashier, name: 'Water', amount: '50.00', kind: 'cash' };
await rpc('add_expense', ex); await rpc('add_expense', ex);
await rpc('add_expense', { id: randomUUID(), branch_id: b, staff_id: manager, name: 'Electric bill', amount: '3500', kind: 'non_cash' });
await expectErr('cash expense needs a shift', () => rpc('add_expense', { ...ex, id: randomUUID(), shift_id: null }));
await expectErr('expense needs a name', () => rpc('add_expense', { ...ex, id: randomUUID(), name: '  ' }));
await expectErr('expense amount must be positive', () => rpc('add_expense', { ...ex, id: randomUUID(), amount: '0' }));
check('expenses stored once each', (await db.query(`select * from expenses`)).rows.length === 2);

const punch = { id: randomUUID(), staff_id: cashier, branch_id: b, kind: 'in', at: new Date().toISOString() };
await rpc('record_attendance', punch); await rpc('record_attendance', punch);
await db.query(`select set_attendance_photo($1, $2)`, [punch.id, `${b}/${punch.id}.jpg`]);
check('attendance stored once with photo path', (await one(`select photo_path from attendance where id=$1`, [punch.id]))?.photo_path?.endsWith('.jpg'));
await asUser(device2Uid);
check('other branch cannot see expenses or attendance',
  (await db.query(`select * from expenses`)).rows.length === 0 && (await db.query(`select * from attendance`)).rows.length === 0);
await expectErr('other branch cannot set photo', () => db.query(`select set_attendance_photo($1, 'x')`, [punch.id]), 'not allowed');

// ---------- Voids and refunds synced from the register ----------
await asAdmin();
const shift3 = (await one(`insert into shifts(branch_id,opened_by) values($1,$2) returning id`, [b, cashier])).id;
await asUser(deviceUid);
const twoPods = (extra = {}) => sale({ shift_id: shift3, items: [{ variant_id: v, quantity: 2, unit_price: '350' }], payments: [{ method: 'cash', amount: 700 }], ...extra });
const sv = twoPods(); await complete(sv);
const sr = twoPods(); await complete(sr);
const voidP = { sale_id: sv.id, staff_id: cashier, approved_by: manager, reason: 'Wrong item' };
await expectErr('void approved by a cashier is rejected', () => rpc('record_void', { ...voidP, approved_by: cashier }), 'owner or manager');
const before2 = await stockOf(v);
await rpc('record_void', voidP); await rpc('record_void', voidP);
check('synced void restocks once', (await stockOf(v)) === before2 + 2);
await expectErr('cannot refund a voided sale', () => rpc('record_refund', { id: randomUUID(), sale_id: sv.id, staff_id: cashier, approved_by: manager, reason: 'x', method: 'cash', amount: '350', items: [{ variant_id: v, quantity: 1, amount: '350' }] }), 'voided');

const rf = { id: randomUUID(), sale_id: sr.id, shift_id: shift3, staff_id: cashier, approved_by: manager, reason: 'Defective', method: 'cash', amount: '350.00', items: [{ variant_id: v, quantity: 1, amount: '350.00' }] };
await rpc('record_refund', rf); await rpc('record_refund', rf);
check('refund stored once and restocks', (await stockOf(v)) === before2 + 3);
await expectErr('cannot refund more than sold', () => rpc('record_refund', { ...rf, id: randomUUID(), items: [{ variant_id: v, quantity: 2, amount: '700' }], amount: '700' }), 'more than was sold');
await expectErr('void after a refund is rejected', () => rpc('record_void', { ...voidP, sale_id: sr.id }), 'cannot be voided');
await rpc('record_refund', { ...rf, id: randomUUID() });
await asAdmin();
check('fully refunded sale is marked refunded', (await one(`select status from sales where id=$1`, [sr.id])).status === 'refunded');
check('void and refunds are audited', (await one(`select count(*)::int n from audit_log where action in ('void','refund')`)).n >= 3);

// ---------- Device setup ----------
const newDevice = randomUUID(), stranger = randomUUID(), mgrUid = randomUUID();
await asAdmin();
await db.query(`update staff set auth_user_id=$1 where id=$2`, [mgrUid, manager]);
await asUser(stranger);
check('unapproved account sees no catalogue or customers',
  (await db.query(`select * from products`)).rows.length === 0 && (await db.query(`select * from customers`)).rows.length === 0);
await expectErr('random account cannot approve a device', () => db.query(`select register_device($1,$2,'x')`, [stranger, b]), 'only the owner');
await asUser(mgrUid);
await expectErr('manager cannot approve a device for another branch', () => db.query(`select register_device($1,$2,'x')`, [newDevice, b2]), 'only the owner');
await expectErr('staff login cannot be made a device', () => db.query(`select register_device($1,$2,'x')`, [ownerUid, b]), 'not a device');
await expectErr('device needs a name', () => db.query(`select register_device($1,$2,'  ')`, [newDevice, b]), 'name this device');
await db.query(`select register_device($1,$2,'Counter tablet')`, [newDevice, b]);
check('manager profile shows PIN is set', (await one(`select * from my_profile()`)).pin_set === true);
await asUser(newDevice);
const info = await one(`select * from device_info()`);
check('approved device knows its branch', info?.branch_id === b && info?.label === 'Counter tablet');
check('approved device reads the catalogue', (await db.query(`select * from products`)).rows.length >= 2);
check('approved device gets its staff for offline login', (await db.query(`select * from device_staff()`)).rows.length >= 3);
await asUser(ownerUid);
await db.query(`select register_device($1,$2,'Moved tablet')`, [newDevice, b2]);
await asUser(newDevice);
check('owner can move a device to another branch', (await one(`select * from device_info()`))?.branch_id === b2);
await asAdmin();
await db.query(`update pos_devices set is_active=false where auth_user_id=$1`, [newDevice]);
await asUser(newDevice);
check('switched-off device loses access', !(await one(`select * from device_info()`)) && (await db.query(`select * from products`)).rows.length === 0);

await asAdmin();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
