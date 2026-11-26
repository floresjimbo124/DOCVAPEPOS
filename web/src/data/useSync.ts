// Keeps a live device in sync in the background: right away, every 30 seconds, when the
// internet comes back, and shortly after anything new is saved (a sale, a shift event).

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect } from 'react'
import { db } from './localDb'
import { deviceClient, supabaseRemote } from './supabase'
import { syncOnce } from './sync'

let running: Promise<unknown> | null = null
let again = false

/** Runs one sync round; if one is already running, runs another right after it. */
export function requestSync() {
  if (!deviceClient) return
  if (running) { again = true; return }
  running = syncOnce(db, supabaseRemote(deviceClient)).finally(() => {
    running = null
    if (again) { again = false; requestSync() }
  })
}

export function useSync(enabled: boolean) {
  const pending = useLiveQuery(() => db.pendingCount(), []) ?? 0

  useEffect(() => {
    if (!enabled) return
    requestSync()
    const timer = setInterval(requestSync, 30_000)
    window.addEventListener('online', requestSync)
    return () => { clearInterval(timer); window.removeEventListener('online', requestSync) }
  }, [enabled])

  useEffect(() => {
    if (!enabled || pending === 0) return
    const t = setTimeout(requestSync, 1500) // let a burst of saves settle first
    return () => clearTimeout(t)
  }, [enabled, pending])
}
