import { expect, test } from 'vitest'
import { fmtHours, hoursWorked, nextPunchKind, type Punch } from './attendance'

const H = 3_600_000
const p = (staffId: string, kind: Punch['kind'], hour: number): Punch =>
  ({ id: crypto.randomUUID(), staffId, branchId: 'b', kind, at: hour * H })

test('pairs in/out per person and sums hours', () => {
  const r = hoursWorked([p('ana', 'in', 8), p('ben', 'in', 9), p('ana', 'out', 12), p('ana', 'in', 13), p('ana', 'out', 17)], 20 * H)
  const ana = r.find((x) => x.staffId === 'ana')!
  expect(ana.workedMs).toBe(8 * H)
  expect(ana.clockedIn).toBe(false)
  expect([ana.firstIn, ana.lastOut]).toEqual([8 * H, 17 * H])
  const ben = r.find((x) => x.staffId === 'ben')!
  expect(ben.clockedIn).toBe(true)
  expect(ben.workedMs).toBe(11 * H) // still in: counts up to "now"
})

test('forgotten clock-out is flagged and not counted', () => {
  const [r] = hoursWorked([p('ana', 'in', 8), p('ana', 'in', 20), p('ana', 'out', 22)], 23 * H)
  expect(r.missingOut).toBe(true)
  expect(r.workedMs).toBe(2 * H)
})

test('next punch alternates', () => {
  const list = [p('ana', 'in', 8)]
  expect(nextPunchKind(list, 'ana')).toBe('out')
  expect(nextPunchKind(list, 'ben')).toBe('in')
  expect(fmtHours(8.5 * H)).toBe('8h 30m')
})
