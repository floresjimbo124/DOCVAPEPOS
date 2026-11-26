import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'fs';
const dir = new URL('../../supabase/migrations/', import.meta.url);
const db = new PGlite();
for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('PASS', n); };
const bad = (n, e) => { fail++; console.log('FAIL', n, e?.message ?? ''); };
const expectErr = async (n, sql) => { try { await db.exec(sql); bad(n, { message: 'no error' }); } catch { ok(n); } };
const one = async (sql) => (await db.query(sql)).rows[0];

const b = (await one(`insert into branches(name) values('Main') returning id`)).id;
const b2 = (await one(`insert into branches(name) values('Branch 2') returning id`)).id;
const s = (await one(`insert into staff(full_name, role, pin_hash) values('Ana','cashier','x') returning id`)).id;
const p = (await one(`insert into products(name) values('Juice') returning id`)).id;
const v = (await one(`insert into variants(product_id, flavor, nicotine_mg, price) values('${p}','Mango',3,350) returning id`)).id;

await db.exec(`insert into stock_movements(type,variant_id,branch_id,quantity) values('stock_in','${v}','${b}',10)`);
await db.exec(`insert into stock_movements(type,variant_id,branch_id,quantity) values('sale','${v}','${b}',-3)`);
(await one(`select quantity from stock where variant_id='${v}' and branch_id='${b}'`)).quantity === 7 ? ok('stock ledger updates stock (10-3=7)') : bad('stock ledger');

await expectErr('sale without age check rejected', `insert into sales(branch_id,staff_id) values('${b}','${s}')`);
const sale = (await one(`insert into sales(branch_id,staff_id,age_verified,manual_receipt_no) values('${b}','${s}',true,'0001') returning id`)).id;
ok('sale with age check accepted');
await expectErr('duplicate receipt no. in same branch rejected', `insert into sales(branch_id,staff_id,age_verified,manual_receipt_no) values('${b}','${s}',true,'0001')`);
await db.exec(`insert into sales(branch_id,staff_id,age_verified,manual_receipt_no) values('${b2}','${s}',true,'0001')`); ok('same receipt no. in another branch allowed');
await expectErr('GCash without reference rejected', `insert into payments(sale_id,method,amount) values('${sale}','gcash',350)`);
await db.exec(`insert into payments(sale_id,method,amount,reference_no) values('${sale}','gcash',350,'REF123')`); ok('GCash with reference accepted');
await expectErr('duplicate GCash reference rejected', `insert into payments(sale_id,method,amount,reference_no) values('${sale}','gcash',350,'REF123')`);
await expectErr('Senior discount without ID rejected', `insert into sale_discounts(sale_id,kind,value,amount) values('${sale}','senior',20,70)`);
await db.exec(`insert into shifts(branch_id,opened_by) values('${b}','${s}')`);
await expectErr('second open shift in branch rejected', `insert into shifts(branch_id,opened_by) values('${b}','${s}')`);
await expectErr('transfer to same branch rejected', `insert into transfers(from_branch_id,to_branch_id,sent_by) values('${b}','${b}','${s}')`);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
