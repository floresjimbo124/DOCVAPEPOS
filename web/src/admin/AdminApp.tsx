// Back office for owners and managers: email + password login (Supabase), then
// Dashboard / Transactions / Expenses / Attendance. Products, Inventory, Staff and
// Settings are also locked behind an owner/manager PIN.

import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useMemo, useState } from 'react'
import { verifyApprover } from '../data/auth'
import { db } from '../data/localDb'
import { supabase } from '../data/supabase'
import type { Period } from '../domain/reports'
import { useTheme } from '../theme'
import { ErrorBox } from './ErrorBox'
import { InventoryPage, ProductsPage, type BranchRow } from './catalog'
import { SettingsPage, StaffPage } from './people'
import { AttendancePage, DashboardPage, ExpensesPage, LockedPage, TransactionsPage } from './pages'
import { serverSource } from './serverSource'
import { previewSource, type BackOfficeSource } from './source'

type Page = 'dashboard' | 'transactions' | 'expenses' | 'attendance' | 'products' | 'inventory' | 'staff' | 'settings'
const NAV: { id: Page; label: string; locked?: boolean }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'products', label: 'Products', locked: true },
  { id: 'inventory', label: 'Inventory', locked: true },
  { id: 'staff', label: 'Staff', locked: true },
  { id: 'settings', label: 'Settings', locked: true },
]

export function AdminApp() {
  const [session, setSession] = useState<Session | null>(null)
  const [preview, setPreview] = useState(false)
  // Arrived from an invitation or "forgot password" email: ask for a new password first.
  const [needsPassword, setNeedsPassword] = useState(() => /type=(invite|recovery)/.test(location.hash))

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  if (preview) {
    return <Shell source={previewSource} who="Preview (this device's data)" onExit={() => setPreview(false)}
      checkPin={async (pin) => !!(await verifyApprover(db, pin))} />
  }
  if (session && needsPassword) return <SetPassword email={session.user.email ?? ''} onDone={() => { setNeedsPassword(false); history.replaceState(null, '', '/admin') }} />
  if (session && supabase) return <Live client={supabase} email={session.user.email ?? ''} />
  return <Login onPreview={() => setPreview(true)} />
}

function SetPassword({ email, onDone }: { email: string; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  async function save() {
    if (pw.length < 8) return setError('Use at least 8 characters.')
    if (pw !== pw2) return setError('The two passwords do not match.')
    setBusy(true); setError(undefined)
    const { error } = await supabase!.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) setError(error.message); else onDone()
  }
  return (
    <div className="center-screen">
      <form className="card login" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <span className="logo big"><img src="/logo.png" alt="DOCVAPE – Drip of Clouds" /></span>
        <h2>Set your password</h2>
        <p className="muted">{email}</p>
        <label className="field"><span>New password</span><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <label className="field"><span>Type it again</span><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary xl" disabled={busy || !pw || !pw2}>{busy ? 'Saving…' : 'Save password'}</button>
      </form>
    </div>
  )
}

function Login({ onPreview }: { onPreview: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState<{ error?: boolean; text: string }>()
  const [busy, setBusy] = useState(false)

  async function signIn() {
    if (!supabase) return
    setBusy(true); setMsg(undefined)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (error) setMsg({ error: true, text: error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message })
  }
  async function forgot() {
    if (!supabase) return
    if (!email.trim()) return setMsg({ error: true, text: 'Enter your email first, then tap "Forgot password".' })
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}/admin` })
    setMsg(error ? { error: true, text: error.message } : { text: 'Check your email for a link to reset your password.' })
  }

  return (
    <div className="center-screen">
      <form className="card login" onSubmit={(e) => { e.preventDefault(); void signIn() }}>
        <span className="logo big"><img src="/logo.png" alt="DOCVAPE – Drip of Clouds" /></span>
        <h2>Owner login</h2>
        {!supabase && <p className="notice">Not connected to the server yet. Owner login starts working once the server is set up.</p>}
        <label className="field"><span>Email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!supabase} /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!supabase} /></label>
        {msg && <p className={msg.error ? 'error' : 'notice'} role="alert">{msg.text}</p>}
        <button className="btn primary xl" type="submit" disabled={!supabase || busy || !email || !password}>{busy ? 'Signing in…' : 'Log in'}</button>
        <button className="link" type="button" onClick={() => void forgot()} disabled={!supabase}>Forgot password</button>
        {!supabase && <button className="btn" type="button" onClick={onPreview}>Preview with this device's data</button>}
        <a className="link" href="/">← Back to register</a>
      </form>
    </div>
  )
}

interface Profile { staff_id: string; full_name: string; role: 'owner' | 'manager' | 'cashier'; pin_set: boolean }

/** Signed in: load who this is and which branches they can see, then show the back office. */
function Live({ client, email }: { client: SupabaseClient; email: string }) {
  const [me, setMe] = useState<Profile | null>()
  const [branches, setBranches] = useState<BranchRow[]>([])
  const [branchId, setBranchId] = useState<string | null>(null)
  const [version, setVersion] = useState(0) // bump to reload the reports
  const signOut = () => void client.auth.signOut()

  useEffect(() => {
    void (async () => {
      const [p, b] = await Promise.all([client.rpc('my_profile'), client.from('branches').select('id,name').eq('is_active', true).order('name')])
      setMe((p.data as Profile[] | null)?.[0] ?? null)
      setBranches((b.data as BranchRow[] | null) ?? [])
    })()
  }, [client])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version forces a fresh source (reload)
  const source = useMemo(() => serverSource(client, branchId), [client, branchId, version])

  if (me === undefined) return <p className="center-screen">Loading…</p>
  if (!me || me.role === 'cashier') {
    return (
      <div className="center-screen">
        <div className="card login">
          <h2>No back-office access</h2>
          <p className="muted">{email}</p>
          <p className="notice">This login isn't linked to an owner or manager. If you just signed up, confirm your email first, then log in again.</p>
          <button className="btn" onClick={signOut}>Log out</button>
        </div>
      </div>
    )
  }
  return (
    <Shell source={source} who={`${me.full_name} · ${me.role === 'owner' ? 'Owner' : 'Manager'}`} onExit={signOut}
      checkPin={async (pin) => (await client.rpc('check_my_pin', { p_pin: pin })).data === true}
      createPin={me.pin_set ? undefined : async (pin) => {
        const { error } = await client.rpc('set_staff_pin', { p_staff: me.staff_id, p_pin: pin })
        if (error) throw new Error(error.message)
        setMe({ ...me, pin_set: true })
      }}
      server={{ client, branches, branchId, setBranchId, isOwner: me.role === 'owner', reload: () => setVersion((v) => v + 1) }} />
  )
}

interface ServerCtx {
  client: SupabaseClient; branches: BranchRow[]; branchId: string | null; setBranchId: (id: string | null) => void
  isOwner: boolean; reload: () => void
}

function Shell({ source, who, onExit, checkPin, createPin, server }: {
  source: BackOfficeSource; who: string; onExit: () => void; checkPin: (pin: string) => Promise<boolean>
  createPin?: (pin: string) => Promise<void>; server?: ServerCtx
}) {
  const [page, setPage] = useState<Page>('dashboard')
  const [period, setPeriod] = useState<Period>('today')
  const [unlocked, setUnlocked] = useState(false) // owner/manager PIN entered this session
  const [theme, toggleTheme] = useTheme()
  const item = NAV.find((n) => n.id === page)!

  return (
    <div className="admin">
      <aside className="admin-nav">
        <span className="logo"><img src="/logo.png" alt="DOCVAPE" /></span>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={n.id === page ? 'on' : ''} onClick={() => setPage(n.id)}>
              {n.label}{n.locked && !unlocked && <small aria-label="PIN locked"> 🔒</small>}
            </button>
          ))}
        </nav>
        <div className="admin-foot">
          <small>{who}</small>
          <a className="link" href="/">Back to register</a>
          <button className="link" onClick={onExit}>Log out</button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-head">
          <h1>{item.label}</h1>
          <div className="status">
            {!item.locked ? (
              <div className="seg">
                {(['today', 'week', 'month'] as const).map((p) => (
                  <button key={p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>
                    {p === 'today' ? 'Today' : p === 'week' ? 'Last 7 days' : 'This month'}
                  </button>
                ))}
              </div>
            ) : null}
            {server && server.branches.length > 1 && (
              <select className="branch-pick" value={server.branchId ?? ''} onChange={(e) => server.setBranchId(e.target.value || null)} aria-label="Branch">
                <option value="">All branches</option>
                {server.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            )}
            {server && !item.locked && <button className="topbtn" onClick={server.reload}>Refresh</button>}
            <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle dark mode">{theme === 'dark' ? '☀' : '☾'}</button>
          </div>
        </header>
        {source.kind === 'preview' && <p className="notice">Preview: showing only sales and records saved on this device. All branches appear once the server is connected.</p>}
        <ErrorBox resetKey={page}>
        {item.locked && !unlocked ? createPin ? <CreatePin save={createPin} onDone={() => setUnlocked(true)} /> : <PinLock check={checkPin} onUnlock={() => setUnlocked(true)} /> :
          server && page === 'products' ? <ProductsPage client={server.client} isOwner={server.isOwner} /> :
          server && page === 'staff' ? <StaffPage client={server.client} isOwner={server.isOwner} /> :
          server && page === 'settings' ? <SettingsPage client={server.client} isOwner={server.isOwner} /> :
          server && page === 'inventory' ? <InventoryPage client={server.client} branches={server.branches} branchId={server.branchId} /> :
          page === 'dashboard' ? <DashboardPage source={source} period={period} /> :
          page === 'transactions' ? <TransactionsPage source={source} period={period} /> :
          page === 'expenses' ? <ExpensesPage source={source} period={period} /> :
          page === 'attendance' ? <AttendancePage source={source} period={period} /> :
          <LockedPage page={page} />}
        </ErrorBox>
      </main>
    </div>
  )
}

/** First time: the owner/manager has no PIN yet, so they choose one here. */
function CreatePin({ save, onDone }: { save: (pin: string) => Promise<void>; onDone: () => void }) {
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  async function submit() {
    if (!/^[0-9]{4,6}$/.test(pin)) return setError('Your PIN must be 4–6 digits.')
    if (pin !== pin2) return setError("The two PINs don't match.")
    setBusy(true)
    try { await save(pin); onDone() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const digits = (v: string) => v.replace(/\D/g, '')
  return (
    <form className="card pinlock" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <h2>🔒 Create your PIN</h2>
      <p className="muted">You'll use this PIN to open these pages, to log in at the register and to approve voids and refunds. 6 digits is safest.</p>
      <label className="field"><span>New PIN (4–6 digits)</span>
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => { setPin(digits(e.target.value)); setError(undefined) }} /></label>
      <label className="field"><span>PIN again</span>
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin2} onChange={(e) => { setPin2(digits(e.target.value)); setError(undefined) }} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary xl" disabled={busy || pin.length < 4 || pin2.length < 4}>{busy ? 'Saving…' : 'Save PIN and unlock'}</button>
    </form>
  )
}

function PinLock({ check: verify, onUnlock }: { check: (pin: string) => Promise<boolean>; onUnlock: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string>()
  async function check() {
    if (await verify(pin)) onUnlock()
    else { setError('PIN not accepted. Only an owner or manager PIN unlocks this page.'); setPin('') }
  }
  return (
    <form className="card pinlock" onSubmit={(e) => { e.preventDefault(); void check() }}>
      <h2>🔒 Enter owner or manager PIN</h2>
      <p className="muted">Products, inventory, staff and settings are protected so prices and staff can't be changed without a PIN.</p>
      <label className="field"><span>PIN</span>
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setError(undefined) }} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary xl" disabled={pin.length < 4}>Unlock</button>
    </form>
  )
}
