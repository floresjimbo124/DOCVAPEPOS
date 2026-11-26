// Sync between this device and the server.
//   push: sends waiting sales and shift events, oldest first. Every item carries the id made on
//         the device, so re-sending after a dropped connection is stored once on the server.
//   pull: refreshes the catalogue, this branch's stock and the staff who can log in here.
// Selling never waits for sync: the register only reads the local database.

import type { Category, DeviceSettings, LocalDb, Product, Role, StaffRow, Variant } from './localDb'

/** The server calls sync needs (the real one wraps Supabase; tests use a fake). */
export interface Remote {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>
  upload(bucket: string, path: string, file: Blob): Promise<void>
  select<T>(table: string, columns: string, filter?: Record<string, string>): Promise<T[]>
}

/** No connection / server unreachable: stop and try again later. */
export class OfflineError extends Error {}

export interface SyncStatus { at: number; sent: number; failing: number; error?: string }

// Which server function each kind of shift event goes to.
const OP_RPC = {
  shift_open: 'open_shift', cash_movement: 'add_cash_movement', shift_close: 'close_shift', expense: 'add_expense',
  attendance: 'record_attendance', void: 'record_void', refund: 'record_refund',
} as const

/**
 * Sends everything waiting, in the order it happened (shift opened -> sales -> voids -> close).
 * A rejected item (e.g. a duplicate receipt number) is kept with its error and skipped, so it
 * doesn't block the rest. A lost connection stops the round.
 */
export async function pushPending(db: LocalDb, remote: Remote): Promise<{ sent: number; failing: number; error?: string }> {
  type Item = { at: number; send: () => Promise<void>; fail: (msg: string) => Promise<unknown> }
  const sales: Item[] = (await db.unsyncedSales()).map((r) => ({
    at: r.createdAt,
    send: async () => {
      await remote.rpc('complete_sale', { p_sale: r.payload })
      await db.outbox.update(r.saleId, { syncedAt: Date.now(), lastError: undefined })
    },
    fail: (msg) => db.outbox.update(r.saleId, { attempts: r.attempts + 1, lastError: msg }),
  }))
  const ops: Item[] = (await db.ops.toArray()).map((o) => ({
    at: o.createdAt,
    send: async () => {
      await remote.rpc(OP_RPC[o.kind], { p: o.payload })
      if (o.kind === 'attendance') await uploadSelfie(db, remote, o.payload as { id: string; branch_id: string })
      await db.ops.delete(o.id)
    },
    fail: (msg) => db.ops.update(o.id, { attempts: o.attempts + 1, lastError: msg }),
  }))

  let sent = 0, failing = 0, error: string | undefined
  for (const item of [...sales, ...ops].sort((a, b) => a.at - b.at)) {
    try {
      await item.send(); sent++
    } catch (e) {
      if (e instanceof OfflineError) return { sent, failing, error: e.message }
      failing++; error = friendly((e as Error).message)
      await item.fail(error)
    }
  }
  return { sent, failing, error }
}

/** Server messages in words a cashier understands. */
export function friendly(msg: string): string {
  if (msg.includes('sales_receipt_no_per_branch')) return 'Receipt number already used at this branch'
  if (msg.includes('payments_unique_reference')) return 'GCash/Maya reference number already used'
  if (/JWT|not allowed|not a POS device/i.test(msg)) return 'This device is not allowed to send. Set it up again.'
  return msg
}

async function uploadSelfie(db: LocalDb, remote: Remote, p: { id: string; branch_id: string }) {
  const punch = await db.punches.get(p.id)
  if (!punch?.photo) return
  const path = `${p.branch_id}/${p.id}.jpg`
  await remote.upload('attendance', path, punch.photo)
  await remote.rpc('set_attendance_photo', { p_id: p.id, p_path: path })
}

// ---------- Pull ----------
interface SCategory { id: string; name: string; sort_order: number }
interface SProduct { id: string; category_id: string | null; name: string; brand: string | null; is_device: boolean; is_active: boolean }
interface SVariant {
  id: string; product_id: string; flavor: string | null; nicotine_mg: number | null; size_ml: number | null
  color: string | null; price: number | string; cost: number | string; is_active: boolean
}
interface SStock { variant_id: string; quantity: number }
interface SStaff { id: string; full_name: string; role: Role; pin_hash: string }
interface SDevice { branch_id: string; branch_name: string; label: string }

const cents = (x: number | string) => Math.round(Number(x) * 100)
const opt = <T,>(x: T | null) => x ?? undefined

/**
 * Replaces the local catalogue, stock and staff with the server's. Local stock = server stock
 * minus sales not yet sent, plus voids/refunds not yet sent (the server hasn't counted those yet).
 * Returns the device's current branch details (null if the device was switched off).
 */
export async function pullAll(db: LocalDb, remote: Remote): Promise<SDevice | null> {
  const [device] = await remote.rpc<SDevice[]>('device_info', {})
  if (!device) return null
  const [cats, prods, vars, stock, staff] = await Promise.all([
    remote.select<SCategory>('categories', 'id,name,sort_order'),
    remote.select<SProduct>('products', 'id,category_id,name,brand,is_device,is_active'),
    remote.select<SVariant>('variants', 'id,product_id,flavor,nicotine_mg,size_ml,color,price,cost,is_active'),
    remote.select<SStock>('stock', 'variant_id,quantity', { branch_id: device.branch_id }),
    remote.rpc<SStaff[]>('device_staff', {}),
  ])

  const categories: Category[] = cats.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sort_order }))
  const products: Product[] = prods.map((p) => ({
    id: p.id, categoryId: p.category_id, name: p.name, brand: opt(p.brand), isDevice: p.is_device, isActive: p.is_active,
  }))
  const variants: Variant[] = vars.map((v) => ({
    id: v.id, productId: v.product_id, flavor: opt(v.flavor), nicotineMg: opt(v.nicotine_mg), sizeMl: opt(v.size_ml),
    color: opt(v.color), priceCentavos: cents(v.price), costCentavos: cents(v.cost), isActive: v.is_active,
  }))
  const staffRows: StaffRow[] = staff.map((s) => ({ id: s.id, fullName: s.full_name, role: s.role, pinHash: s.pin_hash, isActive: true }))

  await db.transaction('rw', [db.categories, db.products, db.variants, db.stock, db.staff, db.favorites, db.outbox, db.ops, db.settings], async () => {
    // Read what is still waiting inside the transaction, so a sale made meanwhile is counted.
    const qty = new Map(stock.map((s) => [s.variant_id, s.quantity]))
    const adjust = (id: string, d: number) => qty.set(id, (qty.get(id) ?? 0) + d)
    for (const r of await db.outbox.filter((r) => !r.syncedAt).toArray()) for (const i of r.payload.items) adjust(i.variant_id, -i.quantity)
    for (const o of await db.ops.toArray()) {
      if (o.kind !== 'void' && o.kind !== 'refund') continue
      for (const i of (o.payload as { items: { variant_id: string; quantity: number }[] }).items) adjust(i.variant_id, i.quantity)
    }
    await Promise.all([db.categories.clear(), db.products.clear(), db.variants.clear(), db.stock.clear(), db.staff.clear()])
    await db.categories.bulkAdd(categories)
    await db.products.bulkAdd(products)
    await db.variants.bulkAdd(variants)
    await db.stock.bulkAdd([...qty].map(([variantId, quantity]) => ({ variantId, quantity })))
    await db.staff.bulkAdd(staffRows)
    const ids = new Set(variants.map((v) => v.id))
    await db.favorites.filter((f) => !ids.has(f.variantId)).delete()
    const cur = await db.getSetting<DeviceSettings>('device')
    await db.setSetting('device', { ...cur, branchId: device.branch_id, branchName: device.branch_name, label: device.label, live: true })
  })
  return device
}

/** One full round: send what's waiting, then refresh. Records the outcome for the top bar. */
export async function syncOnce(db: LocalDb, remote: Remote): Promise<SyncStatus> {
  let status: SyncStatus
  try {
    const push = await pushPending(db, remote)
    const device = await pullAll(db, remote)
    status = { at: Date.now(), sent: push.sent, failing: push.failing,
      error: device ? push.error : 'This device was switched off in the back office' }
  } catch (e) {
    status = { at: Date.now(), sent: 0, failing: 0, error: (e as Error).message }
  }
  await db.setSetting('syncStatus', status)
  return status
}
