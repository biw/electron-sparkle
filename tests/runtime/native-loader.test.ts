import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import { SparkleUpdaterError } from '../../src/runtime/errors.ts'
import { toNativeAdapter } from '../../src/runtime/native-loader.ts'

test('adapts swift-node events streams and their cancellation handle', () => {
  let cancelled = false
  const adapter = toNativeAdapter({
    start: () => undefined,
    checkForUpdates: () => undefined,
    getState: () => ({
      automaticallyChecksForUpdates: false,
      automaticallyDownloadsUpdates: false,
      canCheckForUpdates: true,
      sessionInProgress: false,
    }),
    setAutomaticallyChecksForUpdates: () => undefined,
    setAutomaticallyDownloadsUpdates: () => undefined,
    events: (_onValue: (value: unknown) => void, onError?: (error: unknown) => void) => {
      onError?.({ code: 7, domain: 'Sparkle', message: 'network unavailable' })
      return { cancel: () => (cancelled = true) }
    },
  })
  const events: unknown[] = []
  const subscription = adapter.subscribe((event) => events.push(event))

  assert.deepEqual(events, [
    {
      type: 'error',
      error: { code: 7, domain: 'Sparkle', message: 'network unavailable' },
    },
  ])
  assert.ok(subscription && typeof subscription === 'object' && 'cancel' in subscription)
  subscription.cancel()
  assert.equal(cancelled, true)
})

test('rejects a native module that cannot subscribe to updater events', () => {
  assert.throws(
    () =>
      toNativeAdapter({
        start: () => undefined,
        checkForUpdates: () => undefined,
        getState: () => ({}),
        setAutomaticallyChecksForUpdates: () => undefined,
        setAutomaticallyDownloadsUpdates: () => undefined,
      }),
    (error: unknown) =>
      error instanceof SparkleUpdaterError && error.code === 'NATIVE_MODULE_INVALID',
  )
})
