// Products and Inventory (server). Products: owner adds/edits items and their flavors,
// strengths and prices. Inventory: record deliveries and shelf counts per branch.
// Changes reach every register on its next sync (within about 30 seconds when online).

import type { SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useMemo, useState } from 'react'
import { variantLabel } from '../data/localDb'
import { peso } from '../domain/cart'

interface SVariant { id: string; flavor: string | null; nicotine_mg: number | null; size_ml: number | null; color: string | null; price: number; cost: number; is_active: boolean }
interface SProduct { id: string; name: string; brand: string | null; category_id: string | null; is_device: boolean; is_active: boolean; variants: SVariant[] }
interface SCategory { id: string; name: string; sort_order: number }
export interface BranchRow { id: string; name: string }

const label = (v: SVariant) => variantLabel({ flavor: v.flavor ?? undefined, nicotineMg: v.nicotine_mg ?? undefined, sizeMl: v.size_ml ?? undefined, color: v.color ?? undefined } as never)
const cents = (x: number | string) => Math.round(Number(x) * 100)

async function fetchCatalog(c: SupabaseClient) {
  const [p, k] = await Promise.all([
    c.from('products').select('id,name,brand,category_id,is_device,is_active,variants(id,flavor,nicotine_mg,size_ml,color,price,cost,is_active)').order('name'),
    c.from('categories').select('id,name,sort_order').order('sort_order').order('name'),
  ])
  if (p.error || k.error) throw new Error((p.error ?? k.error)!.message)
  return { products: p.data as SProduct[], categories: k.data as SCategory[] }
}

function useCatalog(c: SupabaseClient) {
  const [state, setState] = useState<{ data?: Awaited<ReturnType<typeof fetchCatalog>>; error?: string }>({})
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    fetchCatalog(c).then((data) => live && setState({ data }), (e: Error) => live && setState({ error: e.message }))
    return () => { live = false }
  }, [c, version])
  return { ...state, reload: () => setVersion((v) => v + 1) }
}

// ---------------- Products ----------------

export function ProductsPage({ client, isOwner }: { client: SupabaseClient; isOwner: boolean }) {
  const { data, error, reload } = useCatalog(client)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<SProduct | 'new'>()
  const cat = useMemo(() => new Map(data?.categories.map((k) => [k.id, k.name])), [data])

  if (error) return <div className="admin-body"><p className="error">{error}</p></div>
  if (!data) return <div className="admin-body"><p className="muted">Loading…</p></div>
  if (editing) {
    return <ProductEditor client={client} categories={data.categories} product={editing === 'new' ? undefined : editing}
      onClose={(changed) => { setEditing(undefined); if (changed) void reload() }} />
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const rows = data.products.filter((p) => {
    const hay = [p.name, p.brand, cat.get(p.category_id ?? ''), ...p.variants.map(label)].join(' ').toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  return (
    <div className="admin-body">
      <div className="toolbar">
        <input className="search-input" placeholder="Search products, flavors…" value={q} onChange={(e) => setQ(e.target.value)} />
        {isOwner && <button className="btn primary" onClick={() => setEditing('new')}>+ Add product</button>}
      </div>
      {!isOwner && <p className="notice">Only the owner can add or change products and prices.</p>}
      <section className="panel">
        {rows.length ? (
          <table className="table">
            <thead><tr><th>Product</th><th>Category</th><th>Flavors / options</th><th>Price</th><th></th></tr></thead>
            <tbody>{rows.map((p) => {
              const active = p.variants.filter((v) => v.is_active)
              const prices = active.map((v) => cents(v.price))
              const lo = Math.min(...prices), hi = Math.max(...prices)
              return (
                <tr key={p.id} className={isOwner ? 'clickable' : ''} onClick={() => isOwner && setEditing(p)}>
                  <td><b>{p.name}</b>{p.brand && <small className="muted"> · {p.brand}</small>}{p.is_device && <small className="tag">Device</small>}</td>
                  <td>{cat.get(p.category_id ?? '') ?? '—'}</td>
                  <td>{active.length}</td>
                  <td>{prices.length ? (lo === hi ? peso(lo) : `${peso(lo)} – ${peso(hi)}`) : '—'}</td>
                  <td>{p.is_active ? '' : <small className="tag off">Hidden</small>}</td>
                </tr>
              )
            })}</tbody>
          </table>
        ) : <p className="empty-row">{data.products.length ? 'No products match.' : 'No products yet. Tap "Add product" to add the first one.'}</p>}
      </section>
    </div>
  )
}

interface VRow { id: string; isNew: boolean; flavor: string; nic: string; size: string; color: string; price: string; cost: string; active: boolean }
const toRow = (v: SVariant): VRow => ({ id: v.id, isNew: false, flavor: v.flavor ?? '', nic: v.nicotine_mg?.toString() ?? '', size: v.size_ml?.toString() ?? '',
  color: v.color ?? '', price: Number(v.price).toFixed(2), cost: Number(v.cost).toFixed(2), active: v.is_active })
const blank = (): VRow => ({ id: crypto.randomUUID(), isNew: true, flavor: '', nic: '', size: '', color: '', price: '', cost: '', active: true })
const num = (s: string) => (s.trim() === '' ? null : Number(s))

function ProductEditor({ client, categories, product, onClose }: {
  client: SupabaseClient; categories: SCategory[]; product?: SProduct; onClose: (changed: boolean) => void
}) {
  const [name, setName] = useState(product?.name ?? '')
  const [brand, setBrand] = useState(product?.brand ?? '')
  const [categoryId, setCategoryId] = useState(product?.category_id ?? categories[0]?.id ?? '__new')
  const [newCat, setNewCat] = useState('')
  const [isDevice, setIsDevice] = useState(product?.is_device ?? false)
  const [active, setActive] = useState(product?.is_active ?? true)
  const [rows, setRows] = useState<VRow[]>(product?.variants.map(toRow) ?? [blank()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const set = (i: number, patch: Partial<VRow>) => setRows((r) => r.map((x, n) => (n === i ? { ...x, ...patch } : x)))

  async function save() {
    setError(undefined)
    if (!name.trim()) return setError('Enter the product name')
    if (categoryId === '__new' && !newCat.trim()) return setError('Enter the new category name')
    if (!rows.length) return setError('Add at least one flavor / option')
    for (const r of rows) {
      if (r.price.trim() === '' || !(Number(r.price) >= 0)) return setError('Every option needs a price')
      if ([r.nic, r.size, r.cost].some((x) => x.trim() !== '' && !(Number(x) >= 0))) return setError('Numbers only for mg, ml and cost')
    }
    setBusy(true)
    try {
      let catId: string | null = categoryId || null
      if (categoryId === '__new') {
        const ins = await client.from('categories').insert({ name: newCat.trim(), sort_order: categories.length + 1 }).select('id').single()
        if (ins.error) throw new Error(ins.error.message.includes('duplicate') ? 'That category already exists' : ins.error.message)
        catId = ins.data.id
      }
      const id = product?.id ?? crypto.randomUUID()
      const p = await client.from('products').upsert({ id, name: name.trim(), brand: brand.trim() || null, category_id: catId, is_device: isDevice, is_active: active })
      if (p.error) throw new Error(p.error.message)
      const v = await client.from('variants').upsert(rows.map((r) => ({
        id: r.id, product_id: id, flavor: r.flavor.trim() || null, nicotine_mg: num(r.nic), size_ml: num(r.size), color: r.color.trim() || null,
        price: Number(r.price), cost: num(r.cost) ?? 0, is_active: r.active,
      })))
      if (v.error) throw new Error(v.error.message)
      onClose(true)
    } catch (x) { setError((x as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="admin-body">
      <section className="panel editor">
        <h2>{product ? 'Edit product' : 'Add product'}</h2>
        <div className="grid2">
          <label className="field"><span>Product name *</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Salt Nic 30ml" /></label>
          <label className="field"><span>Brand</span><input value={brand} onChange={(e) => setBrand(e.target.value)} /></label>
          <label className="field"><span>Category</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              <option value="__new">+ New category…</option>
            </select>
          </label>
          {categoryId === '__new' && <label className="field"><span>New category name</span><input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="e.g. Pods" /></label>}
        </div>
        <label className="check"><input type="checkbox" checked={isDevice} onChange={(e) => setIsDevice(e.target.checked)} /> Device (cashier must enter the serial number)</label>
        <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Show at the register</label>

        <h3>Flavors / options</h3>
        <p className="muted">One row for each thing the cashier can pick. Leave a box empty if it doesn't apply.</p>
        <div className="table-wrap">
          <table className="table edit">
            <thead><tr><th>Flavor</th><th>Nicotine mg</th><th>Size ml</th><th>Color</th><th>Price ₱ *</th><th>Cost ₱</th><th>Sell</th><th></th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={r.id} className={r.active ? '' : 'dim'}>
                <td><input value={r.flavor} onChange={(e) => set(i, { flavor: e.target.value })} placeholder="Mango" /></td>
                <td><input inputMode="decimal" value={r.nic} onChange={(e) => set(i, { nic: e.target.value })} placeholder="30" /></td>
                <td><input inputMode="decimal" value={r.size} onChange={(e) => set(i, { size: e.target.value })} placeholder="30" /></td>
                <td><input value={r.color} onChange={(e) => set(i, { color: e.target.value })} /></td>
                <td><input inputMode="decimal" value={r.price} onChange={(e) => set(i, { price: e.target.value })} placeholder="350" /></td>
                <td><input inputMode="decimal" value={r.cost} onChange={(e) => set(i, { cost: e.target.value })} placeholder="200" /></td>
                <td><input type="checkbox" checked={r.active} onChange={(e) => set(i, { active: e.target.checked })} aria-label="Sell this option" /></td>
                <td>{r.isNew && <button className="link" onClick={() => setRows((x) => x.filter((_, n) => n !== i))}>Remove</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <button className="btn" onClick={() => setRows((r) => [...r, { ...blank(), nic: r.at(-1)?.nic ?? '', size: r.at(-1)?.size ?? '', price: r.at(-1)?.price ?? '', cost: r.at(-1)?.cost ?? '' }])}>+ Add option</button>
        <p className="muted">Options that were already sold can't be deleted; untick "Sell" to stop selling them.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </section>
    </div>
  )
}

// ---------------- Inventory ----------------

export function InventoryPage({ client, branches, branchId }: { client: SupabaseClient; branches: BranchRow[]; branchId: string | null }) {
  const { data, error } = useCatalog(client)
  const [picked, setPicked] = useState(branches[0]?.id ?? '')
  const branch = branchId ?? picked // the header's branch filter wins when one is chosen
  const [stockOf, setStockOf] = useState<{ branch: string; map: Map<string, number> }>()
  const [stockVersion, setStockVersion] = useState(0)
  const [mode, setMode] = useState<'stock_in' | 'count'>('stock_in')
  const [entry, setEntry] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<{ error?: boolean; text: string }>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!branch) return
    let live = true
    void client.from('stock').select('variant_id,quantity').eq('branch_id', branch).then(({ data: s, error: e }) => {
      if (!live) return
      if (e) setMsg({ error: true, text: e.message })
      else setStockOf({ branch, map: new Map((s as { variant_id: string; quantity: number }[]).map((x) => [x.variant_id, x.quantity])) })
    })
    return () => { live = false }
  }, [client, branch, stockVersion])
  const stock = stockOf?.branch === branch ? stockOf.map : undefined

  if (error) return <div className="admin-body"><p className="error">{error}</p></div>
  if (!data || !stock) return <div className="admin-body"><p className="muted">Loading…</p></div>

  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const items = data.products.filter((p) => p.is_active).flatMap((p) => p.variants.filter((v) => v.is_active).map((v) => ({ p, v, l: label(v) })))
    .filter(({ p, v, l }) => words.every((w) => [p.name, p.brand, l].join(' ').toLowerCase().includes(w)) || entry[v.id])
  const filled = Object.entries(entry).filter(([, x]) => x.trim() !== '')

  async function submit() {
    setMsg(undefined)
    const list = filled.map(([variant_id, x]) => ({ variant_id, quantity: Number(x) }))
    if (list.some((i) => !Number.isInteger(i.quantity) || i.quantity < 0 || (mode === 'stock_in' && i.quantity === 0))) {
      return setMsg({ error: true, text: 'Whole numbers only' + (mode === 'stock_in' ? ', more than 0' : '') })
    }
    setBusy(true)
    const { error: e } = await client.rpc('adjust_stock', { p: { branch_id: branch, kind: mode, reason, items: list } })
    setBusy(false)
    if (e) return setMsg({ error: true, text: e.message })
    setEntry({}); setReason('')
    setMsg({ text: mode === 'stock_in' ? `Delivery saved (${list.length} items).` : `Count saved (${list.length} items).` })
    setStockVersion((v) => v + 1)
  }

  return (
    <div className="admin-body">
      <div className="toolbar">
        {!branchId && (
          <select value={branch} onChange={(e) => setPicked(e.target.value)} aria-label="Branch">
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <div className="seg">
          <button className={mode === 'stock_in' ? 'on' : ''} onClick={() => { setMode('stock_in'); setEntry({}) }}>Receive delivery</button>
          <button className={mode === 'count' ? 'on' : ''} onClick={() => { setMode('count'); setEntry({}) }}>Stock count</button>
        </div>
        <input className="search-input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className="muted">{mode === 'stock_in'
        ? 'Type how many of each item arrived. They are added to the branch stock.'
        : 'Type how many are actually on the shelf. The stock is set to that number.'}</p>
      <section className="panel">
        {items.length ? (
          <table className="table edit">
            <thead><tr><th>Item</th><th>In stock</th><th>{mode === 'stock_in' ? 'Received' : 'Counted'}</th></tr></thead>
            <tbody>{items.map(({ p, v, l }) => {
              const n = stock.get(v.id) ?? 0
              return (
                <tr key={v.id}>
                  <td><b>{p.name}</b> <small className="muted">{l}</small></td>
                  <td className={n <= 0 ? 'neg' : n <= 3 ? 'warn' : ''}>{n}</td>
                  <td><input inputMode="numeric" value={entry[v.id] ?? ''} onChange={(e) => setEntry((x) => ({ ...x, [v.id]: e.target.value.replace(/\D/g, '') }))} /></td>
                </tr>
              )
            })}</tbody>
          </table>
        ) : <p className="empty-row">{data.products.length ? 'No items match.' : 'Add products first.'}</p>}
      </section>
      <div className="toolbar">
        <input className="search-input" placeholder={mode === 'stock_in' ? 'Supplier / delivery receipt no. (optional)' : 'Note (optional)'} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn primary" disabled={busy || !filled.length || !branch} onClick={() => void submit()}>
          {busy ? 'Saving…' : mode === 'stock_in' ? `Save delivery (${filled.length})` : `Save count (${filled.length})`}
        </button>
      </div>
      {msg && <p className={msg.error ? 'error' : 'notice'} role="alert">{msg.text}</p>}
    </div>
  )
}
