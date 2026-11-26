// Supabase connection. Stays null until web/.env has VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY,
// so the app keeps working (offline / demo) before the server is set up.
//
// Two separate sign-ins, kept apart on purpose:
//   supabase       - the back office (/admin): owner / manager email login
//   deviceClient   - the register: this tablet's own device account, approved for one branch.
//                    A cashier at the register is never signed in as the owner.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { OfflineError, type Remote } from './sync'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null
export const deviceClient: SupabaseClient | null = url && key
  ? createClient(url, key, { auth: { storageKey: 'docvape-device-auth' } })
  : null
export const isServerConfigured = () => supabase !== null

/** A throwaway sign-in (not saved), used when an owner approves a device on that device. */
export const tempClient = () => createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'docvape-temp-auth' } })

const offline = (msg?: string) => !navigator.onLine || !msg || /fetch|network|timed? ?out/i.test(msg)

export function supabaseRemote(c: SupabaseClient): Remote {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      const { data, error } = await c.rpc(fn, args)
      if (error) throw error.code ? new Error(error.message) : new OfflineError('No connection')
      return data as T
    },
    async upload(bucket, path, file) {
      const { error } = await c.storage.from(bucket).upload(path, file, { contentType: file.type || 'image/jpeg' })
      if (!error || /exists|duplicate/i.test(error.message)) return // already uploaded on an earlier try
      throw offline(error.message) ? new OfflineError('No connection') : new Error(error.message)
    },
    async select<T>(table: string, columns: string, filter: Record<string, string> = {}) {
      const rows: T[] = []
      for (let from = 0; ; from += 1000) { // the server returns at most 1000 rows per request
        let q = c.from(table).select(columns).range(from, from + 999)
        for (const [k, v] of Object.entries(filter)) q = q.eq(k, v)
        const { data, error } = await q
        if (error) throw error.code ? new Error(error.message) : new OfflineError('No connection')
        rows.push(...(data as T[]))
        if (data.length < 1000) return rows
      }
    },
  }
}
