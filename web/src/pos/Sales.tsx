// Sales list on the register: this shift's sales (or search by receipt no.), then
// void the whole sale or refund some items. Needs a reason and an owner/manager PIN.

import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { verifyApprover } from '../data/auth'
import { db, type ShiftRow, type StaffRow } from '../data/localDb'
import { refundableQty, salePaid, saleState, type Adjustment } from '../domain/adjust'
import { peso, type PayMethod, type SalePayload } from '../domain/cart'

const time = (iso: string) => new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function SalesSheet({ shift, staff, onClose }: { shift: ShiftRow; staff: StaffRow; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string>()
  const data = useLiveQuery(async () => {
    const q = query.trim()
    const rows = q
      ? (await db.outbox.toArray()).filter((r) => (r.payload.manual_receipt_no ?? '').includes(q))
      : await db.outbox.where('shiftId').equals(shift.id).toArray()
    const sales = rows.map((r) => r.payload).sort((a, b) => b.client_created_at.localeCompare(a.client_created_at))
    const adjustments = await db.adjustments.where('saleId').anyOf(sales.map((s) => s.id)).toArray()
    const [variants, products] = await Promise.all([db.variants.toArray(), db.products.toArray()])
    const pn = new Map(products.map((p) => [p.id, p.name]))
    const names = new Map(variants.map((v) => [v.id, `${pn.get(v.productId) ?? 'Item'} ${[v.flavor, v.nicotineMg != null ? v.nicotineMg + 'mg' : '', v.color].filter(Boolean).join(' ')}`]))
    return { sales, adjustments, names }
  }, [query, shift.id])

  const open = data?.sales.find((s) => s.id === openId)
  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer right" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{open ? 'Sale details' : 'Sales'}</h2>
          <button type="button" className="icon" aria-label="Close" onClick={open ? () => setOpenId(undefined) : onClose}>{open ? '‹' : '✕'}</button>
        </div>
        {!data ? null : open ? (
          <SaleDetail sale={open} shift={shift} staff={staff} adjustments={data.adjustments} nameOf={(id) => data.names.get(id) ?? 'Item'} onDone={() => setOpenId(undefined)} />
        ) : (
          <>
            <label className="field"><span>Find by receipt no. (any shift)</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Leave empty to see this shift" /></label>
            {data.sales.length === 0 ? <p className="muted">{query ? 'No sale with that receipt number.' : 'No sales yet this shift.'}</p> : (
              <ul className="sales-list">
                {data.sales.map((s) => {
                  const st = saleState(s, data.adjustments)
                  return (
                    <li key={s.id}><button onClick={() => setOpenId(s.id)}>
                      <span><b>{peso(salePaid(s))}</b><small> · {time(s.client_created_at)}{s.manual_receipt_no ? ` · #${s.manual_receipt_no}` : ''}</small></span>
                      {st !== 'completed' && <span className={`tag ${st === 'voided' ? 'bad' : ''}`}>{st}</span>}
                    </button></li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function SaleDetail({ sale, shift, staff, adjustments, nameOf, onDone }: {
  sale: SalePayload; shift: ShiftRow; staff: StaffRow; adjustments: Adjustment[]
  nameOf: (variantId: string) => string; onDone: () => void
}) {
  const [mode, setMode] = useState<'view' | 'void' | 'refund'>('view')
  const [qty, setQty] = useState<Record<string, number>>({})
  const [method, setMethod] = useState<PayMethod>(sale.payments[0]?.method ?? 'cash')
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const st = saleState(sale, adjustments)
  const left = refundableQty(sale, adjustments)
  const mine = adjustments.filter((a) => a.saleId === sale.id)

  async function confirm() {
    setBusy(true); setError(undefined)
    try {
      const approver = await verifyApprover(db, pin)
      if (!approver) throw new Error('Owner or manager PIN required')
      await db.adjustSale({ saleId: sale.id, kind: mode as 'void' | 'refund', shiftId: shift.id, staffId: staff.id,
        approvedBy: approver.id, reason, refundItems: qty, method })
      onDone()
    } catch (e) { setError((e as Error).message); setPin('') } finally { setBusy(false) }
  }

  return (
    <div className="step">
      <dl className="report">
        <div><dt>Time</dt><dd>{time(sale.client_created_at)}</dd></div>
        {sale.manual_receipt_no && <div><dt>Receipt</dt><dd>#{sale.manual_receipt_no}</dd></div>}
        <div><dt>Paid</dt><dd>{sale.payments.map((p) => `${p.method.toUpperCase()} ₱${p.amount}`).join(' + ')}</dd></div>
        <div className="strong"><dt>Total</dt><dd>{peso(salePaid(sale))}</dd></div>
      </dl>
      <ul className="plain">
        {sale.items.map((i) => (
          <li key={i.variant_id}>
            <span>{i.quantity} × {nameOf(i.variant_id)}{i.serial_no ? <small> · SN {i.serial_no}</small> : null}</span>
            {mode === 'refund' ? (
              <span className="stepper">
                <button type="button" aria-label="less" onClick={() => setQty({ ...qty, [i.variant_id]: Math.max(0, (qty[i.variant_id] ?? 0) - 1) })}>−</button>
                <span>{qty[i.variant_id] ?? 0}</span>
                <button type="button" aria-label="more" disabled={(qty[i.variant_id] ?? 0) >= (left.get(i.variant_id) ?? 0)}
                  onClick={() => setQty({ ...qty, [i.variant_id]: (qty[i.variant_id] ?? 0) + 1 })}>+</button>
              </span>
            ) : <b>₱{i.unit_price}</b>}
          </li>
        ))}
      </ul>
      {mine.map((a) => <p key={a.id} className="muted">{a.kind === 'void' ? 'Voided' : `Refunded ${peso(a.amountCentavos)} (${a.method})`} · {a.reason}</p>)}

      {mode === 'view' ? (
        st === 'voided' || st === 'refunded' ? <p className="muted">Nothing left to void or refund.</p> : (
          <div className="actions">
            <button className="btn" onClick={() => setMode('refund')}>Refund items</button>
            <button className="btn" disabled={sale.shift_id !== shift.id || mine.length > 0} onClick={() => setMode('void')}
              title={sale.shift_id !== shift.id ? 'Only sales from this shift can be voided' : undefined}>Void sale</button>
          </div>
        )
      ) : (
        <form className="step" onSubmit={(e) => { e.preventDefault(); void confirm() }}>
          <h3>{mode === 'void' ? `Void whole sale · ${peso(salePaid(sale))}` : 'Refund selected items'}</h3>
          {mode === 'refund' && (
            <div className="seg" role="radiogroup" aria-label="Refund paid back by">
              {(['cash', 'gcash', 'maya'] as const).map((m) => (
                <button type="button" key={m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>{m === 'cash' ? 'Cash' : m === 'gcash' ? 'GCash' : 'Maya'}</button>
              ))}
            </div>
          )}
          <label className="field"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong item, defective" /></label>
          <label className="field"><span>Owner or manager PIN</span>
            <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="button" className="btn" onClick={() => { setMode('view'); setError(undefined) }}>Cancel</button>
            <button className="btn primary" disabled={busy || pin.length < 4}>{mode === 'void' ? 'Void sale' : 'Refund'}</button>
          </div>
        </form>
      )}
    </div>
  )
}
