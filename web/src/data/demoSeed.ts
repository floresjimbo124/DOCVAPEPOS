// Sample catalogue so the register can be tried before the real product list
// arrives. Replaced by server sync later.

import type { LocalDb, Variant } from './localDb'

export async function seedDemoIfEmpty(db: LocalDb) {
  if ((await db.categories.count()) > 0) return
  await db.transaction('rw', [db.categories, db.products, db.variants, db.stock, db.favorites], async () => {
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
      ({ id, productId, priceCentavos, isActive: true, ...x })
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
