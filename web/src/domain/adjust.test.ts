import { expect, test } from 'vitest'
import { buildRefund, buildVoid, saleState, type Adjustment } from './adjust'
import type { SalePayload } from './cart'

const sale: SalePayload = {
  id: 's1', branch_id: 'b', shift_id: 'sh1', staff_id: 'u', age_verified: true, manual_receipt_no: null, client_created_at: '',
  items: [{ variant_id: 'juice', quantity: 2, unit_price: '350.00' }, { variant_id: 'pod', quantity: 1, unit_price: '300.00' }],
  discounts: [{ kind: 'percent', value: 10, amount: '100.00' }], // 1000 -> 900
  payments: [{ method: 'cash', amount: '900.00' }],
}
const adj = (kind: Adjustment['kind'], items: Adjustment['items'], amountCentavos: number): Adjustment =>
  ({ id: crypto.randomUUID(), saleId: 's1', shiftId: 'sh1', branchId: 'b', kind, items, amountCentavos, method: 'cash', reason: 'x', approvedBy: 'm', staffId: 'u', createdAt: 0 })

test('refund is prorated by the order discount', () => {
  const r = buildRefund(sale, { juice: 1 }, [])
  expect(r.amountCentavos).toBe(31500) // 350 × 0.9
})

test('cannot refund more than sold, across several refunds', () => {
  const first = adj('refund', [{ variantId: 'juice', quantity: 2, amountCentavos: 63000 }], 63000)
  expect(() => buildRefund(sale, { juice: 1 }, [first])).toThrow(/more than was sold/)
  const r = buildRefund(sale, { pod: 1 }, [first])
  expect(r.amountCentavos).toBe(27000)
  expect(saleState(sale, [first])).toBe('partly refunded')
  expect(saleState(sale, [first, adj('refund', r.items, r.amountCentavos)])).toBe('refunded')
  expect(() => buildRefund(sale, {}, [])).toThrow(/at least one/)
})

test('void: whole sale, current shift only, once', () => {
  const v = buildVoid(sale, [], 'sh1')
  expect(v.amountCentavos).toBe(90000)
  expect(v.items.map((i) => i.quantity)).toEqual([2, 1])
  expect(() => buildVoid(sale, [], 'other-shift')).toThrow(/current shift/)
  const done = adj('void', v.items, v.amountCentavos)
  expect(() => buildVoid(sale, [done], 'sh1')).toThrow(/already/)
  expect(() => buildRefund(sale, { pod: 1 }, [done])).toThrow(/voided/)
  expect(saleState(sale, [done])).toBe('voided')
})
