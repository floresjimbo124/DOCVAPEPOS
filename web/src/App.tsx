// App flow: (device setup, first time only) -> PIN login -> open shift (if none) -> register.
// Lock returns to PIN login; closing the shift shows the Z-reading, then PIN login.
//
// A device is either "live" (approved for a real branch; syncs with the server) or "demo"
// (sample items on this device only, for trying the app).

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { DEMO_BRANCH, seedDemoIfEmpty, seedDemoStaffIfEmpty } from './data/demoSeed'
import { db, type DeviceSettings, type ShiftRow, type StaffRow } from './data/localDb'
import { isServerConfigured } from './data/supabase'
import { useSync } from './data/useSync'
import type { ShiftSummary } from './domain/shift'
import { Attendance } from './pos/Attendance'
import { DeviceSetup } from './pos/DeviceSetup'
import { PinLogin } from './pos/PinLogin'
import { Register } from './pos/Register'
import { OpenShift, ZReading } from './pos/Shift'

/** First screen on a device that isn't a register yet: who are you? */
function Welcome({ onSetup, onDemo }: { onSetup: () => void; onDemo?: () => void }) {
  return (
    <div className="center-screen">
      <div className="card login">
        <span className="logo big"><img src="/logo.png" alt="DOCVAPE – Drip of Clouds" /></span>
        <h2>Welcome</h2>
        <p className="muted">How do you want to use DOCVAPE POS on this device?</p>
        <a className="btn primary xl" href="/admin">Owner / Manager login</a>
        <button className="btn xl" onClick={onSetup}>Set up this tablet as a register</button>
        <p className="muted">Registers are set up once by the owner or branch manager. After that, cashiers log in here with their PIN.</p>
        {onDemo && <button className="link" onClick={onDemo}>Try it with demo data (testing only)</button>}
      </div>
    </div>
  )
}

async function startDemo() {
  await seedDemoIfEmpty(db)
  await seedDemoStaffIfEmpty(db)
  if (!(await db.getSetting('device'))) await db.setSetting('device', DEMO_BRANCH)
}

export default function App() {
  // { value } so "still loading" (undefined) differs from "not set up yet" ({ value: undefined }).
  const saved = useLiveQuery(async () => ({ value: await db.getSetting<DeviceSettings>('device') }), [])
  const device = saved?.value
  const [setup, setSetup] = useState(false)
  const [staff, setStaff] = useState<StaffRow>()
  const [shift, setShift] = useState<ShiftRow | null>() // undefined = loading, null = none open
  const [closed, setClosed] = useState<{ shift: ShiftRow; summary: ShiftSummary; by: string }>()
  const [clocking, setClocking] = useState(false)

  useSync(!!device?.live)

  // Without a server there is nothing to set up: go straight to demo data.
  useEffect(() => {
    if (saved && !saved.value && !isServerConfigured()) void startDemo()
  }, [saved])

  // After login, find this branch's open shift (it survives logouts and app restarts).
  useEffect(() => {
    if (!device || !staff) return
    void db.openShiftFor(device.branchId).then((s) => setShift(s ?? null))
  }, [device, staff])

  const lock = () => { setStaff(undefined); setShift(undefined) }

  if (!saved) return <p className="center-screen">Loading…</p>
  if (!device && !setup) {
    if (!isServerConfigured()) return <p className="center-screen">Loading…</p>
    return <Welcome onSetup={() => setSetup(true)} onDemo={import.meta.env.DEV ? () => void startDemo() : undefined} />
  }
  if (setup) {
    return <DeviceSetup current={device} onDone={() => { setSetup(false); lock() }} onCancel={() => setSetup(false)} />
  }
  if (!device) return <p className="center-screen">Loading…</p>
  if (closed) {
    return <ZReading branchName={device.branchName} shift={closed.shift} summary={closed.summary} staffName={closed.by}
      onDone={() => { setClosed(undefined); lock() }} />
  }
  if (clocking) return <Attendance branchId={device.branchId} branchName={device.branchName} onDone={() => setClocking(false)} />
  if (!staff) {
    return <PinLogin branchName={device.live ? device.branchName : `${device.branchName} · demo`} onLogin={setStaff}
      footer={<>
        <button className="btn" onClick={() => setClocking(true)}>Clock in / out</button>
        {isServerConfigured() && !device.live && <button className="link" onClick={() => setSetup(true)}>Set up this device for a branch</button>}
        <a className="link" href="/admin">Owner login</a>
      </>} />
  }
  if (shift === undefined) return <p className="center-screen">Loading…</p>
  if (shift === null) {
    return <OpenShift branchId={device.branchId} branchName={device.branchName} staff={staff} onOpened={setShift} onLock={lock} />
  }
  return (
    <Register device={device} staff={staff} shift={shift} onLock={lock}
      onShiftClosed={(r) => setClosed({ ...r, by: staff.fullName })} />
  )
}
