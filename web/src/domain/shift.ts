// Shift math: what should be in the drawer, and the Z-reading summary.
// Pure functions over the sales and cash movements recorded during the shift.

import type { PayMethod, SalePayload } from './cart'

export interface CashMovement {
  id: string
  shiftId: string
  amountCentavos: number // positive = cash in, negative = cash out
  reason: string
  staffId: string
  createdAt: number
}

/** Cash expenses come out of the drawer; non-cash ones (rent, bills paid by bank/GCash) don't. */
export interface Expense {
  id: string
  branchId: string
  shiftId?: string
  name: string
  amountCentavos: number
  kind: 'cash' | 'non_cash'
  staffId: string
  createdAt: number
}

export interface ShiftSummary {
  saleCount: number
  grossCentavos: number // before discounts
  discountCentavos: number
  netCentavos: number
  byMethod: Record<PayMethod, number>
  cashInCentavos: number
  cashOutCentavos: number
  cashExpenseCentavos: number
  nonCashExpenseCentavos: number
  expectedCashCentavos: number
  seniorPwdCount: number
  firstReceiptNo?: string
  lastReceiptNo?: string
}

const toC = (s: string | number) => Math.round(Number(s) * 100)

export function summarizeShift(startingCashCentavos: number, sales: SalePayload[], moves: CashMovement[], expenses: Expense[] = []): ShiftSummary {
  const byMethod: Record<PayMethod, number> = { cash: 0, gcash: 0, maya: 0 }
  let gross = 0, discount = 0, seniorPwd = 0
  const receipts: string[] = []
  for (const s of sales) {
    for (const i of s.items) gross += toC(i.unit_price) * i.quantity
    for (const d of s.discounts) {
      discount += toC(d.amount)
      if (d.kind === 'senior' || d.kind === 'pwd') seniorPwd++
    }
    for (const p of s.payments) byMethod[p.method] += toC(p.amount)
    if (s.manual_receipt_no) receipts.push(s.manual_receipt_no)
  }
  const cashIn = moves.filter((m) => m.amountCentavos > 0).reduce((a, m) => a + m.amountCentavos, 0)
  const cashOut = -moves.filter((m) => m.amountCentavos < 0).reduce((a, m) => a + m.amountCentavos, 0)
  const cashExp = expenses.filter((e) => e.kind === 'cash').reduce((a, e) => a + e.amountCentavos, 0)
  const nonCashExp = expenses.filter((e) => e.kind === 'non_cash').reduce((a, e) => a + e.amountCentavos, 0)
  const sorted = [...receipts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return {
    saleCount: sales.length,
    grossCentavos: gross,
    discountCentavos: discount,
    netCentavos: gross - discount,
    byMethod,
    cashInCentavos: cashIn,
    cashOutCentavos: cashOut,
    cashExpenseCentavos: cashExp,
    nonCashExpenseCentavos: nonCashExp,
    expectedCashCentavos: startingCashCentavos + byMethod.cash + cashIn - cashOut - cashExp,
    seniorPwdCount: seniorPwd,
    firstReceiptNo: sorted[0],
    lastReceiptNo: sorted[sorted.length - 1],
  }
}

/** Positive = over (more cash than expected), negative = short. */
export const overShort = (summary: ShiftSummary, countedCentavos: number) => countedCentavos - summary.expectedCashCentavos
