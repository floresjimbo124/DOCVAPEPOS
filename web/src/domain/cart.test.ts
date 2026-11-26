import { describe, expect, test } from 'vitest'
import {
  addToCart, change, CheckoutError, emptyCart, peso, setQuantity, subtotal, toSalePayload, total, validate,
  type CartState, type CartVariant,
} from './cart'

const juice: CartVariant = { variantId: 'v1', productName: 'Juice', label: 'Mango · 3mg', priceCentavos: 35000, isDevice: false }
const kit: CartVariant = { variantId: 'v2', productName: 'Pod Kit', label: 'Black', priceCentavos: 120000, isDevice: true }
const cartOf = (...vs: CartVariant[]) => vs.reduce(addToCart, emptyCart())
const ready = (c: CartState): CartState => ({ ...c, ageVerified: true })

describe('cart', () => {
  test('same variant stacks, devices get separate lines', () => {
    const c = cartOf(juice, juice, kit, kit)
    expect(c.lines.length).toBe(3)
    expect(c.lines[0].quantity).toBe(2)
    expect(subtotal(c)).toBe(2 * 35000 + 2 * 120000)
    expect(setQuantity(c, 1, 5).lines[1].quantity).toBe(1) // device stays 1
    expect(setQuantity(c, 0, 0).lines.length).toBe(2)
  })

  test('percent and fixed discounts, never below zero', () => {
    const c = cartOf(juice, juice)
    expect(total({ ...c, discount: { kind: 'percent', value: 10 } })).toBe(63000)
    expect(total({ ...c, discount: { kind: 'fixed', value: 50 } })).toBe(65000)
    expect(total({ ...c, discount: { kind: 'fixed', value: 9999 } })).toBe(0)
  })

  test('senior/PWD: VAT exempt + 20% when VAT registered', () => {
    const c = { ...cartOf(juice), discount: { kind: 'senior' as const, value: 20, idHolder: 'Lola', idNumber: 'SC-1' } }
    expect(total(c, true)).toBe(25000) // 350 / 1.12 * 0.8
    expect(total(c, false)).toBe(28000)
  })

  test('validation mirrors server rules', () => {
    const base = { ...cartOf(juice), payments: [{ method: 'cash' as const, amountCentavos: 35000 }] }
    expect(() => validate(base)).toThrow(/18/)
    validate(ready(base))
    expect(() => validate(ready({ ...cartOf(juice), payments: [{ method: 'gcash', amountCentavos: 35000 }] }))).toThrow(/reference/)
    const dev = ready({ ...cartOf(kit), payments: [{ method: 'cash', amountCentavos: 120000 }] })
    expect(() => validate(dev)).toThrow(/serial/)
    validate({ ...dev, lines: [{ ...dev.lines[0], serialNo: 'SN1' }] })
    expect(() => validate(ready({ ...cartOf(juice), payments: [{ method: 'cash', amountCentavos: 30000 }] }))).toThrow(CheckoutError)
    expect(() => validate(ready({ ...cartOf(juice), discount: { kind: 'pwd', value: 20 }, payments: [] }))).toThrow(/ID/)
  })

  test('split payment and change', () => {
    const c = ready({
      ...cartOf(juice, juice),
      payments: [
        { method: 'cash', amountCentavos: 30000, tenderedCentavos: 50000 },
        { method: 'maya', amountCentavos: 40000, referenceNo: 'M-1' },
      ],
    })
    validate(c)
    expect(change(c)).toBe(20000)
  })

  test('payload matches server complete_sale format', () => {
    const c = ready({ ...cartOf(juice), manualReceiptNo: '0001', payments: [{ method: 'gcash', amountCentavos: 35000, referenceNo: ' REF1 ' }] })
    const p = toSalePayload(c, { branchId: 'b', shiftId: 's', staffId: 'u', saleId: 'id1' })
    expect(p.id).toBe('id1')
    expect(p.items[0]).toEqual({ variant_id: 'v1', quantity: 1, unit_price: '350.00' })
    expect(p.payments[0]).toEqual({ method: 'gcash', amount: '350.00', reference_no: 'REF1' })
    expect(p.manual_receipt_no).toBe('0001')
  })

  test('peso formatting', () => {
    expect(peso(123456789)).toBe('₱1,234,567.89')
    expect(peso(5)).toBe('₱0.05')
  })
})
