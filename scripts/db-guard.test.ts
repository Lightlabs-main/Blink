import { describe, expect, it } from 'vitest'

import { assertBlinkDatabase } from './db-guard.ts'

describe('assertBlinkDatabase', () => {
  it('accepts the Blink database', () => {
    expect(assertBlinkDatabase('postgresql://blink_app:x@127.0.0.1:5432/blink_to_stock', 'blink_to_stock')).toBe(
      'blink_to_stock',
    )
  })
  it.each([
    [undefined, /not set/],
    ['not a url', /valid URL/],
    ['mysql://u:p@h/blink_to_stock', /not PostgreSQL/],
    ['postgresql://u:p@h:5432/', /no database name/],
    ['postgresql://u:p@h:5432/other_project', /Refusing/],
  ])('refuses %s', (url, message) => {
    expect(() => assertBlinkDatabase(url, 'blink_to_stock')).toThrow(message)
  })
})
