// Cashier PIN login. Works offline (checks cached PIN hashes on the device).

import { useEffect, useState, type ReactNode } from 'react'
import { verifyPin } from '../data/auth'
import { db, type StaffRow } from '../data/localDb'

interface Props { branchName: string; onLogin: (s: StaffRow) => void; title?: string; submitLabel?: string; footer?: ReactNode }

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const

export function PinLogin({ branchName, onLogin, title = 'Enter your PIN', submitLabel = 'Log in', footer }: Props) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string>()
  const [checking, setChecking] = useState(false)

  async function submit(value = pin) {
    if (value.length < 4 || checking) return
    setChecking(true)
    const staff = await verifyPin(db, value)
    setChecking(false)
    if (staff) onLogin(staff)
    else { setError('Wrong PIN. Try again.'); setPin('') }
  }

  function press(k: (typeof KEYS)[number]) {
    setError(undefined)
    if (k === 'clear') return setPin('')
    if (k === 'back') return setPin((p) => p.slice(0, -1))
    setPin((p) => (p.length < 6 ? p + k : p))
  }

  // Physical keyboard support (useful on a PC or a tablet with a keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key as (typeof KEYS)[number])
      else if (e.key === 'Backspace') press('back')
      else if (e.key === 'Enter') void submit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="center-screen">
      <div className="card login">
        <span className="logo big"><img src="/logo.png" alt="DOCVAPE – Drip of Clouds" /></span>
        <p className="muted">{branchName}</p>
        <h2>{title}</h2>
        <div className="dots" aria-label={`${pin.length} digits entered`}>
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="keypad">
          {KEYS.map((k) => (
            <button key={k} type="button" className={k.length > 1 ? 'key fn' : 'key'} onClick={() => press(k)}
              aria-label={k === 'back' ? 'Delete' : k === 'clear' ? 'Clear' : k}>
              {k === 'back' ? '⌫' : k === 'clear' ? 'Clear' : k}
            </button>
          ))}
        </div>
        <button className="btn primary xl" disabled={pin.length < 4 || checking} onClick={() => void submit()}>
          {checking ? 'Checking…' : submitLabel}
        </button>
        {footer}
      </div>
    </div>
  )
}
