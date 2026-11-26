// Back-office pages. Plain tables and figures: simple, readable, no decoration.

import { useLiveQuery } from 'dexie-react-hooks'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { fmtHours, hoursWorked, type Punch } from '../domain/attendance'
import { peso } from '../domain/cart'
import { saleState } from '../domain/adjust'
import { byHour, byPaymentMethod, kpis, periodRange, saleTotal, topItems, type Period } from '../domain/reports'
import type { BackOfficeSource } from './source'

const dt = (ms: number | string) => new Date(ms).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString('en-PH', { hour: 'numeric' })
const METHOD = { cash: 'Cash', gcash: 'GCash', maya: 'Maya' } as const

/** Loads everything a page needs for the period; re-runs when local data changes. */
function useData(source: BackOfficeSource, period: Period) {
  return useLiveQuery(async () => {
    const [from, to] = periodRange(period)
    const [sales, expenses, punches, adjustments, staff, variants] = await Promise.all([
      source.sales(from, to), source.expenses(from, to), source.punches(from, to), source.adjustments(from, to), source.staff(), source.variants(),
    ])
    return { sales, expenses, punches, adjustments, staff, variants }
  }, [source, period])
}

const Empty = ({ text }: { text: string }) => <p className="empty-row">{text}</p>

export function DashboardPage({ source, period }: { source: BackOfficeSource; period: Period }) {
  const d = useData(source, period)
  if (!d) return null
  const costOf = (id: string) => d.variants.get(id)?.costCentavos ?? 0
  const k = kpis(d.sales, d.expenses, costOf, d.adjustments)
  const methods = byPaymentMethod(d.sales, d.adjustments)
  const hours = byHour(d.sales, d.adjustments).map((c, h) => ({ h, c })).filter((x) => x.c > 0).sort((a, b) => b.c - a.c).slice(0, 5)
  const top = topItems(d.sales, costOf, 10, d.adjustments)
  const cards: [string, string][] = [
    ['Net sales', peso(k.netSalesCentavos)], ['Transactions', String(k.transactions)], ['Average sale', peso(k.averageSaleCentavos)],
    ['Discounts', peso(k.discountCentavos)], ['Cost of goods', peso(k.cogsCentavos)], ['Gross profit', peso(k.grossProfitCentavos)],
    ['Expenses', peso(k.expenseCentavos)], ['Net profit', peso(k.netProfitCentavos)], ['Items sold', String(k.itemsSold)],
    ['Refunds', peso(k.refundCentavos)], ['Voided sales', String(k.voidCount)],
  ]
  return (
    <div className="admin-body">
      <div className="kpis">{cards.map(([l, v]) => <div key={l} className="kpi"><small>{l}</small><b>{v}</b></div>)}</div>
      <div className="cols">
        <section className="panel">
          <h2>Payment types</h2>
          <dl className="report">
            {(Object.keys(METHOD) as (keyof typeof METHOD)[]).map((m) => <div key={m}><dt>{METHOD[m]}</dt><dd>{peso(methods[m])}</dd></div>)}
          </dl>
        </section>
        <section className="panel">
          <h2>Busiest hours</h2>
          {hours.length ? <dl className="report">{hours.map((x) => <div key={x.h}><dt>{hourLabel(x.h)}</dt><dd>{peso(x.c)}</dd></div>)}</dl> : <Empty text="No sales yet." />}
        </section>
      </div>
      <section className="panel">
        <h2>Best sellers</h2>
        {top.length ? (
          <table className="table">
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Sales</th><th className="num">Profit</th></tr></thead>
            <tbody>{top.map((r) => {
              const v = d.variants.get(r.variantId)
              return <tr key={r.variantId}><td>{v?.name ?? 'Item'}<small> {v?.label}</small></td><td className="num">{r.quantity}</td>
                <td className="num">{peso(r.salesCentavos)}</td><td className="num">{peso(r.profitCentavos)}</td></tr>
            })}</tbody>
          </table>
        ) : <Empty text="No sales yet." />}
      </section>
    </div>
  )
}

export function TransactionsPage({ source, period }: { source: BackOfficeSource; period: Period }) {
  const d = useData(source, period)
  const [open, setOpen] = useState<string>()
  if (!d) return null
  const nameOf = (id: string) => d.staff.find((s) => s.id === id)?.fullName ?? '—'
  return (
    <div className="admin-body">
      <section className="panel">
        {d.sales.length ? (
          <table className="table">
            <thead><tr><th>Time</th><th>Receipt</th><th>Cashier</th><th>Payment</th><th>Status</th><th className="num">Items</th><th className="num">Total</th></tr></thead>
            <tbody>{d.sales.map((s) => (
              <Fragment key={s.id}>
                <tr className="clickable" onClick={() => setOpen(open === s.id ? undefined : s.id)}>
                  <td>{dt(s.client_created_at)}</td><td>{s.manual_receipt_no ?? '—'}</td><td>{nameOf(s.staff_id)}</td>
                  <td>{s.payments.map((p) => METHOD[p.method] + (p.reference_no ? ` (${p.reference_no})` : '')).join(' + ')}</td>
                  <td>{saleState(s, d.adjustments)}</td>
                  <td className="num">{s.items.reduce((a, i) => a + i.quantity, 0)}</td><td className="num">{peso(saleTotal(s))}</td>
                </tr>
                {open === s.id && (
                  <tr className="detail"><td colSpan={7}>
                    {s.items.map((i, n) => { const v = d.variants.get(i.variant_id); return <div key={n}>{i.quantity} × {v?.name} {v?.label}{i.serial_no ? ` · SN ${i.serial_no}` : ''} — ₱{i.unit_price}</div> })}
                    {s.discounts.map((x, n) => <div key={'d' + n}>Discount ({x.kind}{x.id_number ? `, ID ${x.id_number}` : ''}): −₱{x.amount}</div>)}
                    <div>Age check: {s.age_verified ? 'confirmed' : 'not confirmed'}</div>
                    {d.adjustments.filter((a) => a.saleId === s.id).map((a) => <div key={a.id}>{a.kind === 'void' ? 'Voided' : `Refunded ${peso(a.amountCentavos)} (${a.method})`} · {a.reason} · approved by {nameOf(a.approvedBy)}</div>)}
                  </td></tr>
                )}
              </Fragment>
            ))}</tbody>
          </table>
        ) : <Empty text="No transactions in this period." />}
      </section>
    </div>
  )
}

export function ExpensesPage({ source, period }: { source: BackOfficeSource; period: Period }) {
  const d = useData(source, period)
  if (!d) return null
  const nameOf = (id: string) => d.staff.find((s) => s.id === id)?.fullName ?? '—'
  const sum = (k: 'cash' | 'non_cash') => d.expenses.filter((e) => e.kind === k).reduce((a, e) => a + e.amountCentavos, 0)
  return (
    <div className="admin-body">
      <div className="kpis">
        <div className="kpi"><small>Paid from drawer</small><b>{peso(sum('cash'))}</b></div>
        <div className="kpi"><small>Paid another way</small><b>{peso(sum('non_cash'))}</b></div>
        <div className="kpi"><small>Total expenses</small><b>{peso(sum('cash') + sum('non_cash'))}</b></div>
      </div>
      <section className="panel">
        {d.expenses.length ? (
          <table className="table">
            <thead><tr><th>Time</th><th>What for</th><th>Paid</th><th>By</th><th className="num">Amount</th></tr></thead>
            <tbody>{d.expenses.map((e) => (
              <tr key={e.id}><td>{dt(e.createdAt)}</td><td>{e.name}</td><td>{e.kind === 'cash' ? 'From drawer' : 'Another way'}</td>
                <td>{nameOf(e.staffId)}</td><td className="num">{peso(e.amountCentavos)}</td></tr>
            ))}</tbody>
          </table>
        ) : <Empty text="No expenses in this period." />}
      </section>
    </div>
  )
}

function Thumb({ photo, src }: { photo?: Blob; src?: string }) {
  const local = useMemo(() => (photo ? URL.createObjectURL(photo) : undefined), [photo])
  const url = local ?? src
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  return url ? <img className="thumb" src={url} alt="Selfie" /> : <span className="thumb none">No photo</span>
}

export function AttendancePage({ source, period }: { source: BackOfficeSource; period: Period }) {
  const d = useData(source, period)
  if (!d) return null
  const nameOf = (id: string) => d.staff.find((s) => s.id === id)?.fullName ?? '—'
  const totals = hoursWorked(d.punches as Punch[])
  return (
    <div className="admin-body">
      <section className="panel">
        <h2>Hours worked</h2>
        {totals.length ? (
          <table className="table">
            <thead><tr><th>Staff</th><th>Status</th><th className="num">Hours</th></tr></thead>
            <tbody>{totals.map((t) => (
              <tr key={t.staffId}><td>{nameOf(t.staffId)}</td>
                <td>{t.clockedIn ? 'Working now' : 'Clocked out'}{t.missingOut ? ' · missed a clock-out' : ''}</td>
                <td className="num">{fmtHours(t.workedMs)}</td></tr>
            ))}</tbody>
          </table>
        ) : <Empty text="No clock-ins in this period." />}
      </section>
      <section className="panel">
        <h2>Clock-in log</h2>
        {d.punches.length ? (
          <table className="table">
            <thead><tr><th>Selfie</th><th>Staff</th><th>Clock</th><th>Time</th></tr></thead>
            <tbody>{d.punches.map((p) => (
              <tr key={p.id}><td><Thumb photo={p.photo} src={p.photoUrl} /></td><td>{nameOf(p.staffId)}</td>
                <td>{p.kind === 'in' ? 'In' : 'Out'}{p.noPhotoReason ? <small> · no photo ({p.noPhotoReason})</small> : null}</td><td>{dt(p.at)}</td></tr>
            ))}</tbody>
          </table>
        ) : <Empty text="No clock-ins in this period." />}
      </section>
    </div>
  )
}

const NEXT: Record<string, string> = {
  products: 'Add and edit products, flavors, nicotine strengths, prices and costs, favorites, DTI/FDA numbers; import from Excel.',
  inventory: 'Stock per branch, deliveries, stock-outs, transfers between branches, stock counts, low-stock and expiry alerts.',
  staff: 'Add staff, set roles (owner / manager / cashier), assign branches, reset PINs, deactivate staff who leave.',
  settings: 'Branches, GCash and Maya QR per branch, VAT setting, register devices.',
}
export function LockedPage({ page }: { page: string }) {
  return (
    <div className="admin-body">
      <section className="panel">
        <h2>Unlocked</h2>
        <p>Coming next: {NEXT[page]}</p>
        <p className="muted">These pages save to the server, so they are built together with the Supabase connection.</p>
      </section>
    </div>
  )
}
