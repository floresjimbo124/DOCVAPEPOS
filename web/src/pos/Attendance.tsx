// Staff attendance: PIN -> selfie -> clock in / out. Shows today's hours for the branch.

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { db, type StaffRow } from '../data/localDb'
import { fmtHours, hoursWorked, nextPunchKind } from '../domain/attendance'
import { PinLogin } from './PinLogin'

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
const time = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }) : '—')

export function Attendance({ branchId, branchName, onDone }: { branchId: string; branchName: string; onDone: () => void }) {
  const [staff, setStaff] = useState<StaffRow>()
  const [done, setDone] = useState<string>()
  const today = useLiveQuery(() => db.punchesBetween(branchId, startOfToday(), Date.now() + 60_000), [branchId, done]) ?? []
  const names = useLiveQuery(() => db.staff.toArray(), []) ?? []
  const nameOf = (id: string) => names.find((s) => s.id === id)?.fullName ?? 'Staff'

  const todayList = (
    <section className="today">
      <h3 className="section">Today</h3>
      {today.length === 0 ? <p className="muted">No one has clocked in yet.</p> : (
        <ul className="plain">
          {hoursWorked(today).map((h) => (
            <li key={h.staffId}>
              <span>{nameOf(h.staffId)}<small> · in {time(h.firstIn)}{h.clockedIn ? ' · working now' : ` · out ${time(h.lastOut)}`}{h.missingOut ? ' · missed a clock-out' : ''}</small></span>
              <b>{fmtHours(h.workedMs)}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  if (done) {
    return (
      <div className="center-screen">
        <div className="card login">
          <h2>{done}</h2>
          <button className="btn primary xl" onClick={onDone}>Back</button>
          {todayList}
        </div>
      </div>
    )
  }
  if (!staff) {
    return <PinLogin branchName={branchName} title="Clock in / out" submitLabel="Next" onLogin={setStaff}
      footer={<><button className="btn" onClick={onDone}>Cancel</button>{todayList}</>} />
  }
  return <Selfie staff={staff} kind={nextPunchKind(today, staff.id)} onCancel={onDone}
    onSave={async (photo, noPhotoReason) => {
      const kind = nextPunchKind(today, staff.id)
      await db.recordPunch({ staffId: staff.id, branchId, kind, photo, noPhotoReason })
      setDone(`${staff.fullName} clocked ${kind} at ${time(Date.now())}`)
    }} />
}

function Selfie({ staff, kind, onSave, onCancel }: {
  staff: StaffRow; kind: 'in' | 'out'; onSave: (photo?: Blob, noPhotoReason?: string) => Promise<void>; onCancel: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [photo, setPhoto] = useState<Blob>()
  const [camFailure, setCamFailure] = useState<string>()
  const supported = !!navigator.mediaDevices?.getUserMedia
  const camError = supported ? camFailure : 'This browser cannot use the camera'
  const [saving, setSaving] = useState(false)
  const preview = useMemo(() => (photo ? URL.createObjectURL(photo) : undefined), [photo])

  useEffect(() => {
    let stream: MediaStream | undefined
    if (!supported) return
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640 } })
      .then((s) => { stream = s; if (video.current) video.current.srcObject = s })
      .catch((e: Error) => setCamFailure(e.name === 'NotAllowedError' ? 'Camera permission was denied' : 'No camera available'))
    return () => stream?.getTracks().forEach((t) => t.stop())
  }, [photo, supported])

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  function capture() {
    const v = video.current
    if (!v || !v.videoWidth) return
    const c = document.createElement('canvas')
    c.width = 480; c.height = Math.round((480 * v.videoHeight) / v.videoWidth)
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    c.toBlob((b) => b && setPhoto(b), 'image/jpeg', 0.7)
  }

  async function save(noPhotoReason?: string) {
    setSaving(true)
    try { await onSave(photo, noPhotoReason) } finally { setSaving(false) }
  }

  return (
    <div className="center-screen">
      <div className="card login">
        <p className="muted">{staff.fullName}</p>
        <h2>Selfie to clock {kind}</h2>
        {camError ? (
          <>
            <p className="error" role="alert">{camError}. Clock {kind} without a photo? A manager will see that it has no photo.</p>
            <button className="btn primary xl" disabled={saving} onClick={() => void save(camError)}>Clock {kind} without photo</button>
          </>
        ) : photo ? (
          <>
            <img className="selfie" src={preview} alt="Your selfie" />
            <button className="btn primary xl" disabled={saving} onClick={() => void save()}>Clock {kind}</button>
            <button className="btn" onClick={() => setPhoto(undefined)}>Retake</button>
          </>
        ) : (
          <>
            <video className="selfie" ref={video} autoPlay playsInline muted />
            <button className="btn primary xl" onClick={capture}>Take photo</button>
          </>
        )}
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
