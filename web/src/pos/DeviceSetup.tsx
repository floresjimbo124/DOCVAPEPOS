// One-time setup of a tablet/phone for a branch. The owner (or that branch's manager) signs in
// here with their email; the device gets its own account bound to the chosen branch. The
// owner's sign-in is not kept on the device.

import { useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidPin } from '../data/auth'
import { db, type DeviceSettings } from '../data/localDb'
import { deviceClient, supabaseRemote, tempClient } from '../data/supabase'
import { pullAll } from '../data/sync'

interface Profile { staff_id: string; full_name: string; role: string; pin_set: boolean }
interface Branch { id: string; name: string }

export function DeviceSetup({ current, onDone, onDemo, onCancel }: {
  current?: DeviceSettings; onDone: (d: DeviceSettings) => void; onDemo?: () => void; onCancel?: () => void
}) {
  const [client] = useState<SupabaseClient>(() => tempClient())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [me, setMe] = useState<Profile>()
  const [branches, setBranches] = useState<Branch[]>([])
  const [branchId, setBranchId] = useState('')
  const [label, setLabel] = useState(current?.label && current.live ? current.label : 'Counter tablet')
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function signIn(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined)
    try {
      const { error: err } = await client.auth.signInWithPassword({ email: email.trim(), password })
      if (err) throw new Error(err.message === 'Invalid login credentials' ? 'Wrong email or password' : err.message)
      const { data: prof, error: e2 } = await client.rpc('my_profile')
      if (e2) throw new Error(e2.message)
      const p = (prof as Profile[])[0]
      if (!p || (p.role !== 'owner' && p.role !== 'manager')) {
        await client.auth.signOut()
        throw new Error('Only the owner or a branch manager can set up a device')
      }
      const { data: bs, error: e3 } = await client.from('branches').select('id,name').eq('is_active', true).order('name')
      if (e3) throw new Error(e3.message)
      setBranches(bs as Branch[]); setMe(p)
      const keep = (bs as Branch[]).find((b) => b.id === current?.branchId)
      setBranchId(keep?.id ?? (bs.length === 1 ? (bs as Branch[])[0].id : ''))
    } catch (x) { setError((x as Error).message) } finally { setBusy(false) }
  }

  async function finish(e: FormEvent) {
    e.preventDefault(); setError(undefined)
    if (!me) return
    if (!me.pin_set) {
      if (!isValidPin(pin)) return setError('Your PIN must be 4–6 digits')
      if (pin !== pin2) return setError('The two PINs don\'t match')
    }
    if (current?.live && (await db.pendingCount()) > 0) return setError('This device still has sales waiting to sync. Connect to the internet and wait for them to send first.')
    setBusy(true)
    try {
      if (!me.pin_set) {
        const { error: ep } = await client.rpc('set_staff_pin', { p_staff: me.staff_id, p_pin: pin })
        if (ep) throw new Error(ep.message)
      }
      let { data: { session } } = await deviceClient!.auth.getSession()
      if (!session) {
        const { data, error: ea } = await deviceClient!.auth.signInAnonymously()
        if (ea) throw new Error(/anonymous/i.test(ea.message)
          ? 'The server is not accepting devices yet. In Supabase, turn on "Allow anonymous sign-ins" (Authentication → Sign In / Providers).'
          : ea.message)
        session = data.session
      }
      const { error: er } = await client.rpc('register_device', { p_device: session!.user.id, p_branch: branchId, p_label: label })
      if (er) throw new Error(er.message)
      await client.auth.signOut()
      if (!current?.live) await db.eraseAll() // demo data must not mix with real sales
      const device = await pullAll(db, supabaseRemote(deviceClient!))
      if (!device) throw new Error('Setup did not finish. Try again.')
      onDone({ branchId: device.branch_id, branchName: device.branch_name, label: device.label, live: true })
    } catch (x) { setError((x as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="center-screen">
      {!me ? (
        <form className="card login" onSubmit={(e) => void signIn(e)}>
          <span className="logo big"><img src="/logo.png" alt="DOCVAPE – Drip of Clouds" /></span>
          <h2>Set up this device</h2>
          <p className="muted">The owner or the branch manager signs in once to connect this tablet or phone to a branch.</p>
          <label className="field"><span>Email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary xl" type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Continue'}</button>
          {onDemo && <button className="link" type="button" onClick={onDemo}>Try it with demo data instead</button>}
          {onCancel && <button className="link" type="button" onClick={onCancel}>Back</button>}
        </form>
      ) : (
        <form className="card" onSubmit={(e) => void finish(e)}>
          <h2>Which branch is this device at?</h2>
          <p className="muted">Signed in as {me.full_name}. You won't stay signed in on this device.</p>
          {branches.length === 0 && <p className="notice">No branches yet. Add one in the back office first.</p>}
          <div className="choices">
            {branches.map((b) => (
              <label key={b.id} className={b.id === branchId ? 'choice on' : 'choice'}>
                <input type="radio" name="branch" checked={b.id === branchId} onChange={() => setBranchId(b.id)} />{b.name}
              </label>
            ))}
          </div>
          <label className="field"><span>Device name</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Counter tablet" /></label>
          {!me.pin_set && <>
            <p className="notice">Choose your own PIN. You'll use it to log in at the register and approve voids and refunds.</p>
            <label className="field"><span>Your PIN (4–6 digits)</span><input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
            <label className="field"><span>PIN again</span><input type="password" inputMode="numeric" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} /></label>
          </>}
          {!current?.live && <p className="notice">Demo sales and items on this device will be erased.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary xl" type="submit" disabled={busy || !branchId || !label.trim()}>{busy ? 'Setting up…' : 'Finish setup'}</button>
        </form>
      )}
    </div>
  )
}
