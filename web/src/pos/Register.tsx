// Register: favorites, category tiles -> flavor/strength picker, search; cart; checkout.
// Designed for fast, all-day use on tablets (two panes) and phones (cart in a bottom sheet).

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import CountUp from '../components/reactbits/CountUp'
import { db, type DeviceSettings, type Product, type ShiftRow, type StaffRow, type VariantRow } from '../data/localDb'
import { addToCart, discountAmount, emptyCart, peso, setQuantity, subtotal, total, type CartState } from '../domain/cart'
import { useTheme } from '../theme'
import type { ShiftSummary } from '../domain/shift'
import { Checkout } from './Checkout'
import { CashMoveSheet, CloseShiftSheet } from './Shift'

interface Props {
  device: DeviceSettings
  staff: StaffRow
  shift: ShiftRow
  onLock: () => void
  onShiftClosed: (r: { shift: ShiftRow; summary: ShiftSummary }) => void
}

const LOW_STOCK = 3

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

/** Animated peso amount (React Bits CountUp), short so it never slows the cashier. */
const Money = ({ centavos, className }: { centavos: number; className?: string }) => (
  <CountUp to={centavos / 100} decimals={2} separator="," prefix="₱" duration={0.35} trigger="load" className={className} />
)

const StockBadge = ({ n }: { n: number }) =>
  n <= 0 ? <span className="stock out">Out</span> : n <= LOW_STOCK ? <span className="stock low">{n} left</span> : <span className="stock">{n}</span>

export function Register({ device, staff, shift, onLock, onShiftClosed }: Props) {
  const ids = { branchId: device.branchId, shiftId: shift.id, staffId: staff.id }
  const [panel, setPanel] = useState<'cash' | 'close'>()
  const [cart, setCart] = useState<CartState>(emptyCart)
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState<string>()
  const [picking, setPicking] = useState<{ product: Product; rows: VariantRow[] }>()
  const [checkingOut, setCheckingOut] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const [toast, setToast] = useState<string>()
  const [bump, setBump] = useState(0) // re-triggers the "added" pulse on the cart button
  const online = useOnline()
  const [theme, toggleTheme] = useTheme()

  const categories = useLiveQuery(() => db.categoriesSorted(), []) ?? []
  const activeCat = categoryId ?? categories[0]?.id
  const products = useLiveQuery(() => (activeCat ? db.productsIn(activeCat) : []), [activeCat]) ?? []
  const favorites = useLiveQuery(() => db.favoriteRows(), []) ?? []
  const results = useLiveQuery(() => db.search(query), [query]) ?? []
  const pending = useLiveQuery(() => db.pendingCount(), []) ?? 0
  const itemCount = cart.lines.reduce((s, l) => s + l.quantity, 0)

  const add = (r: VariantRow) => {
    setCart((c) => addToCart(c, {
      variantId: r.variant.id, productName: r.product.name, label: r.label,
      priceCentavos: r.variant.priceCentavos, isDevice: r.product.isDevice,
    }))
    setBump((b) => b + 1)
  }

  async function openProduct(p: Product) {
    const rows = await db.variantsOf(p.id)
    if (rows.length === 1) add(rows[0])
    else setPicking({ product: p, rows })
  }

  function onComplete(changeCentavos: number) {
    setCheckingOut(false); setCartOpen(false); setCart(emptyCart())
    setToast(changeCentavos > 0 ? `Sale saved · Change ${peso(changeCentavos)}` : 'Sale saved')
    setTimeout(() => setToast(undefined), 3500)
  }

  const variantTile = (r: VariantRow) => (
    <button key={r.variant.id} className="tile"
      disabled={r.stock <= 0} onClick={() => add(r)}>
      <span className="tile-name">{r.product.name}</span>
      <span className="tile-sub">{r.label}</span>
      <span className="tile-foot"><b>{peso(r.variant.priceCentavos)}</b><StockBadge n={r.stock} /></span>
    </button>
  )

  const cartPanel = (
    <section className="cart" aria-label="Cart">
      <div className="cart-head">
        <h2>Current sale</h2>
        {cart.lines.length > 0 && <button className="link" onClick={() => setCart(emptyCart())}>Clear</button>}
      </div>
      {cart.lines.length === 0 ? (
        <p className="empty">Tap a product to start a sale.</p>
      ) : (
        <ul className="lines">
          {cart.lines.map((l, i) => (
            <li key={i}>
              <div className="line-info">
                <span className="line-name">{l.variant.productName}</span>
                <span className="line-sub">{l.variant.label}{l.variant.isDevice && ' · needs serial'}</span>
              </div>
              <div className="stepper">
                <button aria-label={`Remove one ${l.variant.productName}`} onClick={() => setCart((c) => setQuantity(c, i, l.quantity - 1))}>−</button>
                <span>{l.quantity}</span>
                <button aria-label={`Add one ${l.variant.productName}`} disabled={l.variant.isDevice} onClick={() => setCart((c) => setQuantity(c, i, l.quantity + 1))}>+</button>
              </div>
              <span className="line-amt">{peso(l.variant.priceCentavos * l.quantity)}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="sums">
        <div><dt>Subtotal</dt><dd>{peso(subtotal(cart))}</dd></div>
        {discountAmount(cart) > 0 && <div className="disc"><dt>Discount</dt><dd>−{peso(discountAmount(cart))}</dd></div>}
        <div className="grand"><dt>Total</dt><dd><Money centavos={total(cart)} /></dd></div>
      </dl>
      <button className="btn primary xl" disabled={!cart.lines.length} onClick={() => setCheckingOut(true)}>
        Charge {peso(total(cart))}
      </button>
    </section>
  )

  return (
    <div className="pos">
      <header className="topbar">
        <div className="brand">
          <span className="logo"><img src="/logo.png" alt="DOCVAPE – Drip of Clouds" /></span>
          <div><b>{device.branchName}</b><small>{staff.fullName}</small></div>
        </div>
        <div className="status">
          <span className={online ? 'pill ok' : 'pill off'}><i />{online ? 'Online' : 'Offline – still selling'}</span>
          {pending > 0 && <span className="pill warn">{pending} to sync</span>}
          <button className="topbtn" onClick={() => setPanel('cash')}>Cash &amp; expenses</button>
          <button className="topbtn" onClick={() => setPanel('close')} disabled={cart.lines.length > 0}
            title={cart.lines.length ? 'Finish or clear the current sale first' : undefined}>Close shift</button>
          <button className="topbtn" onClick={onLock} disabled={cart.lines.length > 0}
            title={cart.lines.length ? 'Finish or clear the current sale first' : 'Lock the register'}>Lock</button>
          <button className="theme-toggle" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>{theme === 'dark' ? '☀' : '☾'}</button>
        </div>
      </header>

      <main className="catalogue">
        <div className="search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 0 3.9 10.6l4.7 4.7 1.4-1.4-4.7-4.7A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" /></svg>
          <input type="search" placeholder="Search product, flavor, mg, ml…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search products" />
        </div>

        {query.trim() ? (
          <>
            <h3 className="section">{results.length} result{results.length === 1 ? '' : 's'}</h3>
            <div className="grid">{results.map(variantTile)}</div>
          </>
        ) : (
          <>
            {favorites.length > 0 && (
              <>
                <h3 className="section">Favorites</h3>
                <div className="grid">{favorites.map(variantTile)}</div>
              </>
            )}
            <nav className="tabs" aria-label="Categories">
              {categories.map((c) => (
                <button key={c.id} className={c.id === activeCat ? 'tab on' : 'tab'}
                  onClick={() => setCategoryId(c.id)}>{c.name}</button>
              ))}
            </nav>
            <div className="grid">
              {products.map((p) => (
                <button key={p.id} className="tile product" onClick={() => openProduct(p)}>
                  <span className="tile-name">{p.name}</span>
                  <span className="tile-sub">{p.brand}</span>
                  <span className="tile-foot"><span className="hint">{p.isDevice ? 'Choose color ›' : 'Choose flavor ›'}</span></span>
                </button>
              ))}
            </div>
          </>
        )}
      </main>

      <aside className="side">{cartPanel}</aside>

      <button key={bump} className={`cartbar ${bump ? 'pulse' : ''}`} disabled={!cart.lines.length} onClick={() => setCartOpen(true)}>
        <span>{itemCount} item{itemCount === 1 ? '' : 's'}</span><b>View sale · {peso(total(cart))}</b>
      </button>

      {cartOpen && (
        <div className="overlay" onClick={() => setCartOpen(false)}>
          <div className="drawer bottom" onClick={(e) => e.stopPropagation()}>{cartPanel}</div>
        </div>
      )}

      {picking && (
        <div className="overlay" onClick={() => setPicking(undefined)}>
          <div className="drawer bottom picker" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div><h2>{picking.product.name}</h2><small>{picking.product.brand}</small></div>
              <button className="icon" aria-label="Close" onClick={() => setPicking(undefined)}>✕</button>
            </div>
            <div className="grid">
              {picking.rows.map((r) => (
                <button key={r.variant.id} className="tile" disabled={r.stock <= 0} onClick={() => { add(r); setPicking(undefined) }}>
                  <span className="tile-name">{r.label}</span>
                  <span className="tile-foot"><b>{peso(r.variant.priceCentavos)}</b><StockBadge n={r.stock} /></span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {checkingOut && <Checkout cart={cart} setCart={setCart} ids={ids} onCancel={() => setCheckingOut(false)} onComplete={onComplete} />}
      {panel === 'cash' && <CashMoveSheet shift={shift} staff={staff} onClose={() => setPanel(undefined)} />}
      {panel === 'close' && <CloseShiftSheet shift={shift} staff={staff} onCancel={() => setPanel(undefined)} onClosed={onShiftClosed} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </div>
  )
}
