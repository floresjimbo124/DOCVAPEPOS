// Sample catalogue so the register can be tried before the real product list
// arrives. Replaced by server sync later.

import { hashPin } from './auth'
import type { DeviceSettings, LocalDb, StaffRow, Variant } from './localDb'

export const DEMO_BRANCH: DeviceSettings = { branchId: '00000000-0000-4000-8000-000000000001', branchName: 'P. Campa Branch', label: 'Counter tablet' }
/** Demo logins: cashier 1234, manager 9999, owner 0000. */
export const DEMO_STAFF = [
  { id: '00000000-0000-4000-8000-0000000000a1', fullName: 'Ana (Cashier)', role: 'cashier', pin: '1234' },
  { id: '00000000-0000-4000-8000-0000000000a2', fullName: 'Ben (Manager)', role: 'manager', pin: '9999' },
  { id: '00000000-0000-4000-8000-0000000000a3', fullName: 'Owner', role: 'owner', pin: '0000' },
] as const

/** Demo device + staff. Hashes are made first: only Dexie calls may run inside its transaction. */
export async function seedDemoStaffIfEmpty(db: LocalDb) {
  if ((await db.staff.count()) > 0) return
  const staff: StaffRow[] = await Promise.all(DEMO_STAFF.map(async ({ pin, ...s }) => ({ ...s, pinHash: await hashPin(pin), isActive: true })))
  await db.transaction('rw', db.staff, db.settings, async () => {
    if ((await db.staff.count()) > 0) return
    await db.staff.bulkAdd(staff)
    if (!(await db.settings.get('device'))) await db.settings.put({ key: 'device', value: DEMO_BRANCH })
  })
}

export async function seedDemoIfEmpty(db: LocalDb) {
  // Check and insert inside one write transaction, so two tabs (or React's double
  // start-up in development) can't both seed at once.
  await db.transaction('rw', [db.categories, db.products, db.variants, db.stock, db.favorites], async () => {
    if ((await db.categories.count()) > 0) return
    await db.categories.bulkAdd([
      { id: 'c-juice', name: 'E-Liquids', sortOrder: 1 },
      { id: 'c-pods', name: 'Pods', sortOrder: 2 },
      { id: 'c-dev', name: 'Devices', sortOrder: 3 },
    ])
    await db.products.bulkAdd([
      { id: 'p-salt', categoryId: 'c-juice', name: 'Salt Nic 30ml', brand: 'Cloud Co', isDevice: false, isActive: true },
      { id: 'p-free', categoryId: 'c-juice', name: 'Freebase 60ml', brand: 'Cloud Co', isDevice: false, isActive: true },
      { id: 'p-pod', categoryId: 'c-pods', name: 'Disposable Pod 5000', brand: 'PuffMax', isDevice: false, isActive: true },
      { id: 'p-kit', categoryId: 'c-dev', name: 'Pod Kit X', brand: 'VapeTech', isDevice: true, isActive: true },
    ])
    const v = (id: string, productId: string, priceCentavos: number, x: Partial<Variant> = {}): Variant =>
      ({ id, productId, priceCentavos, costCentavos: Math.round(priceCentavos * 0.6), isActive: true, ...x }) // demo cost: 60% of price
    const variants = [
      v('v-salt-mango-30', 'p-salt', 35000, { flavor: 'Mango', nicotineMg: 30, sizeMl: 30 }),
      v('v-salt-mango-50', 'p-salt', 37000, { flavor: 'Mango', nicotineMg: 50, sizeMl: 30 }),
      v('v-salt-grape-30', 'p-salt', 35000, { flavor: 'Grape', nicotineMg: 30, sizeMl: 30 }),
      v('v-free-mint-3', 'p-free', 45000, { flavor: 'Mint', nicotineMg: 3, sizeMl: 60 }),
      v('v-free-mint-6', 'p-free', 45000, { flavor: 'Mint', nicotineMg: 6, sizeMl: 60 }),
      v('v-pod-straw', 'p-pod', 55000, { flavor: 'Strawberry' }),
      v('v-pod-lychee', 'p-pod', 55000, { flavor: 'Lychee Ice' }),
      v('v-kit-black', 'p-kit', 120000, { color: 'Black' }),
      v('v-kit-blue', 'p-kit', 120000, { color: 'Blue' }),
    ]
    await db.variants.bulkAdd(variants)
    await db.stock.bulkAdd(variants.map((x) => ({ variantId: x.id, quantity: 10 })))
    await db.favorites.bulkAdd([
      { variantId: 'v-pod-straw', sortOrder: 1 },
      { variantId: 'v-salt-mango-30', sortOrder: 2 },
    ])
  })
}
