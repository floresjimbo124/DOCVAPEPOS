import { useEffect, useState } from 'react'
import { seedDemoIfEmpty } from './data/demoSeed'
import { db } from './data/localDb'
import { Register } from './pos/Register'

export default function App() {
  const [ready, setReady] = useState(false)
  useEffect(() => { void seedDemoIfEmpty(db).then(() => setReady(true)) }, [])
  if (!ready) return <p>Loading…</p>
  // Placeholder ids until device sign-in, PIN login and shifts are built.
  return <Register branchId="demo-branch" shiftId="demo-shift" staffId="demo-staff" />
}
