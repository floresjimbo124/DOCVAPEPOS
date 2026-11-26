// Voids and refunds. A void cancels a whole sale (same shift only); a refund returns
// some items. Both need a reason and an owner/manager approval, and both restock.

import type { PayMethod, SalePayload } from './cart'

export interface AdjustItem { variantId: string; quantity: number; amountCentavos: number }

export interface Adjustment {
  id: string
  saleId: string
  shiftId: string // shift in which the void/refund happened (cash leaves that drawer)
  branchId: string
  kind: 'void' | 'refund'
  items: AdjustItem[]
  amountCentavos: number
  method: PayMethod // how a refund was paid back (voids reverse the original payments)
  reason: string
  approvedBy: string
  staffId: string
  createdAt: number
}

const toC = (s: string | number) => Math.round(Number(s) * 100)
const saleGross = (s: SalePayload) => s.items.reduce((a, i) => a + toC(i.unit_price) * i.quantity, 0)
export const salePaid = (s: SalePayload) => s.payments.reduce((a, p) => a + toC(p.amount), 0)

/** Quantity of each variant still refundable after earlier refunds. */
export function refundableQty(sale: SalePayload, prior: Adjustment[]): Map<string, number> {
  const left = new Map<string, number>()
  for (const i of sale.items) left.set(i.variant_id, (left.get(i.variant_id) ?? 0) + i.quantity)
  for (const a of prior) if (a.saleId === sale.id && a.kind === 'refund') {
    for (const i of a.items) left.set(i.variantId, (left.get(i.variantId) ?? 0) - i.quantity)
  }
  return left
}

/**
 * Builds refund lines. Each item is refunded at what the customer actually paid for it:
 * its price, reduced proportionally by any order discount.
 */
export function buildRefund(sale: SalePayload, want: Record<string, number>, prior: Adjustment[]): { items: AdjustItem[]; amountCentavos: number } {
  if (prior.some((a) => a.saleId === sale.id && a.kind === 'void')) throw new Error('This sale was voided')
  const left = refundableQty(sale, prior)
  const gross = saleGross(sale)
  const ratio = gross ? salePaid(sale) / gross : 0
  const items: AdjustItem[] = []
  for (const [variantId, quantity] of Object.entries(want)) {
    if (!quantity) continue
    if (quantity < 0 || quantity > (left.get(variantId) ?? 0)) throw new Error('Cannot refund more than was sold')
    const unit = toC(sale.items.find((i) => i.variant_id === variantId)!.unit_price)
    items.push({ variantId, quantity, amountCentavos: Math.round(unit * quantity * ratio) })
  }
  if (!items.length) throw new Error('Choose at least one item to refund')
  const already = prior.filter((a) => a.saleId === sale.id && a.kind === 'refund').reduce((s, a) => s + a.amountCentavos, 0)
  const amountCentavos = Math.min(items.reduce((s, i) => s + i.amountCentavos, 0), salePaid(sale) - already)
  return { items, amountCentavos }
}

export function buildVoid(sale: SalePayload, prior: Adjustment[], currentShiftId: string): { items: AdjustItem[]; amountCentavos: number } {
  if (prior.some((a) => a.saleId === sale.id)) throw new Error('This sale already has a void or refund')
  if (sale.shift_id !== currentShiftId) throw new Error('Only sales from the current shift can be voided. Use a refund instead.')
  return {
    items: sale.items.map((i) => ({ variantId: i.variant_id, quantity: i.quantity, amountCentavos: toC(i.unit_price) * i.quantity })),
    amountCentavos: salePaid(sale),
  }
}

export type SaleState = 'completed' | 'voided' | 'refunded' | 'partly refunded'
export function saleState(sale: SalePayload, adj: Adjustment[]): SaleState {
  const mine = adj.filter((a) => a.saleId === sale.id)
  if (mine.some((a) => a.kind === 'void')) return 'voided'
  if (!mine.length) return 'completed'
  const left = refundableQty(sale, adj)
  return [...left.values()].every((q) => q <= 0) ? 'refunded' : 'partly refunded'
}
