// Runs one SQL file against the database in DATABASE_URL (never stored in the repo).
// Usage:  DATABASE_URL="postgresql://..." node run-sql.mjs path/to/file.sql
import pg from 'pg'
import { readFileSync } from 'fs'
const url = process.env.DATABASE_URL
if (!url) { console.error('Set DATABASE_URL'); process.exit(1) }
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()
try {
  const res = await client.query(readFileSync(process.argv[2], 'utf8'))
  for (const r of [res].flat()) if (r.rows?.length) console.table(r.rows)
} finally { await client.end() }
