// Back office for owners and managers: email + password login (Supabase), then
// Dashboard / Transactions / Expenses / Attendance. Products, Inventory, Staff and
// Settings are also locked behind an owner/manager PIN.

import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { verifyApprover } from '../data/auth'
import { db } from '../data/localDb'
import { supabase } from '../data/supabase'
import type { Period } from '../domain/reports'
import { useTheme } from '../theme'
import { AttendancePage, DashboardPage, ExpensesPage, LockedPage, TransactionsPage } from './pages'
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

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (preview) return <Shell source={previewSource} who="Preview (this device's data)" onExit={() => setPreview(false)} />
  if (session) {
    return <ServerPending email={session.user.email ?? ''} onSignOut={() => void supabase?.auth.signOut()} />
  }
  return <Login onPreview={() => setPreview(true)} />
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

function ServerPending({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <div className="center-screen">
      <div className="card login">
        <h2>Signed in</h2>
        <p className="muted">{email}</p>
        <p className="notice">Reports for all branches will appear here once the registers start syncing to the server.</p>
        <button className="btn" onClick={onSignOut}>Log out</button>
      </div>
    </div>
  )
}

function Shell({ source, who, onExit }: { source: BackOfficeSource; who: string; onExit: () => void }) {
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
            <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle dark mode">{theme === 'dark' ? '☀' : '☾'}</button>
          </div>
        </header>
        {source.kind === 'preview' && <p className="notice">Preview: showing only sales and records saved on this device. All branches appear once the server is connected.</p>}
        {item.locked && !unlocked ? <PinLock onUnlock={() => setUnlocked(true)} /> :
          page === 'dashboard' ? <DashboardPage source={source} period={period} /> :
          page === 'transactions' ? <TransactionsPage source={source} period={period} /> :
          page === 'expenses' ? <ExpensesPage source={source} period={period} /> :
          page === 'attendance' ? <AttendancePage source={source} period={period} /> :
          <LockedPage page={page} />}
      </main>
    </div>
  )
}

function PinLock({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string>()
  async function check() {
    const who = await verifyApprover(db, pin)
    if (who) onUnlock()
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
