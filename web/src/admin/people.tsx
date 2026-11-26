// Staff and Settings (server, owner only).
// Staff: cashiers / managers, their PIN and the branches they work at.
// Settings: branches, and the tablets/phones set up as registers (switch off a lost one).
// Changes reach the registers on their next sync.

import type { SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import type { BranchRow } from './catalog'

type Role = 'owner' | 'manager' | 'cashier'
interface SStaff { id: string; full_name: string; role: Role; email: string | null; is_active: boolean; auth_user_id: string | null }
interface Link { staff_id: string; branch_id: string }
const ROLE: Record<Role, string> = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier' }

/** Loads with the owner's login; `version` reloads. */
function useServer<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string }>({})
  useEffect(() => {
    let live = true
    load().then((data) => live && setState({ data }), (e: Error) => live && setState({ error: e.message }))
    return () => { live = false }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps -- caller lists what the load depends on
  return state
}
const omit = <T,>(o: Record<string, T>, k: string) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k))
const must = <T,>(r: { data: T | null; error: { message: string } | null }) => { if (r.error) throw new Error(r.error.message); return r.data as T }

// ---------------- Staff ----------------

export function StaffPage({ client, isOwner }: { client: SupabaseClient; isOwner: boolean }) {
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState<SStaff | 'new'>()
  const { data, error } = useServer(async () => {
    const [s, l, b] = await Promise.all([
      client.from('staff').select('id,full_name,role,email,is_active,auth_user_id').order('full_name'),
      client.from('staff_branches').select('staff_id,branch_id'),
      client.from('branches').select('id,name').order('name'),
    ])
    return { staff: must<SStaff[]>(s), links: must<Link[]>(l), branches: must<BranchRow[]>(b) }
  }, [client, version])

  if (!isOwner) return <div className="admin-body"><p className="notice">Only the owner can manage staff.</p></div>
  if (error) return <div className="admin-body"><p className="error">{error}</p></div>
  if (!data) return <div className="admin-body"><p className="muted">Loading…</p></div>
  if (editing) {
    return <StaffEditor client={client} branches={data.branches} person={editing === 'new' ? undefined : editing}
      linked={editing === 'new' ? [] : data.links.filter((l) => l.staff_id === editing.id).map((l) => l.branch_id)}
      onClose={(changed) => { setEditing(undefined); if (changed) setVersion((v) => v + 1) }} />
  }
  const bname = new Map(data.branches.map((b) => [b.id, b.name]))
  return (
    <div className="admin-body">
      <div className="toolbar"><button className="btn primary" onClick={() => setEditing('new')}>+ Add staff</button></div>
      <section className="panel">
        <table className="table">
          <thead><tr><th>Name</th><th>Role</th><th>Branches</th><th>Back-office login</th><th></th></tr></thead>
          <tbody>{data.staff.map((s) => (
            <tr key={s.id} className={`clickable${s.is_active ? '' : ' dim'}`} onClick={() => setEditing(s)}>
              <td><b>{s.full_name}</b></td>
              <td>{ROLE[s.role]}</td>
              <td>{s.role === 'owner' ? 'All' : data.links.filter((l) => l.staff_id === s.id).map((l) => bname.get(l.branch_id)).join(', ') || <small className="tag">None</small>}</td>
              <td>{s.email ? <>{s.email}{!s.auth_user_id && <small className="tag">Not signed up</small>}</> : '—'}</td>
              <td>{s.is_active ? '' : <small className="tag off">Inactive</small>}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
    </div>
  )
}

function StaffEditor({ client, branches, person, linked, onClose }: {
  client: SupabaseClient; branches: BranchRow[]; person?: SStaff; linked: string[]; onClose: (changed: boolean) => void
}) {
  const isOwnerRow = person?.role === 'owner'
  const [name, setName] = useState(person?.full_name ?? '')
  const [role, setRole] = useState<Role>(person?.role ?? 'cashier')
  const [email, setEmail] = useState(person?.email ?? '')
  const [active, setActive] = useState(person?.is_active ?? true)
  const [at, setAt] = useState<Set<string>>(new Set(linked.length ? linked : branches.length === 1 ? [branches[0].id] : []))
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const digits = (v: string) => v.replace(/\D/g, '')

  async function save() {
    setError(undefined)
    if (!name.trim()) return setError('Enter the name')
    if (!isOwnerRow && at.size === 0) return setError('Pick at least one branch')
    if (!person && !/^[0-9]{4,6}$/.test(pin)) return setError('Give them a PIN (4–6 digits)')
    if (person && pin && !/^[0-9]{4,6}$/.test(pin)) return setError('The new PIN must be 4–6 digits')
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) return setError('That email doesn\'t look right')
    setBusy(true)
    try {
      const id = person?.id ?? crypto.randomUUID()
      const fields = { full_name: name.trim(), email: email.trim().toLowerCase() || null, is_active: active, ...(isOwnerRow ? {} : { role }) }
      const r = person
        ? await client.from('staff').update(fields).eq('id', id)
        : await client.from('staff').insert({ id, ...fields, role, pin_hash: 'not-set' })
      if (r.error) throw new Error(r.error.message.includes('staff_email_key') ? 'Another staff member already uses that email' : r.error.message)
      if (pin) must(await client.rpc('set_staff_pin', { p_staff: id, p_pin: pin }))
      if (!isOwnerRow) {
        const add = [...at].filter((b) => !linked.includes(b)).map((branch_id) => ({ staff_id: id, branch_id }))
        const remove = linked.filter((b) => !at.has(b))
        if (add.length) must(await client.from('staff_branches').insert(add))
        if (remove.length) must(await client.from('staff_branches').delete().eq('staff_id', id).in('branch_id', remove))
      }
      onClose(true)
    } catch (x) { setError((x as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="admin-body">
      <section className="panel editor">
        <h2>{person ? `Edit ${person.full_name}` : 'Add staff'}</h2>
        <div className="grid2">
          <label className="field"><span>Name *</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ana Santos" /></label>
          {isOwnerRow ? <label className="field"><span>Role</span><input value="Owner (all branches)" disabled /></label> : (
            <label className="field"><span>Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="cashier">Cashier – sells, opens/closes shifts</option>
                <option value="manager">Manager – also approves voids/refunds</option>
              </select>
            </label>
          )}
          <label className="field"><span>{person ? 'New PIN (leave empty to keep)' : 'PIN (4–6 digits) *'}</span>
            <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(digits(e.target.value))} /></label>
          <label className="field"><span>Email (only for back-office login)</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" /></label>
        </div>
        {!isOwnerRow && <>
          <h3>Works at</h3>
          <div className="choices">
            {branches.map((b) => (
              <label key={b.id} className={at.has(b.id) ? 'choice on' : 'choice'}>
                <input type="checkbox" checked={at.has(b.id)} onChange={(e) => setAt((s) => { const n = new Set(s); if (e.target.checked) n.add(b.id); else n.delete(b.id); return n })} />{b.name}
              </label>
            ))}
          </div>
        </>}
        {!isOwnerRow && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (untick when someone leaves — they can no longer log in)</label>}
        {role === 'manager' && email.trim() && !person?.auth_user_id && (
          <p className="notice">To let this manager open the back office: in Supabase go to Authentication → Users → Add user → Create new user with this same email and a password (tick "Auto Confirm User"). It links to this staff record by itself.</p>
        )}
        <p className="muted">PIN changes reach the registers within about 30 seconds when they're online.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </section>
    </div>
  )
}

// ---------------- Settings ----------------

interface SBranch { id: string; name: string; address: string | null; is_active: boolean }
interface SDevice { auth_user_id: string; branch_id: string; label: string; is_active: boolean; created_at: string }

export function SettingsPage({ client, isOwner }: { client: SupabaseClient; isOwner: boolean }) {
  const [version, setVersion] = useState(0)
  const [msg, setMsg] = useState<{ error?: boolean; text: string }>()
  const [newName, setNewName] = useState('')
  const [newAddr, setNewAddr] = useState('')
  const [edit, setEdit] = useState<Record<string, { name: string; address: string }>>({})
  const { data, error } = useServer(async () => {
    const [b, d] = await Promise.all([
      client.from('branches').select('id,name,address,is_active').order('name'),
      client.from('pos_devices').select('auth_user_id,branch_id,label,is_active,created_at').order('created_at'),
    ])
    return { branches: must<SBranch[]>(b), devices: must<SDevice[]>(d) }
  }, [client, version])

  if (!isOwner) return <div className="admin-body"><p className="notice">Only the owner can change settings.</p></div>
  if (error) return <div className="admin-body"><p className="error">{error}</p></div>
  if (!data) return <div className="admin-body"><p className="muted">Loading…</p></div>

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setMsg(undefined)
    const { error: e } = await fn()
    if (e) return setMsg({ error: true, text: e.message.includes('branches_name_key') ? 'A branch with that name already exists' : e.message })
    setMsg({ text: ok }); setVersion((v) => v + 1)
  }
  const bname = new Map(data.branches.map((b) => [b.id, b.name]))

  return (
    <div className="admin-body">
      <section className="panel">
        <h2>Branches</h2>
        <table className="table edit">
          <thead><tr><th>Name</th><th>Address</th><th>Status</th><th></th></tr></thead>
          <tbody>{data.branches.map((b) => {
            const e = edit[b.id]
            return (
              <tr key={b.id} className={b.is_active ? '' : 'dim'}>
                <td>{e ? <input value={e.name} onChange={(x) => setEdit({ ...edit, [b.id]: { ...e, name: x.target.value } })} /> : <b>{b.name}</b>}</td>
                <td>{e ? <input value={e.address} onChange={(x) => setEdit({ ...edit, [b.id]: { ...e, address: x.target.value } })} /> : b.address ?? '—'}</td>
                <td>{b.is_active ? 'Open' : 'Closed'}</td>
                <td className="row-actions">
                  {e ? <>
                    <button className="link" onClick={() => void run(() => client.from('branches').update({ name: e.name.trim(), address: e.address.trim() || null }).eq('id', b.id), 'Branch saved.').then(() => setEdit((x) => omit(x, b.id)))} disabled={!e.name.trim()}>Save</button>
                    <button className="link" onClick={() => setEdit((x) => omit(x, b.id))}>Cancel</button>
                  </> : <>
                    <button className="link" onClick={() => setEdit({ ...edit, [b.id]: { name: b.name, address: b.address ?? '' } })}>Edit</button>
                    <button className="link" onClick={() => void run(() => client.from('branches').update({ is_active: !b.is_active }).eq('id', b.id), b.is_active ? 'Branch closed.' : 'Branch reopened.')}>{b.is_active ? 'Close branch' : 'Reopen'}</button>
                  </>}
                </td>
              </tr>
            )
          })}</tbody>
        </table>
        <div className="toolbar">
          <input className="search-input" placeholder="New branch name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input className="search-input" placeholder="Address (optional)" value={newAddr} onChange={(e) => setNewAddr(e.target.value)} />
          <button className="btn primary" disabled={!newName.trim()} onClick={() => void run(() => client.from('branches').insert({ name: newName.trim(), address: newAddr.trim() || null }), 'Branch added.').then(() => { setNewName(''); setNewAddr('') })}>+ Add branch</button>
        </div>
      </section>

      <section className="panel">
        <h2>Registers (tablets &amp; phones)</h2>
        <p className="muted">Each device is set up once at the register screen ("Set up this device for a branch"). Switch off a lost or replaced device so it can no longer sell or see data.</p>
        {data.devices.length ? (
          <table className="table">
            <thead><tr><th>Device</th><th>Branch</th><th>Set up</th><th>Status</th><th></th></tr></thead>
            <tbody>{data.devices.map((d) => (
              <tr key={d.auth_user_id} className={d.is_active ? '' : 'dim'}>
                <td><b>{d.label}</b></td><td>{bname.get(d.branch_id) ?? '—'}</td>
                <td>{new Date(d.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                <td>{d.is_active ? 'On' : 'Switched off'}</td>
                <td><button className="link" onClick={() => void run(() => client.from('pos_devices').update({ is_active: !d.is_active }).eq('auth_user_id', d.auth_user_id), d.is_active ? 'Device switched off.' : 'Device switched on.')}>{d.is_active ? 'Switch off' : 'Switch on'}</button></td>
              </tr>
            ))}</tbody>
          </table>
        ) : <p className="empty-row">No devices set up yet.</p>}
      </section>
      {msg && <p className={msg.error ? 'error' : 'notice'} role="alert">{msg.text}</p>}
    </div>
  )
}
