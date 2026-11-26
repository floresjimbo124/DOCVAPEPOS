// On-device database (IndexedDB via Dexie). The register reads only from here,
// so selling works with no internet. Sales wait in the outbox until synced.

import Dexie, { type EntityTable } from 'dexie'
import type { SalePayload } from '../domain/cart'
import type { Punch } from '../domain/attendance'
import { summarizeShift, type CashMovement, type Expense, type ShiftSummary } from '../domain/shift'

export interface Category { id: string; name: string; sortOrder: number }
export interface Product { id: string; categoryId: string | null; name: string; brand?: string; isDevice: boolean; isActive: boolean }
export interface Variant {
  id: string; productId: string; flavor?: string; nicotineMg?: number; sizeMl?: number; color?: string
  priceCentavos: number; costCentavos?: number; isActive: boolean
}
/** Stock at THIS device's branch (refreshed on sync, decremented locally on sale). */
export interface StockRow { variantId: string; quantity: number }
export interface Favorite { variantId: string; sortOrder: number }
export interface OutboxRow { saleId: string; shiftId: string; payload: SalePayload; createdAt: number; attempts: number; lastError?: string }

export type Role = 'owner' | 'manager' | 'cashier'
/** Staff allowed at this branch, cached for offline PIN login (PIN stored only as a bcrypt hash). */
export interface StaffRow { id: string; fullName: string; role: Role; pinHash: string; isActive: boolean }
export interface DeviceSettings { branchId: string; branchName: string; label: string }
export interface ShiftRow {
  id: string; branchId: string; openedBy: string; openedAt: number; startingCentavos: number
  closedAt?: number; closedBy?: string; countedCentavos?: number; expectedCentavos?: number; zNo?: number
}
/** Shift events waiting to be sent to the server (sales use the outbox). */
export interface OpRow { id: string; kind: 'shift_open' | 'cash_movement' | 'shift_close' | 'expense' | 'attendance'; payload: unknown; createdAt: number; attempts: number; lastError?: string }
export interface SettingRow { key: string; value: unknown }

export interface VariantRow { variant: Variant; product: Product; stock: number; label: string }

export class LocalDb extends Dexie {
  categories!: EntityTable<Category, 'id'>
  products!: EntityTable<Product, 'id'>
  variants!: EntityTable<Variant, 'id'>
  stock!: EntityTable<StockRow, 'variantId'>
  favorites!: EntityTable<Favorite, 'variantId'>
  outbox!: EntityTable<OutboxRow, 'saleId'>
  staff!: EntityTable<StaffRow, 'id'>
  shifts!: EntityTable<ShiftRow, 'id'>
  cashMoves!: EntityTable<CashMovement, 'id'>
  ops!: EntityTable<OpRow, 'id'>
  settings!: EntityTable<SettingRow, 'key'>
  expenses!: EntityTable<Expense, 'id'>
  punches!: EntityTable<Punch, 'id'>

  constructor(name = 'docvape_pos') {
    super(name)
    this.version(1).stores({
      categories: 'id, sortOrder',
      products: 'id, categoryId, name',
      variants: 'id, productId',
      stock: 'variantId',
      favorites: 'variantId, sortOrder',
      outbox: 'saleId, createdAt',
    })
    this.version(2).stores({
      outbox: 'saleId, createdAt, shiftId',
      staff: 'id',
      shifts: 'id, branchId, openedAt',
      cashMoves: 'id, shiftId',
      ops: 'id, createdAt',
      settings: 'key',
    }).upgrade((tx) => tx.table('outbox').toCollection().modify((r: OutboxRow) => { r.shiftId = r.payload.shift_id }))
    this.version(3).stores({
      expenses: 'id, shiftId, branchId, createdAt',
      punches: 'id, staffId, branchId, at',
    })
  }

  // ---------- Device, staff, shifts ----------
  async getSetting<T>(key: string): Promise<T | undefined> { return (await this.settings.get(key))?.value as T | undefined }
  setSetting(key: string, value: unknown) { return this.settings.put({ key, value }) }

  async openShiftFor(branchId: string): Promise<ShiftRow | undefined> {
    return (await this.shifts.where('branchId').equals(branchId).toArray()).find((s) => s.closedAt == null)
  }

  private queueOp(kind: OpRow['kind'], payload: unknown) {
    return this.ops.add({ id: crypto.randomUUID(), kind, payload, createdAt: Date.now(), attempts: 0 })
  }

  openShift(branchId: string, staffId: string, startingCentavos: number): Promise<ShiftRow> {
    return this.transaction('rw', this.shifts, this.ops, async () => {
      if (await this.openShiftFor(branchId)) throw new Error('A shift is already open at this branch')
      const shift: ShiftRow = { id: crypto.randomUUID(), branchId, openedBy: staffId, openedAt: Date.now(), startingCentavos }
      await this.shifts.add(shift)
      await this.queueOp('shift_open', { id: shift.id, branch_id: branchId, opened_by: staffId,
        starting_cash: (startingCentavos / 100).toFixed(2), opened_at: new Date(shift.openedAt).toISOString() })
      return shift
    })
  }

  async addCashMove(shiftId: string, staffId: string, amountCentavos: number, reason: string) {
    if (!reason.trim()) throw new Error('Reason is required')
    if (!amountCentavos) throw new Error('Enter an amount')
    return this.transaction('rw', this.cashMoves, this.ops, async () => {
      const m: CashMovement = { id: crypto.randomUUID(), shiftId, amountCentavos, reason: reason.trim(), staffId, createdAt: Date.now() }
      await this.cashMoves.add(m)
      await this.queueOp('cash_movement', { id: m.id, shift_id: shiftId, staff_id: staffId,
        amount: (amountCentavos / 100).toFixed(2), reason: m.reason, created_at: new Date(m.createdAt).toISOString() })
    })
  }

  async shiftSummary(shift: ShiftRow): Promise<ShiftSummary> {
    const sales = (await this.outbox.where('shiftId').equals(shift.id).toArray()).map((r) => r.payload)
    const moves = await this.cashMoves.where('shiftId').equals(shift.id).toArray()
    const expenses = await this.expenses.where('shiftId').equals(shift.id).toArray()
    return summarizeShift(shift.startingCentavos, sales, moves, expenses)
  }

  /** Cash expenses are paid from the drawer of the open shift; non-cash ones are just recorded. */
  async addExpense(e: { branchId: string; shiftId?: string; staffId: string; name: string; amountCentavos: number; kind: Expense['kind'] }) {
    if (!e.name.trim()) throw new Error('Enter what the expense is for')
    if (!(e.amountCentavos > 0)) throw new Error('Enter an amount')
    if (e.kind === 'cash' && !e.shiftId) throw new Error('Open a shift to pay a cash expense from the drawer')
    return this.transaction('rw', this.expenses, this.ops, async () => {
      const x: Expense = { ...e, id: crypto.randomUUID(), name: e.name.trim(), createdAt: Date.now() }
      await this.expenses.add(x)
      await this.queueOp('expense', { id: x.id, branch_id: x.branchId, shift_id: x.shiftId ?? null, staff_id: x.staffId,
        name: x.name, amount: (x.amountCentavos / 100).toFixed(2), kind: x.kind, created_at: new Date(x.createdAt).toISOString() })
      return x
    })
  }

  /** Records a clock-in/out. The selfie stays on the device until it is uploaded by sync. */
  async recordPunch(p: Omit<Punch, 'id' | 'at'>) {
    if (!p.photo && !p.noPhotoReason) throw new Error('Take a selfie to clock in or out')
    return this.transaction('rw', this.punches, this.ops, async () => {
      const x: Punch = { ...p, id: crypto.randomUUID(), at: Date.now() }
      await this.punches.add(x)
      await this.queueOp('attendance', { id: x.id, staff_id: x.staffId, branch_id: x.branchId, kind: x.kind,
        at: new Date(x.at).toISOString(), has_photo: !!x.photo, no_photo_reason: x.noPhotoReason ?? null })
      return x
    })
  }

  punchesBetween = (branchId: string, from: number, to: number) =>
    this.punches.where('at').between(from, to, true, true).filter((p) => p.branchId === branchId).toArray()

  /** Closes the shift with the counted cash; assigns the next Z-reading number for this device. */
  closeShift(shiftId: string, staffId: string, countedCentavos: number): Promise<{ shift: ShiftRow; summary: ShiftSummary }> {
    return this.transaction('rw', [this.shifts, this.outbox, this.cashMoves, this.expenses, this.ops, this.settings], async () => {
      const shift = await this.shifts.get(shiftId)
      if (!shift || shift.closedAt != null) throw new Error('Shift is not open')
      const summary = await this.shiftSummary(shift)
      const zNo = ((await this.getSetting<number>('zCounter')) ?? 0) + 1
      await this.setSetting('zCounter', zNo)
      const closed: ShiftRow = { ...shift, closedAt: Date.now(), closedBy: staffId, countedCentavos,
        expectedCentavos: summary.expectedCashCentavos, zNo }
      await this.shifts.put(closed)
      await this.queueOp('shift_close', { id: shiftId, closed_by: staffId, counted_cash: (countedCentavos / 100).toFixed(2),
        expected_cash: (summary.expectedCashCentavos / 100).toFixed(2), z_reading_no: zNo, closed_at: new Date(closed.closedAt!).toISOString() })
      return { shift: closed, summary }
    })
  }

  pendingCount = async () => (await this.outbox.count()) + (await this.ops.count())

  private async rows(variants: Variant[]): Promise<VariantRow[]> {
    const active = variants.filter((v) => v.isActive)
    const products = new Map((await this.products.bulkGet([...new Set(active.map((v) => v.productId))]))
      .filter((p): p is Product => !!p?.isActive).map((p) => [p.id, p]))
    const stock = await this.stock.bulkGet(active.map((v) => v.id))
    return active.flatMap((v, i) => {
      const product = products.get(v.productId)
      return product ? [{ variant: v, product, stock: stock[i]?.quantity ?? 0, label: variantLabel(v) }] : []
    }).sort((a, b) => a.product.name.localeCompare(b.product.name) || a.label.localeCompare(b.label))
  }

  categoriesSorted = () => this.categories.orderBy('sortOrder').toArray()

  productsIn = async (categoryId: string) =>
    (await this.products.where('categoryId').equals(categoryId).sortBy('name')).filter((p) => p.isActive)

  variantsOf = async (productId: string) => this.rows(await this.variants.where('productId').equals(productId).toArray())

  /** Search as you type: name, brand, flavor, color, mg or ml (e.g. "mango 50"). Every word must match. */
  async search(text: string): Promise<VariantRow[]> {
    const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    const all = await this.rows(await this.variants.toArray())
    return all.filter((r) => {
      const hay = [r.product.name, r.product.brand, r.label].join(' ').toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }

  async favoriteRows(): Promise<VariantRow[]> {
    const favs = await this.favorites.orderBy('sortOrder').toArray()
    const ids = favs.map((f) => f.variantId)
    const rows = await this.rows((await this.variants.bulkGet(ids)).filter((v): v is Variant => !!v))
    return rows.sort((a, b) => ids.indexOf(a.variant.id) - ids.indexOf(b.variant.id))
  }

  /** Saves the sale to the outbox and deducts local stock in one transaction. */
  queueSale(payload: SalePayload) {
    return this.transaction('rw', this.outbox, this.stock, async () => {
      await this.outbox.add({ saleId: payload.id, shiftId: payload.shift_id, payload, createdAt: Date.now(), attempts: 0 })
      for (const item of payload.items) {
        const cur = await this.stock.get(item.variant_id)
        await this.stock.put({ variantId: item.variant_id, quantity: (cur?.quantity ?? 0) - item.quantity })
      }
    })
  }
}

export function variantLabel(v: Variant): string {
  return [
    v.flavor,
    v.nicotineMg != null ? `${v.nicotineMg}mg` : undefined,
    v.sizeMl != null ? `${v.sizeMl}ml` : undefined,
    v.color,
  ].filter(Boolean).join(' · ')
}

export const db = new LocalDb()
