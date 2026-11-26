// Checkout: age check, device serials, discount, manual receipt no., payment.
// Validates with the same rules as the server, then queues the sale offline.

import { useState } from 'react'
import { db } from '../data/localDb'
import {
  change, CheckoutError, quickCash, discountAmount, peso, subtotal, toSalePayload, total,
  type CartState, type DiscountKind, type PayMethod,
} from '../domain/cart'

interface Props {
  cart: CartState
  setCart: (c: CartState) => void
  ids: { branchId: string; shiftId: string; staffId: string }
  onCancel: () => void
  onComplete: (changeCentavos: number) => void
}

const toCentavos = (s: string) => {
  const n = Number(s.replace(/,/g, '').trim())
  return s.trim() === '' || Number.isNaN(n) ? undefined : Math.round(n * 100)
}

const METHODS: { id: PayMethod; label: string; note: string }[] = [
  { id: 'cash', label: 'Cash', note: 'Count and give change' },
  { id: 'gcash', label: 'GCash', note: 'Branch QR + ref no.' },
  { id: 'maya', label: 'Maya', note: 'Branch QR + ref no.' },
]
const DISCOUNTS: { id: DiscountKind | ''; label: string }[] = [
  { id: '', label: 'None' }, { id: 'senior', label: 'Senior' }, { id: 'pwd', label: 'PWD' },
  { id: 'percent', label: '%' }, { id: 'fixed', label: '₱ off' },
]

export function Checkout({ cart, setCart, ids, onCancel, onComplete }: Props) {
  const [method, setMethod] = useState<PayMethod>('cash')
  const [tendered, setTendered] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const update = (patch: Partial<CartState>) => { setError(undefined); setCart({ ...cart, ...patch }) }

  const amount = total(cart)
  const d = cart.discount
  const idBased = d?.kind === 'senior' || d?.kind === 'pwd'
  const given = toCentavos(tendered)
  const devices = cart.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.variant.isDevice)

  async function complete() {
    const final: CartState = {
      ...cart,
      payments: [{
        method, amountCentavos: amount,
        tenderedCentavos: method === 'cash' ? (given ?? amount) : undefined,
        referenceNo: method === 'cash' ? undefined : reference,
      }],
    }
    try {
      setSaving(true)
      await db.queueSale(toSalePayload(final, ids))
      onComplete(change(final))
    } catch (e) {
      setError(e instanceof CheckoutError ? e.message : `Could not save sale: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  function pickDiscount(kind: DiscountKind | '') {
    update({ discount: kind ? { kind, value: kind === 'senior' || kind === 'pwd' ? 20 : 0 } : undefined })
  }

  return (
    <div className="overlay" onClick={onCancel}>
      <form className="drawer right checkout" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void complete() }}>
        <div className="drawer-head">
          <div><small>Amount due</small><h2 className="due">{peso(amount)}</h2></div>
          <button type="button" className="icon" aria-label="Back to sale" onClick={onCancel}>✕</button>
        </div>

        <section className="step">
          <h3>Age check</h3>
          <label className={cart.ageVerified ? 'agecheck on' : 'agecheck'}>
            <input type="checkbox" checked={cart.ageVerified} onChange={(e) => update({ ageVerified: e.target.checked })} />
            <span><b>Customer is 18 or older</b><small>ID checked · required by RA 11900</small></span>
          </label>
        </section>

        {devices.length > 0 && (
          <section className="step">
            <h3>Device serial numbers</h3>
            {devices.map(({ l, i }) => (
              <label key={i} className="field">
                <span>{l.variant.productName} · {l.variant.label}</span>
                <input value={l.serialNo ?? ''} placeholder="Serial no."
                  onChange={(e) => update({ lines: cart.lines.map((x, j) => (j === i ? { ...x, serialNo: e.target.value } : x)) })} />
              </label>
            ))}
          </section>
        )}

        <section className="step">
          <h3>Discount</h3>
          <div className="seg">
            {DISCOUNTS.map((x) => (
              <button type="button" key={x.id || 'none'} className={(d?.kind ?? '') === x.id ? 'on' : ''} onClick={() => pickDiscount(x.id)}>{x.label}</button>
            ))}
          </div>
          {d && !idBased && (
            <label className="field"><span>{d.kind === 'percent' ? 'Percent off' : 'Amount off (₱)'}</span>
              <input inputMode="decimal" value={d.value || ''} onChange={(e) => update({ discount: { ...d, value: Number(e.target.value) || 0 } })} /></label>
          )}
          {idBased && (
            <div className="two">
              <label className="field"><span>Name on ID</span><input value={d?.idHolder ?? ''} onChange={(e) => update({ discount: { ...d!, idHolder: e.target.value } })} /></label>
              <label className="field"><span>ID number</span><input value={d?.idNumber ?? ''} onChange={(e) => update({ discount: { ...d!, idNumber: e.target.value } })} /></label>
            </div>
          )}
          {discountAmount(cart) > 0 && <p className="muted">{peso(subtotal(cart))} − {peso(discountAmount(cart))} discount</p>}
        </section>

        <section className="step">
          <h3>Payment</h3>
          <div className="methods" role="radiogroup" aria-label="Payment method">
            {METHODS.map((m) => (
              <button type="button" key={m.id} role="radio" aria-checked={method === m.id} className={method === m.id ? 'method on' : 'method'}
                onClick={() => { setMethod(m.id); setError(undefined) }}>
                <b>{m.label}</b><small>{m.note}</small>
              </button>
            ))}
          </div>

          {method === 'cash' ? (
            <>
              <div className="quick">
                {quickCash(amount).map((v, i) => (
                  <button type="button" key={v} className={given === v ? 'on' : ''} onClick={() => setTendered((v / 100).toFixed(2))}>
                    {i === 0 ? 'Exact' : peso(v).replace('.00', '')}
                  </button>
                ))}
              </div>
              <label className="field"><span>Cash received</span>
                <input inputMode="decimal" placeholder={`${(amount / 100).toFixed(2)} (exact)`} value={tendered} onChange={(e) => setTendered(e.target.value)} /></label>
              {given != null && given >= amount && <p className="change">Change <b>{peso(given - amount)}</b></p>}
            </>
          ) : (
            <>
              <div className="qr-note">
                Show the branch <b>{method === 'gcash' ? 'GCash' : 'Maya'}</b> QR for <b>{peso(amount)}</b>.
                Confirm the money arrived on the branch phone — not the customer's screen.
              </div>
              <label className="field"><span>Reference no.</span>
                <input value={reference} autoComplete="off" onChange={(e) => { setReference(e.target.value); setError(undefined) }} /></label>
            </>
          )}
        </section>

        <section className="step">
          <label className="field"><span>Manual receipt no. (BIR booklet)</span>
            <input value={cart.manualReceiptNo ?? ''} onChange={(e) => update({ manualReceiptNo: e.target.value })} /></label>
        </section>

        <div className="drawer-foot">
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="btn primary xl" disabled={saving}>{saving ? 'Saving…' : `Complete sale · ${peso(amount)}`}</button>
        </div>
      </form>
    </div>
  )
}
