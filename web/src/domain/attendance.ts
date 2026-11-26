// Staff attendance: clock in / clock out punches (with a selfie) and hours worked.

export interface Punch {
  id: string
  staffId: string
  branchId: string
  kind: 'in' | 'out'
  at: number // epoch ms
  photo?: Blob // selfie; missing only when the device has no usable camera
  noPhotoReason?: string
}

export interface StaffHours {
  staffId: string
  workedMs: number
  clockedIn: boolean // currently clocked in
  firstIn?: number
  lastOut?: number
  missingOut: boolean // an "in" with no "out" before the next "in" (forgot to clock out)
}

/** Pairs each "in" with the next "out" per staff member. An open "in" counts up to `now`. */
export function hoursWorked(punches: Punch[], now = Date.now()): StaffHours[] {
  const byStaff = new Map<string, Punch[]>()
  for (const p of [...punches].sort((a, b) => a.at - b.at)) {
    byStaff.set(p.staffId, [...(byStaff.get(p.staffId) ?? []), p])
  }
  return [...byStaff].map(([staffId, list]) => {
    let worked = 0, openIn: number | undefined, missingOut = false, firstIn: number | undefined, lastOut: number | undefined
    for (const p of list) {
      if (p.kind === 'in') {
        if (openIn != null) missingOut = true // previous shift never clocked out: don't count it
        openIn = p.at
        firstIn ??= p.at
      } else if (openIn != null) {
        worked += p.at - openIn
        openIn = undefined
        lastOut = p.at
      }
    }
    if (openIn != null) worked += Math.max(0, now - openIn)
    return { staffId, workedMs: worked, clockedIn: openIn != null, firstIn, lastOut, missingOut }
  })
}

/** Next punch for this person: "out" if they're clocked in, otherwise "in". */
export function nextPunchKind(punches: Punch[], staffId: string): Punch['kind'] {
  const last = punches.filter((p) => p.staffId === staffId).sort((a, b) => b.at - a.at)[0]
  return last?.kind === 'in' ? 'out' : 'in'
}

export const fmtHours = (ms: number) => {
  const m = Math.round(ms / 60000)
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
