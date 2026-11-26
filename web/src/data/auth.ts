// Offline PIN login. Staff PINs are cached on the device only as bcrypt hashes
// (the same format the server stores), so login works without internet.

import bcrypt from 'bcryptjs'
import type { LocalDb, Role, StaffRow } from './localDb'

export const isValidPin = (pin: string) => /^[0-9]{4,6}$/.test(pin)

/** Returns the active staff member whose PIN matches, or undefined. */
export async function verifyPin(db: LocalDb, pin: string): Promise<StaffRow | undefined> {
  if (!isValidPin(pin)) return undefined
  for (const s of await db.staff.toArray()) {
    if (s.isActive && s.pinHash.startsWith('$2') && (await bcrypt.compare(pin, s.pinHash))) return s
  }
  return undefined
}

/** Owner or manager PIN, for approvals (voids, refunds). */
export async function verifyApprover(db: LocalDb, pin: string): Promise<StaffRow | undefined> {
  const s = await verifyPin(db, pin)
  return s && (s.role === 'owner' || s.role === 'manager') ? s : undefined
}

export const hashPin = (pin: string) => bcrypt.hash(pin, 6) // pgcrypto gen_salt('bf') default cost

export const canManage = (role: Role) => role === 'owner' || role === 'manager'
