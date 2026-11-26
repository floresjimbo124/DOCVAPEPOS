import { expect, test } from 'vitest'
import type { SalePayload } from './cart'
import { byHour, byPaymentMethod, kpis, periodRange, topItems } from './reports'
import type { Expense } from './shift'

const sale = (over: Partial<SalePayload>): SalePayload => ({
  id: crypto.randomUUID(), branch_id: 'b', shift_id: 's', staff_id: 'u', age_verified: true, manual_receipt_no: null,
  client_created_at: new Date(2026, 10, 26, 14, 5).toISOString(), items: [], discounts: [], payments: [], ...over,
})
const cost: Record<string, number> = { juice: 20000, pod: 30000 }
const costOf = (id: string) => cost[id] ?? 0
const sales = [
  sale({ items: [{ variant_id: 'juice', quantity: 2, unit_price: '350.00' }], payments: [{ method: 'cash', amount: '700.00' }] }),
  sale({
    client_created_at: new Date(2026, 10, 26, 18, 30).toISOString(),
    items: [{ variant_id: 'pod', quantity: 1, unit_price: '550.00' }],
    discounts: [{ kind: 'fixed', value: 50, amount: '50.00' }],
    payments: [{ method: 'gcash', amount: '500.00', reference_no: 'R' }],
  }),
]
const exp: Expense = { id: 'e', branchId: 'b', name: 'Rent', amountCentavos: 10000, kind: 'non_cash', staffId: 'u', createdAt: 0 }

test('KPIs: net sales, COGS, gross and net profit', () => {
  const k = kpis(sales, [exp], costOf)
  expect(k.netSalesCentavos).toBe(120000)
  expect(k.discountCentavos).toBe(5000)
  expect(k.transactions).toBe(2)
  expect(k.itemsSold).toBe(3)
  expect(k.cogsCentavos).toBe(70000)
  expect(k.grossProfitCentavos).toBe(50000)
  expect(k.netProfitCentavos).toBe(40000)
  expect(k.averageSaleCentavos).toBe(60000)
})

test('payment methods, hours, top items', () => {
  expect(byPaymentMethod(sales)).toEqual({ cash: 70000, gcash: 50000, maya: 0 })
  const h = byHour(sales)
  expect([h[14], h[18]]).toEqual([70000, 50000])
  expect(topItems(sales, costOf).map((r) => [r.variantId, r.quantity, r.profitCentavos])).toEqual([['juice', 2, 30000], ['pod', 1, 25000]])
})

test('period ranges start at local midnight', () => {
  const now = new Date(2026, 10, 26, 15, 0)
  expect(new Date(periodRange('today', now)[0]).getHours()).toBe(0)
  expect(new Date(periodRange('week', now)[0]).getDate()).toBe(20)
  expect(new Date(periodRange('month', now)[0]).getDate()).toBe(1)
})
