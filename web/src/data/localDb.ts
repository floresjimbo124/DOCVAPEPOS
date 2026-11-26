// On-device database (IndexedDB via Dexie). The register reads only from here,
// so selling works with no internet. Sales wait in the outbox until synced.

import Dexie, { type EntityTable } from 'dexie'
import type { SalePayload } from '../domain/cart'

export interface Category { id: string; name: string; sortOrder: number }
export interface Product { id: string; categoryId: string | null; name: string; brand?: string; isDevice: boolean; isActive: boolean }
export interface Variant {
  id: string; productId: string; flavor?: string; nicotineMg?: number; sizeMl?: number; color?: string
  priceCentavos: number; isActive: boolean
}
/** Stock at THIS device's branch (refreshed on sync, decremented locally on sale). */
export interface StockRow { variantId: string; quantity: number }
export interface Favorite { variantId: string; sortOrder: number }
export interface OutboxRow { saleId: string; payload: SalePayload; createdAt: number; attempts: number; lastError?: string }

export interface VariantRow { variant: Variant; product: Product; stock: number; label: string }

export class LocalDb extends Dexie {
  categories!: EntityTable<Category, 'id'>
  products!: EntityTable<Product, 'id'>
  variants!: EntityTable<Variant, 'id'>
  stock!: EntityTable<StockRow, 'variantId'>
  favorites!: EntityTable<Favorite, 'variantId'>
  outbox!: EntityTable<OutboxRow, 'saleId'>

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
  }

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
      await this.outbox.add({ saleId: payload.id, payload, createdAt: Date.now(), attempts: 0 })
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
