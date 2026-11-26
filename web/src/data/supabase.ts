// Supabase connection. Stays null until web/.env has VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY,
// so the app keeps working (offline / preview) before the server is set up.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null
export const isServerConfigured = () => supabase !== null
