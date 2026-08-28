import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import { SparkleUpdaterError } from '../../src/runtime/errors.ts'
import { toNativeAdapter } from '../../src/runtime/native-loader.ts'

test('adapts swift-node events streams and their cancellation handle', () => {
  let cancelled = false
  const calls: unknown[] = []
  const adapter = toNativeAdapter({
    start: () => undefined,
    checkForUpdates: () => undefined,
    checkForUpdatesInBackground: () => calls.push('background-check'),
    continueRelaunch: (requestID: string) => {
      calls.push(['continue-relaunch', requestID])
      return requestID !== 'stale-request'
    },
    getState: () => ({
      automaticallyChecksForUpdates: false,
      automaticallyDownloadsUpdates: false,
      canCheckForUpdates: true,
      sessionInProgress: false,
    }),
    setHTTPHeaders: (headers: Record<string, string>) => calls.push(['headers', headers]),
    setAutomaticallyChecksForUpdates: () => undefined,
    setAutomaticallyDownloadsUpdates: () => undefined,
    setRelaunchPostponementEnabled: (enabled: boolean) =>
      calls.push(['relaunch-postponement', enabled]),
    events: (_onValue: (value: unknown) => void, onError?: (error: unknown) => void) => {
      onError?.({ code: 7, domain: 'Sparkle', message: 'network unavailable' })
      return { cancel: () => (cancelled = true) }
    },
  })
  const events: unknown[] = []
  const subscription = adapter.subscribe((event) => events.push(event))
  adapter.setHTTPHeaders({ 'X-Example': 'placeholder' })
  adapter.setRelaunchPostponementEnabled(true)
  adapter.checkForUpdatesInBackground()
  assert.equal(adapter.continueRelaunch('request-1'), true)
  assert.equal(adapter.continueRelaunch('stale-request'), false)

  assert.deepEqual(events, [
    {
      type: 'error',
      error: { code: 7, domain: 'Sparkle', message: 'network unavailable' },
    },
  ])
  assert.ok(subscription && typeof subscription === 'object' && 'cancel' in subscription)
  subscription.cancel()
  assert.equal(cancelled, true)
  assert.deepEqual(calls, [
    ['headers', { 'X-Example': 'placeholder' }],
    ['relaunch-postponement', true],
    'background-check',
    ['continue-relaunch', 'request-1'],
    ['continue-relaunch', 'stale-request'],
  ])
})

test('requires every relaunch and authenticated-request adapter method', () => {
  const validModule: Record<string, unknown> = {
    start: () => undefined,
    checkForUpdates: () => undefined,
    checkForUpdatesInBackground: () => undefined,
    continueRelaunch: () => true,
    getState: () => ({}),
    setHTTPHeaders: () => undefined,
    setAutomaticallyChecksForUpdates: () => undefined,
    setAutomaticallyDownloadsUpdates: () => undefined,
    setRelaunchPostponementEnabled: () => undefined,
    subscribe: () => undefined,
  }

  for (const method of [
    'checkForUpdatesInBackground',
    'continueRelaunch',
    'setHTTPHeaders',
    'setRelaunchPostponementEnabled',
  ]) {
    const incompleteModule = { ...validModule }
    delete incompleteModule[method]
    assert.throws(
      () => toNativeAdapter(incompleteModule),
      (error: unknown) =>
        error instanceof SparkleUpdaterError &&
        error.code === 'NATIVE_MODULE_INVALID' &&
        error.message.includes(method),
    )
  }
})

test('rejects a non-boolean relaunch continuation result', () => {
  const adapter = toNativeAdapter({
    start: () => undefined,
    checkForUpdates: () => undefined,
    checkForUpdatesInBackground: () => undefined,
    continueRelaunch: () => 'invalid',
    getState: () => ({}),
    setHTTPHeaders: () => undefined,
    setAutomaticallyChecksForUpdates: () => undefined,
    setAutomaticallyDownloadsUpdates: () => undefined,
    setRelaunchPostponementEnabled: () => undefined,
    subscribe: () => undefined,
  })

  assert.throws(
    () => adapter.continueRelaunch('request-1'),
    (error: unknown) =>
      error instanceof SparkleUpdaterError && error.code === 'NATIVE_MODULE_INVALID',
  )
})

test('rejects a native module that cannot subscribe to updater events', () => {
  assert.throws(
    () =>
      toNativeAdapter({
        start: () => undefined,
        checkForUpdates: () => undefined,
        checkForUpdatesInBackground: () => undefined,
        continueRelaunch: () => true,
        getState: () => ({}),
        setHTTPHeaders: () => undefined,
        setAutomaticallyChecksForUpdates: () => undefined,
        setAutomaticallyDownloadsUpdates: () => undefined,
        setRelaunchPostponementEnabled: () => undefined,
      }),
    (error: unknown) =>
      error instanceof SparkleUpdaterError && error.code === 'NATIVE_MODULE_INVALID',
  )
})
