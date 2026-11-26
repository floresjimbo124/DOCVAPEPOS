// App flow: PIN login -> open shift (if none) -> register.
// Lock returns to PIN login; closing the shift shows the Z-reading, then PIN login.

import { useEffect, useState } from 'react'
import { DEMO_BRANCH, seedDemoIfEmpty, seedDemoStaffIfEmpty } from './data/demoSeed'
import { db, type DeviceSettings, type ShiftRow, type StaffRow } from './data/localDb'
import type { ShiftSummary } from './domain/shift'
import { PinLogin } from './pos/PinLogin'
import { Register } from './pos/Register'
import { OpenShift, ZReading } from './pos/Shift'

export default function App() {
  const [device, setDevice] = useState<DeviceSettings>()
  const [staff, setStaff] = useState<StaffRow>()
  const [shift, setShift] = useState<ShiftRow | null>() // undefined = loading, null = none open
  const [closed, setClosed] = useState<{ shift: ShiftRow; summary: ShiftSummary; by: string }>()

  useEffect(() => {
    void (async () => {
      await seedDemoIfEmpty(db)
      await seedDemoStaffIfEmpty(db)
      // Placeholder until device sign-in exists: every device is the demo branch.
      setDevice((await db.getSetting<DeviceSettings>('device')) ?? DEMO_BRANCH)
    })()
  }, [])

  // After login, find this branch's open shift (it survives logouts and app restarts).
  useEffect(() => {
    if (!device || !staff) return
    void db.openShiftFor(device.branchId).then((s) => setShift(s ?? null))
  }, [device, staff])

  const lock = () => { setStaff(undefined); setShift(undefined) }

  if (!device) return <p className="center-screen">Loading…</p>
  if (closed) {
    return <ZReading branchName={device.branchName} shift={closed.shift} summary={closed.summary} staffName={closed.by}
      onDone={() => { setClosed(undefined); lock() }} />
  }
  if (!staff) return <PinLogin branchName={device.branchName} onLogin={setStaff} />
  if (shift === undefined) return <p className="center-screen">Loading…</p>
  if (shift === null) {
    return <OpenShift branchId={device.branchId} branchName={device.branchName} staff={staff} onOpened={setShift} onLock={lock} />
  }
  return (
    <Register device={device} staff={staff} shift={shift} onLock={lock}
      onShiftClosed={(r) => setClosed({ ...r, by: staff.fullName })} />
  )
}
