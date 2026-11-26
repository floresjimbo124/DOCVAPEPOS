// Register: find products by tapping (category -> product -> variant), search,
// or favorites; build the cart; check out. Plain functional UI - visual design later.

import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db, type Product, type VariantRow } from '../data/localDb'
import { addToCart, emptyCart, peso, setQuantity, total, type CartState } from '../domain/cart'
import { Checkout } from './Checkout'

interface Props { branchId: string; shiftId: string; staffId: string }

export function Register(ids: Props) {
  const [cart, setCart] = useState<CartState>(emptyCart)
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState<string>()
  const [picking, setPicking] = useState<{ product: Product; rows: VariantRow[] }>()
  const [checkingOut, setCheckingOut] = useState(false)
  const [cartOpen, setCartOpen] = useState(false) // phone layout
  const [toast, setToast] = useState<string>()

  const categories = useLiveQuery(() => db.categoriesSorted(), []) ?? []
  const activeCat = categoryId ?? categories[0]?.id
  const products = useLiveQuery(() => (activeCat ? db.productsIn(activeCat) : []), [activeCat]) ?? []
  const favorites = useLiveQuery(() => db.favoriteRows(), []) ?? []
  const results = useLiveQuery(() => db.search(query), [query]) ?? []
  const pending = useLiveQuery(() => db.outbox.count(), []) ?? 0

  const add = (r: VariantRow) =>
    setCart((c) => addToCart(c, {
      variantId: r.variant.id, productName: r.product.name, label: r.label,
      priceCentavos: r.variant.priceCentavos, isDevice: r.product.isDevice,
    }))

  async function openProduct(p: Product) {
    const rows = await db.variantsOf(p.id)
    if (rows.length === 1) add(rows[0])
    else setPicking({ product: p, rows })
  }

  async function onComplete(changeCentavos: number) {
    setCheckingOut(false)
    setCartOpen(false)
    setCart(emptyCart())
    setToast(changeCentavos > 0 ? `Sale saved. Change: ${peso(changeCentavos)}` : 'Sale saved')
    setTimeout(() => setToast(undefined), 4000)
  }

  const variantButton = (r: VariantRow) => (
    <button key={r.variant.id} className="tile" disabled={r.stock <= 0} onClick={() => add(r)}>
      <strong>{r.product.name}</strong>
      <span>{r.label}</span>
      <span>{peso(r.variant.priceCentavos)} · stock {r.stock}</span>
    </button>
  )

  const cartPanel = (
    <aside className="cart">
      <ul>
        {cart.lines.map((l, i) => (
          <li key={i}>
            <div>
              <strong>{l.variant.productName}</strong>
              <small>{l.variant.label}</small>
            </div>
            <div className="qty">
              <button aria-label="less" onClick={() => setCart((c) => setQuantity(c, i, l.quantity - 1))}>−</button>
              <span>{l.quantity}</span>
              <button aria-label="more" disabled={l.variant.isDevice} onClick={() => setCart((c) => setQuantity(c, i, l.quantity + 1))}>+</button>
            </div>
          </li>
        ))}
      </ul>
      <div className="total">Total <strong>{peso(total(cart))}</strong></div>
      <button className="primary" disabled={!cart.lines.length} onClick={() => setCheckingOut(true)}>Checkout</button>
    </aside>
  )

  return (
    <div className="register">
      <header>
        <h1>Register</h1>
        <span className={pending ? 'badge warn' : 'badge'}>Unsynced sales: {pending}</span>
      </header>

      <main className="catalogue">
        <input type="search" placeholder="Search name, brand, flavor, mg…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query.trim() ? (
          <div className="grid">{results.map(variantButton)}{!results.length && <p>No match</p>}</div>
        ) : (
          <>
            <h2>Favorites</h2>
            <div className="row">{favorites.map(variantButton)}</div>
            <nav className="chips">
              {categories.map((c) => (
                <button key={c.id} className={c.id === activeCat ? 'chip on' : 'chip'} onClick={() => setCategoryId(c.id)}>{c.name}</button>
              ))}
            </nav>
            <div className="grid">
              {products.map((p) => <button key={p.id} className="tile" onClick={() => openProduct(p)}><strong>{p.name}</strong><span>{p.brand}</span></button>)}
            </div>
          </>
        )}
      </main>

      <div className="cart-side">{cartPanel}</div>
      <button className="cart-bar primary" disabled={!cart.lines.length} onClick={() => setCartOpen(true)}>
        Cart ({cart.lines.length}) · {peso(total(cart))}
      </button>

      {cartOpen && <div className="sheet" onClick={() => setCartOpen(false)}><div onClick={(e) => e.stopPropagation()}>{cartPanel}</div></div>}

      {picking && (
        <div className="sheet" onClick={() => setPicking(undefined)}>
          <div onClick={(e) => e.stopPropagation()}>
            <h2>{picking.product.name}</h2>
            <div className="grid">
              {picking.rows.map((r) => (
                <button key={r.variant.id} className="tile" disabled={r.stock <= 0} onClick={() => { add(r); setPicking(undefined) }}>
                  <strong>{r.label}</strong><span>{peso(r.variant.priceCentavos)} · stock {r.stock}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {checkingOut && <Checkout cart={cart} setCart={setCart} ids={ids} onCancel={() => setCheckingOut(false)} onComplete={onComplete} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
