import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { verifyApprover, verifyPin } from './auth'
import { DEMO_BRANCH, seedDemoIfEmpty, seedDemoStaffIfEmpty } from './demoSeed'
import { LocalDb, type DeviceSettings } from './localDb'

let db: LocalDb
beforeEach(async () => {
  db = new LocalDb(`test-${crypto.randomUUID()}`)
  await seedDemoIfEmpty(db)
  await seedDemoStaffIfEmpty(db)
})
afterEach(() => db.delete())
const B = DEMO_BRANCH.branchId

test('PIN login works offline against cached hashes', async () => {
  expect((await verifyPin(db, '1234'))?.fullName).toBe('Ana (Cashier)')
  expect(await verifyPin(db, '1111')).toBeUndefined()
  expect(await verifyPin(db, '12')).toBeUndefined()
  expect(await verifyApprover(db, '1234')).toBeUndefined() // cashier can't approve
  expect((await verifyApprover(db, '9999'))?.role).toBe('manager')
  await db.staff.update('00000000-0000-4000-8000-0000000000a1', { isActive: false })
  expect(await verifyPin(db, '1234')).toBeUndefined() // deactivated staff locked out
  expect((await db.getSetting<DeviceSettings>('device'))?.branchName).toBe('P. Campa Branch')
})

test('staff seeding twice at once is safe', async () => {
  const fresh = new LocalDb(`test-${crypto.randomUUID()}`)
  await Promise.all([seedDemoStaffIfEmpty(fresh), seedDemoStaffIfEmpty(fresh)])
  expect(await fresh.staff.count()).toBe(3)
  await fresh.delete()
})

test('open shift, sell, cash in/out, close with Z-reading', async () => {
  const shift = await db.openShift(B, 'ana', 100000)
  await expect(db.openShift(B, 'ben', 0)).rejects.toThrow(/already open/)
  expect((await db.openShiftFor(B))?.id).toBe(shift.id)

  await db.queueSale({
    id: 's1', branch_id: B, shift_id: shift.id, staff_id: 'ana', age_verified: true, manual_receipt_no: '0001',
    client_created_at: '', discounts: [], items: [{ variant_id: 'v-pod-straw', quantity: 1, unit_price: '550.00' }],
    payments: [{ method: 'cash', amount: '550.00', tendered: '1000.00' }],
  })
  await db.addCashMove(shift.id, 'ana', -20000, 'Bought water')
  await expect(db.addCashMove(shift.id, 'ana', 5000, '  ')).rejects.toThrow(/Reason/)

  const live = await db.shiftSummary(shift)
  expect(live.expectedCashCentavos).toBe(100000 + 55000 - 20000)

  const { shift: closed, summary } = await db.closeShift(shift.id, 'ana', 134500)
  expect(closed.zNo).toBe(1)
  expect(summary.saleCount).toBe(1)
  expect(closed.countedCentavos! - closed.expectedCentavos!).toBe(-500) // ₱5 short
  expect(await db.openShiftFor(B)).toBeUndefined()
  await expect(db.closeShift(shift.id, 'ana', 0)).rejects.toThrow(/not open/)

  const next = await db.openShift(B, 'ben', 50000)
  expect((await db.closeShift(next.id, 'ben', 50000)).shift.zNo).toBe(2) // Z numbers keep counting

  // everything is queued for the server: 1 sale + open/move/close + open/close
  expect(await db.pendingCount()).toBe(1 + 5)
  expect((await db.ops.toArray()).map((o) => o.kind).sort()).toEqual(
    ['cash_movement', 'shift_close', 'shift_close', 'shift_open', 'shift_open'])
})

test('expenses: cash comes out of the drawer, non-cash is only recorded', async () => {
  await expect(db.addExpense({ branchId: B, staffId: 'ana', name: 'Water', amountCentavos: 5000, kind: 'cash' })).rejects.toThrow(/Open a shift/)
  const shift = await db.openShift(B, 'ana', 100000)
  await db.addExpense({ branchId: B, shiftId: shift.id, staffId: 'ana', name: 'Water', amountCentavos: 5000, kind: 'cash' })
  await db.addExpense({ branchId: B, shiftId: shift.id, staffId: 'ana', name: 'Electric bill', amountCentavos: 350000, kind: 'non_cash' })
  await expect(db.addExpense({ branchId: B, shiftId: shift.id, staffId: 'ana', name: ' ', amountCentavos: 100, kind: 'cash' })).rejects.toThrow(/what/)
  await expect(db.addExpense({ branchId: B, shiftId: shift.id, staffId: 'ana', name: 'x', amountCentavos: 0, kind: 'cash' })).rejects.toThrow(/amount/)
  const s = await db.shiftSummary(shift)
  expect(s.expectedCashCentavos).toBe(95000)
  expect(s.nonCashExpenseCentavos).toBe(350000)
  expect((await db.ops.toArray()).filter((o) => o.kind === 'expense').length).toBe(2)
})

test('attendance: selfie required unless the camera is unavailable', async () => {
  await expect(db.recordPunch({ staffId: 'ana', branchId: B, kind: 'in' })).rejects.toThrow(/selfie/)
  await db.recordPunch({ staffId: 'ana', branchId: B, kind: 'in', noPhotoReason: 'No camera' })
  const list = await db.punchesBetween(B, 0, Date.now() + 1000)
  expect(list.map((p) => p.kind)).toEqual(['in'])
  expect((await db.ops.toArray()).some((o) => o.kind === 'attendance')).toBe(true)
})

test('void and refund restock, update the shift, and queue for the server', async () => {
  const shift = await db.openShift(B, 'ana', 0)
  const mk = (id: string, qty: number) => db.queueSale({
    id, branch_id: B, shift_id: shift.id, staff_id: 'ana', age_verified: true, manual_receipt_no: null, client_created_at: new Date().toISOString(),
    discounts: [], items: [{ variant_id: 'v-pod-straw', quantity: qty, unit_price: '550.00' }],
    payments: [{ method: 'cash', amount: (550 * qty).toFixed(2) }],
  })
  await mk('s1', 1); await mk('s2', 2)
  const stock = async () => (await db.stock.get('v-pod-straw'))!.quantity
  expect(await stock()).toBe(7)

  await expect(db.adjustSale({ saleId: 's1', kind: 'void', shiftId: shift.id, staffId: 'ana', approvedBy: 'ben', reason: ' ' })).rejects.toThrow(/reason/)
  await db.adjustSale({ saleId: 's1', kind: 'void', shiftId: shift.id, staffId: 'ana', approvedBy: 'ben', reason: 'Wrong item' })
  expect(await stock()).toBe(8)
  await db.adjustSale({ saleId: 's2', kind: 'refund', shiftId: shift.id, staffId: 'ana', approvedBy: 'ben', reason: 'Defective', refundItems: { 'v-pod-straw': 1 }, method: 'cash' })
  expect(await stock()).toBe(9)
  await expect(db.adjustSale({ saleId: 's2', kind: 'refund', shiftId: shift.id, staffId: 'ana', approvedBy: 'ben', reason: 'x', refundItems: { 'v-pod-straw': 2 } })).rejects.toThrow(/more than/)

  const s = await db.shiftSummary(shift)
  expect([s.saleCount, s.voidCount, s.refundCentavos, s.expectedCashCentavos]).toEqual([1, 1, 55000, 55000])
  expect((await db.ops.toArray()).filter((o) => o.kind === 'void' || o.kind === 'refund').length).toBe(2)
})
