// Back-office report math over sales and expenses. Pure functions, easy to test.

import type { Adjustment } from './adjust'
import type { PayMethod, SalePayload } from './cart'
import type { Expense } from './shift'

const toC = (s: string | number) => Math.round(Number(s) * 100)

export interface Kpis {
  netSalesCentavos: number
  discountCentavos: number
  transactions: number
  itemsSold: number
  cogsCentavos: number
  grossProfitCentavos: number // net sales − cost of goods
  expenseCentavos: number
  netProfitCentavos: number // gross profit − expenses
  averageSaleCentavos: number
  refundCentavos: number
  voidCount: number
}

/** Sales that weren't voided. */
export const liveSales = (sales: SalePayload[], adj: Adjustment[]) => {
  const voided = new Set(adj.filter((a) => a.kind === 'void').map((a) => a.saleId))
  return sales.filter((s) => !voided.has(s.id))
}

/** costOf(variantId) returns the unit cost in centavos (0 if unknown). */
export function kpis(allSales: SalePayload[], expenses: Expense[], costOf: (variantId: string) => number, adj: Adjustment[] = []): Kpis {
  const sales = liveSales(allSales, adj)
  const refunds = adj.filter((a) => a.kind === 'refund')
  let gross = 0, discount = 0, items = 0, cogs = 0
  for (const s of sales) {
    for (const i of s.items) {
      gross += toC(i.unit_price) * i.quantity
      items += i.quantity
      cogs += costOf(i.variant_id) * i.quantity
    }
    for (const d of s.discounts) discount += toC(d.amount)
  }
  for (const r of refunds) for (const i of r.items) { items -= i.quantity; cogs -= costOf(i.variantId) * i.quantity }
  const refund = refunds.reduce((a, r) => a + r.amountCentavos, 0)
  const net = gross - discount - refund
  const exp = expenses.reduce((a, e) => a + e.amountCentavos, 0)
  return {
    netSalesCentavos: net,
    discountCentavos: discount,
    transactions: sales.length,
    itemsSold: items,
    cogsCentavos: cogs,
    grossProfitCentavos: net - cogs,
    expenseCentavos: exp,
    netProfitCentavos: net - cogs - exp,
    averageSaleCentavos: sales.length ? Math.round(net / sales.length) : 0,
    refundCentavos: refund,
    voidCount: allSales.length - sales.length,
  }
}

export function byPaymentMethod(sales: SalePayload[], adj: Adjustment[] = []): Record<PayMethod, number> {
  const r: Record<PayMethod, number> = { cash: 0, gcash: 0, maya: 0 }
  for (const s of liveSales(sales, adj)) for (const p of s.payments) r[p.method] += toC(p.amount)
  for (const a of adj) if (a.kind === 'refund') r[a.method] -= a.amountCentavos
  return r
}

/** Net sales per hour of day (0–23), using the sale's device time. Refunds count in the hour they happened. */
export function byHour(allSales: SalePayload[], adj: Adjustment[] = []): number[] {
  const hours = Array<number>(24).fill(0)
  for (const a of adj) if (a.kind === 'refund') hours[new Date(a.createdAt).getHours()] -= a.amountCentavos
  for (const s of liveSales(allSales, adj)) {
    const h = new Date(s.client_created_at).getHours()
    const net = s.items.reduce((a, i) => a + toC(i.unit_price) * i.quantity, 0) - s.discounts.reduce((a, d) => a + toC(d.amount), 0)
    if (!Number.isNaN(h)) hours[h] += net
  }
  return hours
}

export interface ItemRow { variantId: string; quantity: number; salesCentavos: number; profitCentavos: number }

/** Best sellers by revenue (before order-level discounts), net of voids and refunds. */
export function topItems(allSales: SalePayload[], costOf: (variantId: string) => number, limit = 10, adj: Adjustment[] = []): ItemRow[] {
  const m = new Map<string, ItemRow>()
  for (const a of adj) if (a.kind === 'refund') for (const i of a.items) {
    const r = m.get(i.variantId) ?? { variantId: i.variantId, quantity: 0, salesCentavos: 0, profitCentavos: 0 }
    r.quantity -= i.quantity
    r.salesCentavos -= i.amountCentavos
    r.profitCentavos -= i.amountCentavos - costOf(i.variantId) * i.quantity
    m.set(i.variantId, r)
  }
  for (const s of liveSales(allSales, adj)) for (const i of s.items) {
    const r = m.get(i.variant_id) ?? { variantId: i.variant_id, quantity: 0, salesCentavos: 0, profitCentavos: 0 }
    const line = toC(i.unit_price) * i.quantity
    r.quantity += i.quantity
    r.salesCentavos += line
    r.profitCentavos += line - costOf(i.variant_id) * i.quantity
    m.set(i.variant_id, r)
  }
  return [...m.values()].filter((r) => r.quantity > 0).sort((a, b) => b.salesCentavos - a.salesCentavos).slice(0, limit)
}

export const saleTotal = (s: SalePayload) => s.payments.reduce((a, p) => a + toC(p.amount), 0)

// ---------- Date ranges ----------
export type Period = 'today' | 'week' | 'month'
export function periodRange(p: Period, now = new Date()): [number, number] {
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  if (p === 'week') start.setDate(start.getDate() - 6)
  if (p === 'month') start.setDate(1)
  return [start.getTime(), now.getTime() + 60_000]
}
