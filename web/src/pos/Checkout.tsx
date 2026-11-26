// Checkout: age check, device serials, discount, manual receipt no., payment.
// Validates with the same rules as the server, then queues the sale offline.

import { useState } from 'react'
import { db } from '../data/localDb'
import {
  change, CheckoutError, discountAmount, peso, toSalePayload, total,
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

export function Checkout({ cart, setCart, ids, onCancel, onComplete }: Props) {
  const [method, setMethod] = useState<PayMethod>('cash')
  const [tendered, setTendered] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const update = (patch: Partial<CartState>) => setCart({ ...cart, ...patch })

  const amount = total(cart)
  const idBased = cart.discount?.kind === 'senior' || cart.discount?.kind === 'pwd'

  async function complete() {
    const final: CartState = {
      ...cart,
      payments: [{
        method,
        amountCentavos: amount,
        tenderedCentavos: method === 'cash' ? (toCentavos(tendered) ?? amount) : undefined,
        referenceNo: method === 'cash' ? undefined : reference,
      }],
    }
    try {
      setSaving(true)
      const payload = toSalePayload(final, ids)
      await db.queueSale(payload)
      onComplete(change(final))
    } catch (e) {
      setError(e instanceof CheckoutError ? e.message : `Could not save sale: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  function setDiscount(kind: DiscountKind | '') {
    if (!kind) return update({ discount: undefined })
    update({ discount: { kind, value: kind === 'senior' || kind === 'pwd' ? 20 : 0 } })
  }

  return (
    <div className="sheet">
      <form className="checkout" onSubmit={(e) => { e.preventDefault(); void complete() }}>
        <h2>Total {peso(amount)}</h2>

        <fieldset>
          <legend>Discount</legend>
          <select value={cart.discount?.kind ?? ''} onChange={(e) => setDiscount(e.target.value as DiscountKind | '')}>
            <option value="">None</option>
            <option value="percent">Percent</option>
            <option value="fixed">Fixed amount</option>
            <option value="senior">Senior citizen</option>
            <option value="pwd">PWD</option>
          </select>
          {cart.discount && !idBased && (
            <input type="number" min="0" placeholder={cart.discount.kind === 'percent' ? '%' : '₱'} value={cart.discount.value || ''}
              onChange={(e) => update({ discount: { ...cart.discount!, value: Number(e.target.value) } })} />
          )}
          {idBased && (
            <>
              <input placeholder="Name on ID" value={cart.discount?.idHolder ?? ''} onChange={(e) => update({ discount: { ...cart.discount!, idHolder: e.target.value } })} />
              <input placeholder="ID number" value={cart.discount?.idNumber ?? ''} onChange={(e) => update({ discount: { ...cart.discount!, idNumber: e.target.value } })} />
            </>
          )}
          {discountAmount(cart) > 0 && <small>−{peso(discountAmount(cart))}</small>}
        </fieldset>

        <label className="check">
          <input type="checkbox" checked={cart.ageVerified} onChange={(e) => update({ ageVerified: e.target.checked })} />
          Customer is 18+ (ID checked) — required by RA 11900
        </label>

        {cart.lines.map((l, i) => l.variant.isDevice && (
          <input key={i} placeholder={`Serial no. – ${l.variant.productName} ${l.variant.label}`} value={l.serialNo ?? ''}
            onChange={(e) => update({ lines: cart.lines.map((x, j) => (j === i ? { ...x, serialNo: e.target.value } : x)) })} />
        ))}

        <input placeholder="Manual receipt no." value={cart.manualReceiptNo ?? ''} onChange={(e) => update({ manualReceiptNo: e.target.value })} />

        <div className="segmented" role="radiogroup">
          {(['cash', 'gcash', 'maya'] as const).map((m) => (
            <button type="button" key={m} role="radio" aria-checked={method === m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>
              {m === 'cash' ? 'Cash' : m === 'gcash' ? 'GCash' : 'Maya'}
            </button>
          ))}
        </div>

        {method === 'cash' ? (
          <>
            <input inputMode="decimal" placeholder="Cash given (₱) – blank = exact" value={tendered} onChange={(e) => setTendered(e.target.value)} />
            {(toCentavos(tendered) ?? 0) > amount && <p>Change: <strong>{peso((toCentavos(tendered) ?? 0) - amount)}</strong></p>}
          </>
        ) : (
          <>
            <p>Show the branch {method === 'gcash' ? 'GCash' : 'Maya'} QR for {peso(amount)}. Check the payment arrived on the branch phone before confirming.</p>
            <input placeholder="Reference no." value={reference} onChange={(e) => setReference(e.target.value)} />
          </>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Back</button>
          <button type="submit" className="primary" disabled={saving}>Complete sale</button>
        </div>
      </form>
    </div>
  )
}
