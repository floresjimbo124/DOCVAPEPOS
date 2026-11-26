import { expect, test } from 'vitest'
import { quickCash } from '../domain/cart'

test('quick cash: exact, then next ₱100 / ₱500 / ₱1000, no duplicates', () => {
  expect(quickCash(35000)).toEqual([35000, 40000, 50000, 100000])
  expect(quickCash(50000)).toEqual([50000, 100000])
  expect(quickCash(123450)).toEqual([123450, 130000, 150000, 200000])
})
