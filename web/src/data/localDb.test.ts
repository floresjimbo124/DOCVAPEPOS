import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { seedDemoIfEmpty } from './demoSeed'
import { LocalDb } from './localDb'

let db: LocalDb
beforeEach(async () => {
  db = new LocalDb(`test-${crypto.randomUUID()}`)
  await seedDemoIfEmpty(db)
})
afterEach(() => db.delete())

test('browse: category -> products -> variants with labels', async () => {
  expect((await db.productsIn('c-juice')).map((p) => p.name)).toEqual(['Freebase 60ml', 'Salt Nic 30ml'])
  expect((await db.variantsOf('p-salt')).map((r) => r.label)).toContain('Mango · 30mg · 30ml')
})

test('search matches flavor, brand and name (all words)', async () => {
  expect((await db.search('lychee')).map((r) => r.variant.id)).toEqual(['v-pod-lychee'])
  expect((await db.search('cloud')).length).toBe(5)
  expect((await db.search('pod kit')).length).toBe(2)
  expect((await db.search('mango 50')).map((r) => r.variant.id)).toEqual(['v-salt-mango-50'])
  expect((await db.search('60ml')).length).toBe(2)
  expect(await db.search('  ')).toEqual([])
})

test('favorites keep their order', async () => {
  expect((await db.favoriteRows()).map((r) => r.variant.id)).toEqual(['v-pod-straw', 'v-salt-mango-30'])
})

test('queued sale goes to outbox and deducts local stock', async () => {
  const payload = {
    id: 'sale-1', branch_id: 'b', shift_id: 's', staff_id: 'u', age_verified: true, manual_receipt_no: null,
    client_created_at: new Date().toISOString(), discounts: [], payments: [],
    items: [{ variant_id: 'v-pod-straw', quantity: 3, unit_price: '550.00' }],
  }
  await db.queueSale(payload)
  expect((await db.stock.get('v-pod-straw'))?.quantity).toBe(7)
  expect(await db.outbox.count()).toBe(1)
  await expect(db.queueSale(payload)).rejects.toThrow() // same sale can't be queued twice
  expect((await db.stock.get('v-pod-straw'))?.quantity).toBe(7) // and stock is untouched
  await seedDemoIfEmpty(db)
  expect(await db.categories.count()).toBe(3)
})

test('seeding twice at the same time is safe', async () => {
  const fresh = new LocalDb(`test-${crypto.randomUUID()}`)
  await Promise.all([seedDemoIfEmpty(fresh), seedDemoIfEmpty(fresh), seedDemoIfEmpty(fresh)])
  expect(await fresh.variants.count()).toBe(9)
  await fresh.delete()
})
