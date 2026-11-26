// The back office's live data: every branch (or one), read from the server with the
// owner/manager's own login. Row-level security decides which branches they can see.

import type { SupabaseClient } from '@supabase/supabase-js'
import { variantLabel } from '../data/localDb'
import type { Adjustment } from '../domain/adjust'
import type { SalePayload } from '../domain/cart'
import type { BackOfficeSource, PunchRow } from './source'

const iso = (ms: number) => new Date(ms).toISOString()
const dec = (x: number | string | null) => (x == null ? undefined : Number(x).toFixed(2))
const cents = (x: number | string) => Math.round(Number(x) * 100)

async function all<T>(q: () => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q()
  if (error) throw new Error(error.message)
  return data as T[]
}

interface SSale {
  id: string; branch_id: string; shift_id: string | null; staff_id: string; status: string
  manual_receipt_no: string | null; age_verified: boolean; client_created_at: string | null; created_at: string; total: number
  sale_items: { variant_id: string; quantity: number; unit_price: number; serial_no: string | null }[]
  sale_discounts: { kind: string; value: number; amount: number; id_holder: string | null; id_number: string | null }[]
  payments: { method: 'cash' | 'gcash' | 'maya'; amount: number; tendered: number | null; reference_no: string | null }[]
}

export function serverSource(c: SupabaseClient, branchId: string | null): BackOfficeSource {
  // Sales are read once per period and shared by sales() and adjustments() (voids come from sales).
  let cache: { key: string; rows: Promise<SSale[]> } | undefined
  const salesIn = (from: number, to: number) => {
    const key = `${from}-${to}`
    if (cache?.key !== key) {
      cache = { key, rows: all<SSale>(() => {
        let q = c.from('sales').select('id,branch_id,shift_id,staff_id,status,manual_receipt_no,age_verified,client_created_at,created_at,total,' +
          'sale_items(variant_id,quantity,unit_price,serial_no),sale_discounts(kind,value,amount,id_holder,id_number),payments(method,amount,tendered,reference_no)')
          .gte('client_created_at', iso(from)).lte('client_created_at', iso(to)).order('client_created_at', { ascending: false }).limit(5000)
        if (branchId) q = q.eq('branch_id', branchId)
        return q
      }) }
    }
    return cache.rows
  }
  const scoped = <Q extends { eq: (k: string, v: string) => Q }>(q: Q) => (branchId ? q.eq('branch_id', branchId) : q)

  return {
    kind: 'server',
    async sales(from, to) {
      return (await salesIn(from, to)).filter((s) => s.status !== 'held').map((s): SalePayload => ({
        id: s.id, branch_id: s.branch_id, shift_id: s.shift_id ?? '', staff_id: s.staff_id, age_verified: s.age_verified,
        manual_receipt_no: s.manual_receipt_no, client_created_at: s.client_created_at ?? s.created_at,
        items: s.sale_items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity, unit_price: dec(i.unit_price)!, ...(i.serial_no ? { serial_no: i.serial_no } : {}) })),
        discounts: s.sale_discounts.map((d) => ({ kind: d.kind as never, value: Number(d.value), amount: dec(d.amount)!,
          ...(d.id_holder ? { id_holder: d.id_holder } : {}), ...(d.id_number ? { id_number: d.id_number } : {}) })),
        payments: s.payments.map((p) => ({ method: p.method, amount: dec(p.amount)!,
          ...(p.tendered != null ? { tendered: dec(p.tendered) } : {}), ...(p.reference_no ? { reference_no: p.reference_no } : {}) })),
      }) as SalePayload)
    },
    async expenses(from, to) {
      const rows = await all<{ id: string; branch_id: string; shift_id: string | null; staff_id: string; name: string; amount: number; kind: 'cash' | 'non_cash'; created_at: string }>(
        () => scoped(c.from('expenses').select('*').gte('created_at', iso(from)).lte('created_at', iso(to)).order('created_at', { ascending: false })))
      return rows.map((x) => ({ id: x.id, branchId: x.branch_id, shiftId: x.shift_id ?? undefined, staffId: x.staff_id, name: x.name,
        amountCentavos: cents(x.amount), kind: x.kind, createdAt: Date.parse(x.created_at) }))
    },
    async punches(from, to) {
      const rows = await all<{ id: string; staff_id: string; branch_id: string; kind: 'in' | 'out'; at: string; photo_path: string | null; no_photo_reason: string | null }>(
        () => scoped(c.from('attendance').select('*').gte('at', iso(from)).lte('at', iso(to)).order('at', { ascending: false })))
      const paths = rows.flatMap((r) => (r.photo_path ? [r.photo_path] : []))
      const urls = new Map<string, string>()
      if (paths.length) {
        const { data } = await c.storage.from('attendance').createSignedUrls(paths, 3600)
        for (const u of data ?? []) if (u.path && u.signedUrl) urls.set(u.path, u.signedUrl)
      }
      return rows.map((r): PunchRow => ({ id: r.id, staffId: r.staff_id, branchId: r.branch_id, kind: r.kind, at: Date.parse(r.at),
        photoUrl: r.photo_path ? urls.get(r.photo_path) : undefined, noPhotoReason: r.no_photo_reason ?? undefined }))
    },
    async adjustments(from, to) {
      const voids = (await salesIn(from, to)).filter((s) => s.status === 'voided').map((s): Adjustment => ({
        id: `void-${s.id}`, saleId: s.id, shiftId: s.shift_id ?? '', branchId: s.branch_id, kind: 'void',
        items: s.sale_items.map((i) => ({ variantId: i.variant_id, quantity: i.quantity, amountCentavos: cents(i.unit_price) * i.quantity })),
        amountCentavos: cents(s.total), method: s.payments[0]?.method ?? 'cash', reason: '', approvedBy: '', staffId: s.staff_id,
        createdAt: Date.parse(s.client_created_at ?? s.created_at),
      }))
      const refunds = await all<{ id: string; sale_id: string; shift_id: string | null; branch_id: string; staff_id: string; approved_by: string; reason: string; method: 'cash' | 'gcash' | 'maya'; amount: number; created_at: string; refund_items: { variant_id: string; quantity: number; amount: number }[] }>(
        () => scoped(c.from('refunds').select('*,refund_items(variant_id,quantity,amount)').gte('created_at', iso(from)).lte('created_at', iso(to))))
      return [...voids, ...refunds.map((r): Adjustment => ({
        id: r.id, saleId: r.sale_id, shiftId: r.shift_id ?? '', branchId: r.branch_id, kind: 'refund',
        items: r.refund_items.map((i) => ({ variantId: i.variant_id, quantity: i.quantity, amountCentavos: cents(i.amount) })),
        amountCentavos: cents(r.amount), method: r.method, reason: r.reason, approvedBy: r.approved_by, staffId: r.staff_id, createdAt: Date.parse(r.created_at),
      }))]
    },
    async staff() {
      const rows = await all<{ id: string; full_name: string; role: string }>(() => c.from('staff').select('id,full_name,role'))
      return rows.map((s) => ({ id: s.id, fullName: s.full_name, role: s.role }))
    },
    async variants() {
      const rows = await all<{ id: string; flavor: string | null; nicotine_mg: number | null; size_ml: number | null; color: string | null; cost: number; products: { name: string } | null }>(
        () => c.from('variants').select('id,flavor,nicotine_mg,size_ml,color,cost,products(name)'))
      return new Map(rows.map((v) => [v.id, {
        name: v.products?.name ?? 'Item', costCentavos: cents(v.cost),
        label: variantLabel({ flavor: v.flavor ?? undefined, nicotineMg: v.nicotine_mg ?? undefined, sizeMl: v.size_ml ?? undefined, color: v.color ?? undefined } as never),
      }]))
    },
  }
}
