// Shift screens: open shift (starting cash), cash in/out, close shift (count drawer) and Z-reading.

import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db, type ShiftRow, type StaffRow } from '../data/localDb'
import { peso } from '../domain/cart'
import { overShort, type ShiftSummary } from '../domain/shift'

const toCentavos = (s: string) => {
  const n = Number(s.replace(/,/g, '').trim())
  return s.trim() === '' || Number.isNaN(n) || n < 0 ? undefined : Math.round(n * 100)
}
const fmtTime = (ms?: number) => (ms ? new Date(ms).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—')

// ---------- Open shift ----------
export function OpenShift({ branchId, branchName, staff, onOpened, onLock }: {
  branchId: string; branchName: string; staff: StaffRow; onOpened: (s: ShiftRow) => void; onLock: () => void
}) {
  const [cash, setCash] = useState('')
  const [error, setError] = useState<string>()
  async function open() {
    const c = toCentavos(cash)
    if (c == null) return setError('Enter the cash in the drawer (0 if empty)')
    try { onOpened(await db.openShift(branchId, staff.id, c)) } catch (e) { setError((e as Error).message) }
  }
  return (
    <div className="center-screen">
      <form className="card" onSubmit={(e) => { e.preventDefault(); void open() }}>
        <p className="muted">{branchName} · {staff.fullName}</p>
        <h2>Open shift</h2>
        <label className="field"><span>Starting cash in drawer</span>
          <input autoFocus inputMode="decimal" placeholder="₱0.00" value={cash} onChange={(e) => { setCash(e.target.value); setError(undefined) }} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary xl" type="submit">Open shift</button>
        <button className="btn" type="button" onClick={onLock}>Not you? Log out</button>
      </form>
    </div>
  )
}

// ---------- Cash in / out ----------
export function CashMoveSheet({ shift, staff, onClose }: { shift: ShiftRow; staff: StaffRow; onClose: () => void }) {
  const [dir, setDir] = useState<'in' | 'out'>('out')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const moves = useLiveQuery(() => db.cashMoves.where('shiftId').equals(shift.id).reverse().sortBy('createdAt'), [shift.id]) ?? []

  async function save() {
    const c = toCentavos(amount)
    try {
      await db.addCashMove(shift.id, staff.id, (c ?? 0) * (dir === 'out' ? -1 : 1), reason)
      setAmount(''); setReason(''); setError(undefined)
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="drawer right" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="drawer-head"><h2>Cash in / out</h2><button type="button" className="icon" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="seg">
          <button type="button" className={dir === 'out' ? 'on' : ''} onClick={() => setDir('out')}>Cash out</button>
          <button type="button" className={dir === 'in' ? 'on' : ''} onClick={() => setDir('in')}>Cash in</button>
        </div>
        <label className="field"><span>Amount</span><input inputMode="decimal" placeholder="₱0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field"><span>Reason</span><input placeholder={dir === 'out' ? 'e.g. bought supplies' : 'e.g. added change fund'} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary xl" type="submit">Save</button>
        {moves.length > 0 && (
          <section className="step">
            <h3>This shift</h3>
            <ul className="plain">
              {moves.map((m) => (
                <li key={m.id}><span>{m.reason}<small> · {fmtTime(m.createdAt)}</small></span><b>{m.amountCentavos > 0 ? '+' : '−'}{peso(Math.abs(m.amountCentavos))}</b></li>
              ))}
            </ul>
          </section>
        )}
      </form>
    </div>
  )
}

// ---------- Close shift ----------
export function CloseShiftSheet({ shift, staff, onCancel, onClosed }: {
  shift: ShiftRow; staff: StaffRow; onCancel: () => void; onClosed: (r: { shift: ShiftRow; summary: ShiftSummary }) => void
}) {
  const summary = useLiveQuery(() => db.shiftSummary(shift), [shift])
  const [counted, setCounted] = useState('')
  const [error, setError] = useState<string>()
  const c = toCentavos(counted)

  async function close() {
    if (c == null) return setError('Count the cash in the drawer and enter the total')
    try { onClosed(await db.closeShift(shift.id, staff.id, c)) } catch (e) { setError((e as Error).message) }
  }

  if (!summary) return null
  const diff = c == null ? undefined : overShort(summary, c)
  return (
    <div className="overlay" onClick={onCancel}>
      <form className="drawer right" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void close() }}>
        <div className="drawer-head"><div><small>Opened {fmtTime(shift.openedAt)}</small><h2>Close shift</h2></div>
          <button type="button" className="icon" aria-label="Close" onClick={onCancel}>✕</button></div>
        <dl className="report">
          <div><dt>Starting cash</dt><dd>{peso(shift.startingCentavos)}</dd></div>
          <div><dt>Cash sales</dt><dd>{peso(summary.byMethod.cash)}</dd></div>
          <div><dt>Cash in</dt><dd>{peso(summary.cashInCentavos)}</dd></div>
          <div><dt>Cash out</dt><dd>−{peso(summary.cashOutCentavos)}</dd></div>
          <div className="strong"><dt>Expected in drawer</dt><dd>{peso(summary.expectedCashCentavos)}</dd></div>
        </dl>
        <label className="field"><span>Counted cash in drawer</span>
          <input autoFocus inputMode="decimal" placeholder="₱0.00" value={counted} onChange={(e) => { setCounted(e.target.value); setError(undefined) }} /></label>
        {diff != null && (
          <p className={diff === 0 ? 'balance ok' : 'balance off'}>
            {diff === 0 ? 'Drawer balances' : diff > 0 ? `Over by ${peso(diff)}` : `Short by ${peso(-diff)}`}
          </p>
        )}
        <p className="muted">GCash {peso(summary.byMethod.gcash)} · Maya {peso(summary.byMethod.maya)} — check these against the wallet history.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="drawer-foot"><button className="btn primary xl" type="submit">Close shift &amp; print Z-reading</button></div>
      </form>
    </div>
  )
}

// ---------- Z-reading ----------
export function ZReading({ branchName, shift, summary, staffName, onDone }: {
  branchName: string; shift: ShiftRow; summary: ShiftSummary; staffName: string; onDone: () => void
}) {
  const diff = (shift.countedCentavos ?? 0) - (shift.expectedCentavos ?? 0)
  return (
    <div className="center-screen">
      <div className="card zreport">
        <span className="logo big"><img src="/logo.png" alt="DOCVAPE" /></span>
        <h2>Z-reading #{shift.zNo}</h2>
        <p className="muted">{branchName} · closed by {staffName}<br />{fmtTime(shift.openedAt)} – {fmtTime(shift.closedAt)}</p>
        <dl className="report">
          <div><dt>Sales</dt><dd>{summary.saleCount}</dd></div>
          <div><dt>Gross sales</dt><dd>{peso(summary.grossCentavos)}</dd></div>
          <div><dt>Discounts{summary.seniorPwdCount ? ` (${summary.seniorPwdCount} Senior/PWD)` : ''}</dt><dd>−{peso(summary.discountCentavos)}</dd></div>
          <div className="strong"><dt>Net sales</dt><dd>{peso(summary.netCentavos)}</dd></div>
          <div><dt>Cash</dt><dd>{peso(summary.byMethod.cash)}</dd></div>
          <div><dt>GCash</dt><dd>{peso(summary.byMethod.gcash)}</dd></div>
          <div><dt>Maya</dt><dd>{peso(summary.byMethod.maya)}</dd></div>
          <div><dt>Receipts</dt><dd>{summary.firstReceiptNo ? `${summary.firstReceiptNo} – ${summary.lastReceiptNo}` : '—'}</dd></div>
          <div><dt>Expected cash</dt><dd>{peso(shift.expectedCentavos ?? 0)}</dd></div>
          <div><dt>Counted cash</dt><dd>{peso(shift.countedCentavos ?? 0)}</dd></div>
          <div className="strong"><dt>Over / short</dt><dd>{diff === 0 ? 'Balanced' : (diff > 0 ? '+' : '−') + peso(Math.abs(diff))}</dd></div>
        </dl>
        <div className="actions">
          <button className="btn" onClick={() => window.print()}>Print</button>
          <button className="btn primary" onClick={onDone}>Done</button>
        </div>
      </div>
    </div>
  )
}
