// Where the back office gets its data. "Preview" reads this device's own records;
// the server version (all branches) plugs in here once Supabase sync is connected.

import { db, variantLabel } from '../data/localDb'
import type { Adjustment } from '../domain/adjust'
import type { Punch } from '../domain/attendance'
import type { SalePayload } from '../domain/cart'
import type { Expense } from '../domain/shift'

export interface VariantInfo { name: string; label: string; costCentavos: number }
export interface StaffInfo { id: string; fullName: string; role: string }

export interface BackOfficeSource {
  kind: 'preview' | 'server'
  sales(from: number, to: number): Promise<SalePayload[]>
  expenses(from: number, to: number): Promise<Expense[]>
  punches(from: number, to: number): Promise<Punch[]>
  adjustments(from: number, to: number): Promise<Adjustment[]>
  staff(): Promise<StaffInfo[]>
  variants(): Promise<Map<string, VariantInfo>>
}

const inRange = (iso: string, from: number, to: number) => { const t = Date.parse(iso); return t >= from && t <= to }

export const previewSource: BackOfficeSource = {
  kind: 'preview',
  async sales(from, to) {
    return (await db.outbox.toArray()).map((r) => r.payload).filter((s) => inRange(s.client_created_at, from, to))
      .sort((a, b) => b.client_created_at.localeCompare(a.client_created_at))
  },
  async expenses(from, to) {
    return (await db.expenses.where('createdAt').between(from, to, true, true).toArray()).sort((a, b) => b.createdAt - a.createdAt)
  },
  async punches(from, to) {
    return (await db.punches.where('at').between(from, to, true, true).toArray()).sort((a, b) => b.at - a.at)
  },
  async adjustments(from, to) {
    return db.adjustments.where('createdAt').between(from, to, true, true).toArray()
  },
  async staff() {
    return (await db.staff.toArray()).map(({ id, fullName, role }) => ({ id, fullName, role }))
  },
  async variants() {
    const [vs, ps] = await Promise.all([db.variants.toArray(), db.products.toArray()])
    const pm = new Map(ps.map((p) => [p.id, p.name]))
    return new Map(vs.map((v) => [v.id, { name: pm.get(v.productId) ?? 'Item', label: variantLabel(v), costCentavos: v.costCentavos ?? 0 }]))
  },
}
