/**
 * Wire contract of the page-app ID brands: `PageAppTransactionId` and
 * `PageAppClientInstanceId` are compile-time-only `Branded<'...'>` string
 * brands, so the Typert generator emits plain string codecs for them and the
 * real client's UUID parses before Host dispatch. The type-level assertions
 * fail when either id regresses to a string-literal-key brand (the generator
 * then emits a literal-key Zod intersection that rejects plain strings); the
 * runtime assertions pin that a branded value is still a plain JSON string
 * with no brand key on the wire.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PageAppClientInstanceId, PageAppTransactionId } from '../src/types.ts'

const TXN = '0e1d2c3b-4a59-4876-9f8e-7a6b5c4d3e2f'
const CLIENT = '3f2c1a5e-8b7d-4e6f-9a0c-2d3e4f5a6b7c'

describe('page-app wire id brands', () => {
  it('are the compile-time-only Branded string types', () => {
    expectTypeOf<PageAppTransactionId>().toEqualTypeOf<Branded<'PageAppTransactionId'>>()
    expectTypeOf<PageAppClientInstanceId>().toEqualTypeOf<Branded<'PageAppClientInstanceId'>>()
  })

  it('stay plain JSON strings with no brand key on the wire', () => {
    const transactionId = TXN as PageAppTransactionId
    const clientInstanceId = CLIENT as PageAppClientInstanceId
    expect(typeof transactionId).toBe('string')
    expect(typeof clientInstanceId).toBe('string')
    expect(JSON.stringify({ transactionId, clientInstanceId }))
      .toBe(`{"transactionId":"${TXN}","clientInstanceId":"${CLIENT}"}`)
    expect(transactionId === TXN).toBe(true)
    expect(clientInstanceId === CLIENT).toBe(true)
  })
})
