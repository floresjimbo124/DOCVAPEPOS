// Cart and checkout math. No UI or storage, so it is easy to test.
// All money is integer centavos to avoid rounding errors.

export interface CartVariant {
  variantId: string
  productName: string
  label: string // e.g. "Mango · 3mg · 30ml"
  priceCentavos: number
  isDevice: boolean
}

export interface CartLine {
  variant: CartVariant
  quantity: number
  serialNo?: string
}

export type DiscountKind = 'percent' | 'fixed' | 'senior' | 'pwd'
export interface OrderDiscount {
  kind: DiscountKind
  value: number // percent (e.g. 10) or fixed pesos; 20 for senior/pwd
  idHolder?: string
  idNumber?: string
}

export type PayMethod = 'cash' | 'gcash' | 'maya'
export interface Payment {
  method: PayMethod
  amountCentavos: number
  tenderedCentavos?: number // cash given
  referenceNo?: string
}

export class CheckoutError extends Error {}

export interface CartState {
  lines: CartLine[]
  discount?: OrderDiscount
  payments: Payment[]
  ageVerified: boolean
  manualReceiptNo?: string
}

export const emptyCart = (): CartState => ({ lines: [], payments: [], ageVerified: false })

/** Same variant stacks; devices get one line each so each has its own serial. */
export function addToCart(c: CartState, v: CartVariant): CartState {
  const i = v.isDevice ? -1 : c.lines.findIndex((l) => l.variant.variantId === v.variantId)
  const lines =
    i >= 0
      ? c.lines.map((l, j) => (j === i ? { ...l, quantity: l.quantity + 1 } : l))
      : [...c.lines, { variant: v, quantity: 1 }]
  return { ...c, lines }
}

export function setQuantity(c: CartState, index: number, qty: number): CartState {
  const line = c.lines[index]
  if (!line) return c
  if (qty <= 0) return { ...c, lines: c.lines.filter((_, j) => j !== index) }
  const quantity = line.variant.isDevice ? 1 : qty
  return { ...c, lines: c.lines.map((l, j) => (j === index ? { ...l, quantity } : l)) }
}

export const subtotal = (c: CartState) => c.lines.reduce((s, l) => s + l.variant.priceCentavos * l.quantity, 0)

/** VAT-registered stores remove 12% VAT before the 20% Senior/PWD discount (RA 9994 / RA 10754). */
export function discountAmount(c: CartState, vatRegistered = true): number {
  const d = c.discount
  if (!d) return 0
  const sub = subtotal(c)
  let amount: number
  switch (d.kind) {
    case 'percent': amount = Math.round((sub * d.value) / 100); break
    case 'fixed': amount = Math.round(d.value * 100); break
    default: amount = vatRegistered ? sub - Math.round((sub / 1.12) * 0.8) : Math.round(sub * 0.2)
  }
  return Math.min(Math.max(amount, 0), sub)
}

export const total = (c: CartState, vat = true) => subtotal(c) - discountAmount(c, vat)
export const paid = (c: CartState) => c.payments.reduce((s, p) => s + p.amountCentavos, 0)
export const change = (c: CartState) =>
  c.payments.reduce((s, p) => s + (p.method === 'cash' && p.tenderedCentavos != null ? p.tenderedCentavos - p.amountCentavos : 0), 0)

const blank = (s?: string) => !s || s.trim() === ''

/** Same checks the server runs, so cashiers see problems before the sale syncs. */
export function validate(c: CartState, vat = true): void {
  if (c.lines.length === 0) throw new CheckoutError('Cart is empty')
  if (!c.ageVerified) throw new CheckoutError('Confirm the customer is 18 or older')
  for (const l of c.lines) {
    if (l.variant.isDevice && blank(l.serialNo)) throw new CheckoutError(`Enter the serial number for ${l.variant.productName}`)
  }
  const d = c.discount
  if (d && (d.kind === 'senior' || d.kind === 'pwd') && (blank(d.idHolder) || blank(d.idNumber))) {
    throw new CheckoutError('Senior/PWD discount needs name and ID number')
  }
  for (const p of c.payments) {
    if (p.method !== 'cash' && blank(p.referenceNo)) throw new CheckoutError(`Enter the ${p.method.toUpperCase()} reference number`)
    if (p.tenderedCentavos != null && p.tenderedCentavos < p.amountCentavos) throw new CheckoutError('Cash given is less than the amount')
  }
  if (paid(c) !== total(c, vat)) {
    throw new CheckoutError(`Payments (${peso(paid(c))}) do not match total (${peso(total(c, vat))})`)
  }
}

const dec = (c: number) => (c / 100).toFixed(2)

/** Builds the JSON for the server's complete_sale() function. */
export function toSalePayload(
  c: CartState,
  ids: { branchId: string; shiftId: string; staffId: string; saleId?: string; now?: Date },
  vat = true,
) {
  validate(c, vat)
  const d = c.discount
  return {
    id: ids.saleId ?? crypto.randomUUID(),
    branch_id: ids.branchId,
    shift_id: ids.shiftId,
    staff_id: ids.staffId,
    age_verified: c.ageVerified,
    manual_receipt_no: c.manualReceiptNo?.trim() || null,
    client_created_at: (ids.now ?? new Date()).toISOString(),
    items: c.lines.map((l) => ({
      variant_id: l.variant.variantId,
      quantity: l.quantity,
      unit_price: dec(l.variant.priceCentavos),
      ...(l.serialNo ? { serial_no: l.serialNo.trim() } : {}),
    })),
    discounts: d
      ? [{ kind: d.kind, value: d.value, amount: dec(discountAmount(c, vat)),
           ...(d.idHolder ? { id_holder: d.idHolder } : {}), ...(d.idNumber ? { id_number: d.idNumber } : {}) }]
      : [],
    payments: c.payments.map((p) => ({
      method: p.method,
      amount: dec(p.amountCentavos),
      ...(p.tenderedCentavos != null ? { tendered: dec(p.tenderedCentavos) } : {}),
      ...(p.referenceNo ? { reference_no: p.referenceNo.trim() } : {}),
    })),
  }
}
export type SalePayload = ReturnType<typeof toSalePayload>

export function peso(centavos: number): string {
  const [whole, frac] = (Math.abs(centavos) / 100).toFixed(2).split('.')
  return `${centavos < 0 ? '-' : ''}₱${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`
}
