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

// ---------- Cash in / out and expenses ----------
type Mode = 'in' | 'out' | 'expense'
export function CashMoveSheet({ shift, staff, onClose }: { shift: ShiftRow; staff: StaffRow; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('expense')
  const [kind, setKind] = useState<'cash' | 'non_cash'>('cash')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const moves = useLiveQuery(() => db.cashMoves.where('shiftId').equals(shift.id).toArray(), [shift.id]) ?? []
  const expenses = useLiveQuery(() => db.expenses.where('shiftId').equals(shift.id).toArray(), [shift.id]) ?? []
  const rows = [
    ...moves.map((m) => ({ id: m.id, at: m.createdAt, label: m.reason, tag: m.amountCentavos > 0 ? 'Cash in' : 'Cash out', amount: m.amountCentavos })),
    ...expenses.map((e) => ({ id: e.id, at: e.createdAt, label: e.name, tag: e.kind === 'cash' ? 'Expense · cash' : 'Expense · non-cash', amount: -e.amountCentavos })),
  ].sort((x, y) => y.at - x.at)

  async function save() {
    const c = toCentavos(amount) ?? 0
    try {
      if (mode === 'expense') {
        await db.addExpense({ branchId: shift.branchId, shiftId: shift.id, staffId: staff.id, name: reason, amountCentavos: c, kind })
      } else {
        await db.addCashMove(shift.id, staff.id, c * (mode === 'out' ? -1 : 1), reason)
      }
      setAmount(''); setReason(''); setError(undefined)
    } catch (e) { setError((e as Error).message) }
  }

  const placeholder = mode === 'in' ? 'e.g. added change fund' : mode === 'out' ? 'e.g. owner took cash' : 'e.g. water, supplies, electric bill'
  return (
    <div className="overlay" onClick={onClose}>
      <form className="drawer right" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="drawer-head"><h2>Cash &amp; expenses</h2><button type="button" className="icon" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="seg">
          <button type="button" className={mode === 'expense' ? 'on' : ''} onClick={() => setMode('expense')}>Expense</button>
          <button type="button" className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')}>Cash in</button>
          <button type="button" className={mode === 'out' ? 'on' : ''} onClick={() => setMode('out')}>Cash out</button>
        </div>
        {mode === 'expense' && (
          <div className="seg">
            <button type="button" className={kind === 'cash' ? 'on' : ''} onClick={() => setKind('cash')}>Paid from drawer</button>
            <button type="button" className={kind === 'non_cash' ? 'on' : ''} onClick={() => setKind('non_cash')}>Paid another way</button>
          </div>
        )}
        <label className="field"><span>Amount</span><input inputMode="decimal" placeholder="₱0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field"><span>{mode === 'expense' ? 'What for' : 'Reason'}</span><input placeholder={placeholder} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {mode === 'expense' && kind === 'non_cash' && <p className="muted">Bank, GCash or owner-paid. Counts in expenses and profit, not in the drawer.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary xl" type="submit">Save</button>
        {rows.length > 0 && (
          <section className="step">
            <h3>This shift</h3>
            <ul className="plain">
              {rows.map((r) => (
                <li key={r.id}><span>{r.label}<small> · {r.tag} · {fmtTime(r.at)}</small></span><b>{r.amount > 0 ? '+' : '−'}{peso(Math.abs(r.amount))}</b></li>
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
          <div><dt>Cash expenses</dt><dd>−{peso(summary.cashExpenseCentavos)}</dd></div>
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
          <div><dt>Expenses (cash / non-cash)</dt><dd>{peso(summary.cashExpenseCentavos)} / {peso(summary.nonCashExpenseCentavos)}</dd></div>
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
