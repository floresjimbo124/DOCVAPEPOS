import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DEMO_BRANCH, seedDemoIfEmpty, seedDemoStaffIfEmpty } from './demoSeed'
import { LocalDb, type DeviceSettings } from './localDb'
import { OfflineError, pullAll, pushPending, syncOnce, type Remote } from './sync'

let db: LocalDb
beforeEach(async () => {
  db = new LocalDb(`test-${crypto.randomUUID()}`)
  await seedDemoIfEmpty(db)
  await seedDemoStaffIfEmpty(db)
})
afterEach(() => db.delete())
const B = DEMO_BRANCH.branchId

/** A pretend server that records calls; `reject` makes chosen calls fail. */
function fakeRemote(opts: { reject?: (fn: string, args: Record<string, unknown>) => Error | undefined; tables?: Record<string, unknown[]>; device?: boolean } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const uploads: string[] = []
  const remote: Remote = {
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      const err = opts.reject?.(fn, args)
      if (err) throw err
      calls.push({ fn, args })
      if (fn === 'device_info') return (opts.device === false ? [] : [{ branch_id: 'srv-branch', branch_name: 'Dapitan Branch', label: 'Tablet 1' }]) as T
      if (fn === 'device_staff') return [{ id: 'st1', full_name: 'Cara', role: 'cashier', pin_hash: '$2a$06$x' }] as T
      return null as T
    },
    async upload(_b, path) { uploads.push(path) },
    async select<T>(table: string) { return (opts.tables?.[table] ?? []) as T[] },
  }
  return { remote, calls, uploads }
}

const sale = (id: string, shiftId: string, receipt: string, variant = 'v-pod-straw', quantity = 1) => ({
  id, branch_id: B, shift_id: shiftId, staff_id: 'ana', age_verified: true, manual_receipt_no: receipt,
  client_created_at: new Date().toISOString(), discounts: [], items: [{ variant_id: variant, quantity, unit_price: '550.00' }],
  payments: [{ method: 'cash' as const, amount: (550 * quantity).toFixed(2) }],
})
const tick = () => new Promise((r) => setTimeout(r, 2)) // distinct createdAt values

test('sends everything in the order it happened, once', async () => {
  const shift = await db.openShift(B, 'ana', 100000); await tick()
  await db.queueSale(sale('s1', shift.id, '0001')); await tick()
  await db.addCashMove(shift.id, 'ana', -5000, 'Water'); await tick()
  await db.adjustSale({ saleId: 's1', kind: 'void', shiftId: shift.id, staffId: 'ana', approvedBy: 'ben', reason: 'Wrong item' }); await tick()
  await db.closeShift(shift.id, 'ana', 95000)

  const { remote, calls } = fakeRemote()
  expect(await pushPending(db, remote)).toEqual({ sent: 5, failing: 0, error: undefined })
  expect(calls.map((c) => c.fn)).toEqual(['open_shift', 'complete_sale', 'add_cash_movement', 'record_void', 'close_shift'])
  expect(await db.pendingCount()).toBe(0)
  expect((await db.outbox.get('s1'))?.syncedAt).toBeTruthy() // kept for shift totals, marked sent
  expect((await pushPending(db, remote)).sent).toBe(0) // nothing sent twice
})

test('a rejected sale is kept with its error and does not block the rest', async () => {
  const shift = await db.openShift(B, 'ana', 0); await tick()
  await db.queueSale(sale('dup', shift.id, '0001')); await tick()
  await db.queueSale(sale('ok', shift.id, '0002'))
  const { remote, calls } = fakeRemote({ reject: (fn, a) => (fn === 'complete_sale' && (a.p_sale as { id: string }).id === 'dup' ? new Error('duplicate receipt number') : undefined) })
  const r = await pushPending(db, remote)
  expect(r).toEqual({ sent: 2, failing: 1, error: 'duplicate receipt number' })
  expect(calls.map((c) => c.fn)).toEqual(['open_shift', 'complete_sale'])
  expect(await db.pendingCount()).toBe(1)
  expect((await db.outbox.get('dup'))?.lastError).toBe('duplicate receipt number')
})

test('no connection stops the round and keeps everything waiting', async () => {
  const shift = await db.openShift(B, 'ana', 0)
  await db.queueSale(sale('s1', shift.id, '0001'))
  const { remote } = fakeRemote({ reject: () => new OfflineError('No connection') })
  expect(await pushPending(db, remote)).toEqual({ sent: 0, failing: 0, error: 'No connection' })
  expect(await db.pendingCount()).toBe(2)
})

test('clock-in selfie is uploaded after the attendance record', async () => {
  await db.recordPunch({ staffId: 'ana', branchId: B, kind: 'in', photo: new Blob(['jpg'], { type: 'image/jpeg' }) })
  const { remote, calls, uploads } = fakeRemote()
  await pushPending(db, remote)
  expect(calls.map((c) => c.fn)).toEqual(['record_attendance', 'set_attendance_photo'])
  expect(uploads[0]).toMatch(new RegExp(`^${B}/.+\\.jpg$`))
})

test('pull replaces the catalogue and staff; stock counts sales not yet sent', async () => {
  const shift = await db.openShift(B, 'ana', 0)
  await db.queueSale(sale('s1', shift.id, '0001', 'v1', 2)) // not yet on the server
  const { remote } = fakeRemote({ tables: {
    categories: [{ id: 'c1', name: 'Pods', sort_order: 1 }],
    products: [{ id: 'p1', category_id: 'c1', name: 'Pod 5000', brand: null, is_device: false, is_active: true }],
    variants: [{ id: 'v1', product_id: 'p1', flavor: 'Grape', nicotine_mg: null, size_ml: null, color: null, price: '450.00', cost: 300, is_active: true }],
    stock: [{ variant_id: 'v1', quantity: 10 }],
  } })
  expect((await pullAll(db, remote))?.branch_name).toBe('Dapitan Branch')
  expect(await db.products.count()).toBe(1)
  expect(await db.variants.get('v1')).toMatchObject({ priceCentavos: 45000, costCentavos: 30000, flavor: 'Grape', nicotineMg: undefined })
  expect((await db.stock.get('v1'))?.quantity).toBe(8) // 10 on the server - 2 sold here, unsent
  expect((await db.staff.toArray()).map((s) => s.fullName)).toEqual(['Cara'])
  expect(await db.favorites.count()).toBe(0) // demo favourites point at items that no longer exist
  expect(await db.getSetting<DeviceSettings>('device')).toMatchObject({ branchId: 'srv-branch', branchName: 'Dapitan Branch', live: true })
})

test('a switched-off device is reported', async () => {
  const { remote } = fakeRemote({ device: false })
  expect((await syncOnce(db, remote)).error).toMatch(/switched off/)
  expect(await db.products.count()).toBe(4) // local catalogue untouched
})
