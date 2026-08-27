import { describe, expect, it } from 'vitest'
import {
  finishExternalConsumerSmoke,
  type PageAppExternalConsumerResult,
} from './page-app-external-consumer.smoke.ts'

const success: PageAppExternalConsumerResult = {
  publishedDshInstalled: true,
  consumerBinResolved: true,
  strictPeerClosure: true,
  nonEmptyRegistryActive: true,
  managerServiceAndUiRegistered: true,
  disabledNativeBoot: true,
  reenabled: true,
  removedNativeBoot: true,
}

describe('external consumer smoke completion', () => {
  it('returns success only after cleanup is known to have succeeded', () => {
    expect(finishExternalConsumerSmoke(success, undefined, [], [])).toBe(success)
    const cleanup = new Error('cleanup failed')
    expect(() => finishExternalConsumerSmoke(success, undefined, [cleanup], []))
      .toThrow(expect.objectContaining({ errors: [cleanup] }))
  })
})
