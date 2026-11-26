import { expect, test } from 'vitest'
import type { SalePayload } from './cart'
import { overShort, summarizeShift, type CashMovement, type Expense } from './shift'

const sale = (over: Partial<SalePayload>): SalePayload => ({
  id: crypto.randomUUID(), branch_id: 'b', shift_id: 's', staff_id: 'u', age_verified: true, manual_receipt_no: null,
  client_created_at: '', items: [], discounts: [], payments: [], ...over,
})
const move = (amountCentavos: number): CashMovement =>
  ({ id: crypto.randomUUID(), shiftId: 's', amountCentavos, reason: 'x', staffId: 'u', createdAt: 0 })

test('expected cash = starting + cash sales + cash in − cash out', () => {
  const sales = [
    sale({ items: [{ variant_id: 'a', quantity: 2, unit_price: '350.00' }], payments: [{ method: 'cash', amount: '700.00' }], manual_receipt_no: '0010' }),
    sale({ items: [{ variant_id: 'b', quantity: 1, unit_price: '550.00' }], payments: [{ method: 'gcash', amount: '550.00', reference_no: 'R1' }], manual_receipt_no: '0009' }),
    sale({
      items: [{ variant_id: 'a', quantity: 1, unit_price: '350.00' }],
      discounts: [{ kind: 'senior', value: 20, amount: '100.00', id_holder: 'L', id_number: '1' }],
      payments: [{ method: 'cash', amount: '100.00' }, { method: 'maya', amount: '150.00', reference_no: 'M1' }],
      manual_receipt_no: '0011',
    }),
  ]
  const s = summarizeShift(100000, sales, [move(50000), move(-20000)])
  expect(s.saleCount).toBe(3)
  expect(s.grossCentavos).toBe(160000)
  expect(s.discountCentavos).toBe(10000)
  expect(s.netCentavos).toBe(150000)
  expect(s.byMethod).toEqual({ cash: 80000, gcash: 55000, maya: 15000 })
  expect(s.expectedCashCentavos).toBe(100000 + 80000 + 50000 - 20000)
  expect(s.seniorPwdCount).toBe(1)
  expect([s.firstReceiptNo, s.lastReceiptNo]).toEqual(['0009', '0011'])
  expect(overShort(s, 210000)).toBe(0)
  expect(overShort(s, 209500)).toBe(-500)
})

test('empty shift expects only the starting cash', () => {
  const s = summarizeShift(100000, [], [])
  expect(s.expectedCashCentavos).toBe(100000)
  expect(s.firstReceiptNo).toBeUndefined()
})

test('cash expenses come out of the drawer; non-cash ones do not', () => {
  const exp = (kind: Expense['kind'], amountCentavos: number): Expense =>
    ({ id: crypto.randomUUID(), branchId: 'b', shiftId: 's', name: 'x', amountCentavos, kind, staffId: 'u', createdAt: 0 })
  const s = summarizeShift(100000, [], [], [exp('cash', 15000), exp('non_cash', 500000)])
  expect(s.cashExpenseCentavos).toBe(15000)
  expect(s.nonCashExpenseCentavos).toBe(500000)
  expect(s.expectedCashCentavos).toBe(85000)
})

test('voided sales drop out; refunds reduce net and the refund method', () => {
  const s1 = sale({ items: [{ variant_id: 'a', quantity: 1, unit_price: '500.00' }], payments: [{ method: 'cash', amount: '500.00' }] })
  const s2 = sale({ items: [{ variant_id: 'b', quantity: 2, unit_price: '300.00' }], payments: [{ method: 'cash', amount: '600.00' }] })
  const base = { shiftId: 's', branchId: 'b', method: 'cash' as const, reason: 'x', approvedBy: 'm', staffId: 'u', createdAt: 0 }
  const s = summarizeShift(0, [s1, s2], [], [], [
    { ...base, id: 'v', saleId: s1.id, kind: 'void', items: [], amountCentavos: 50000 },
    { ...base, id: 'r', saleId: s2.id, kind: 'refund', items: [{ variantId: 'b', quantity: 1, amountCentavos: 30000 }], amountCentavos: 30000 },
  ])
  expect(s.saleCount).toBe(1)
  expect(s.voidCount).toBe(1)
  expect(s.refundCentavos).toBe(30000)
  expect(s.netCentavos).toBe(30000)
  expect(s.expectedCashCentavos).toBe(30000)
})
