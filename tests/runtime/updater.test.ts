import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import type { NativeSparkleAdapter, NativeSparkleUpdaterState } from '../../src/runtime/adapter.ts'
import { SparkleUpdaterError, UpdaterNotStartedError } from '../../src/runtime/errors.ts'
import type { ProcessLike } from '../../src/runtime/environment.ts'
import { createSparkleUpdater } from '../../src/runtime/updater.ts'

interface FakeBridge {
  adapter: NativeSparkleAdapter
  emit(value: unknown): void
  readonly calls: {
    order: string[]
    start: number
    checkForUpdates: number
    checkForUpdatesInBackground: number
    continuedRelaunches: string[]
    httpHeaders: Record<string, string>[]
    relaunchPostponementEnabled: boolean[]
    automaticallyChecksForUpdates: boolean[]
    automaticallyDownloadsUpdates: boolean[]
  }
}

const READY_PROCESS: ProcessLike = {
  mas: false,
  platform: 'darwin',
  type: 'browser',
}

const noopListener = () => undefined
const waitForAsyncHandlers = () => new Promise<void>((resolve) => setImmediate(resolve))

function createReadyUpdater(bridge: FakeBridge, process: ProcessLike = READY_PROCESS) {
  return createSparkleUpdater({
    getElectron: () => ({ app: { isReady: () => true } }),
    loadNativeAdapter: () => bridge.adapter,
    process,
  })
}

function createFakeBridge(
  state: NativeSparkleUpdaterState = {
    automaticallyChecksForUpdates: true,
    automaticallyDownloadsUpdates: false,
    canCheckForUpdates: true,
    sessionInProgress: false,
  },
): FakeBridge {
  let listener: ((event: unknown) => void) | undefined
  const calls = {
    order: [] as string[],
    start: 0,
    checkForUpdates: 0,
    checkForUpdatesInBackground: 0,
    continuedRelaunches: [] as string[],
    httpHeaders: [] as Record<string, string>[],
    relaunchPostponementEnabled: [] as boolean[],
    automaticallyChecksForUpdates: [] as boolean[],
    automaticallyDownloadsUpdates: [] as boolean[],
  }

  return {
    adapter: {
      start: () => {
        calls.order.push('start')
        calls.start += 1
      },
      checkForUpdates: () => {
        calls.checkForUpdates += 1
      },
      checkForUpdatesInBackground: () => {
        calls.checkForUpdatesInBackground += 1
      },
      continueRelaunch: (requestID) => {
        calls.continuedRelaunches.push(requestID)
        return true
      },
      setHTTPHeaders: (headers) => {
        calls.order.push('setHTTPHeaders')
        calls.httpHeaders.push(headers)
      },
      getState: () => state,
      setAutomaticallyChecksForUpdates: (enabled) => {
        calls.automaticallyChecksForUpdates.push(enabled)
      },
      setAutomaticallyDownloadsUpdates: (enabled) => {
        calls.automaticallyDownloadsUpdates.push(enabled)
      },
      setRelaunchPostponementEnabled: (enabled) => {
        calls.order.push(`setRelaunchPostponementEnabled:${enabled}`)
        calls.relaunchPostponementEnabled.push(enabled)
      },
      subscribe: (next) => {
        listener = next
        return { cancel: () => undefined }
      },
    },
    calls,
    emit: (event) => listener?.(event),
  }
}

test('imports lazily and rejects a non-Darwin call with a typed error', () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge, { ...READY_PROCESS, platform: 'win32' })

  assert.throws(
    () => updater.getState(),
    (error: unknown) =>
      error instanceof SparkleUpdaterError && error.code === 'UNSUPPORTED_PLATFORM',
  )
})

test('requires Electron readiness, main process, and non-MAS execution', () => {
  const bridge = createFakeBridge()

  const notReady = createSparkleUpdater({
    getElectron: () => ({ app: { isReady: () => false } }),
    loadNativeAdapter: () => bridge.adapter,
    process: READY_PROCESS,
  })
  assert.throws(
    () => notReady.getState(),
    (error: unknown) => error instanceof SparkleUpdaterError && error.code === 'ELECTRON_NOT_READY',
  )

  const renderer = createReadyUpdater(bridge, {
    ...READY_PROCESS,
    type: 'renderer',
  })
  assert.throws(
    () => renderer.getState(),
    (error: unknown) => error instanceof SparkleUpdaterError && error.code === 'NOT_MAIN_PROCESS',
  )

  const mas = createReadyUpdater(bridge, { ...READY_PROCESS, mas: true })
  assert.throws(
    () => mas.getState(),
    (error: unknown) => error instanceof SparkleUpdaterError && error.code === 'MAS_UNSUPPORTED',
  )
})

test('starts exactly once and exposes state only after native initialization', async () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge)

  assert.throws(() => updater.getState(), UpdaterNotStartedError)

  const first = updater.start()
  const second = updater.start()
  assert.strictEqual(first, second)
  await first

  assert.equal(bridge.calls.start, 1)
  assert.deepEqual(updater.getState(), {
    started: true,
    canCheckForUpdates: true,
    sessionInProgress: false,
    automaticallyChecksForUpdates: true,
    automaticallyDownloadsUpdates: false,
  })
  await updater.start()
  assert.equal(bridge.calls.start, 1)
})

test('applies buffered HTTP headers before native startup', async () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge)
  const headers = { 'X-Example-Authorization': 'placeholder' }

  updater.setHTTPHeaders(headers)
  headers['X-Example-Authorization'] = 'changed-after-configuration'
  await updater.start()

  assert.deepEqual(bridge.calls.order, [
    'setHTTPHeaders',
    'setRelaunchPostponementEnabled:false',
    'start',
  ])
  assert.deepEqual(bridge.calls.httpHeaders, [{ 'X-Example-Authorization': 'placeholder' }])
})

test('refreshes and clears HTTP headers after startup', async () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge)
  await updater.start()

  const refreshedHeaders = { 'X-Example-Authorization': 'refreshed-placeholder' }
  updater.setHTTPHeaders(refreshedHeaders)
  refreshedHeaders['X-Example-Authorization'] = 'changed-after-refresh'
  updater.setHTTPHeaders({})

  assert.deepEqual(bridge.calls.httpHeaders, [
    {},
    { 'X-Example-Authorization': 'refreshed-placeholder' },
    {},
  ])
})

test('rejects malformed HTTP header objects without exposing their values', () => {
  const updater = createReadyUpdater(createFakeBridge())
  const privatePlaceholder = 'private-placeholder-value'
  const accessorHeaders = Object.defineProperty({}, 'X-Example', {
    enumerable: true,
    get: () => {
      throw new Error(privatePlaceholder)
    },
  })
  const invalidHeaders: unknown[] = [
    null,
    [],
    accessorHeaders,
    { 'Invalid Header Name': privatePlaceholder },
    { 'X-Example': `prefix\r\n${privatePlaceholder}` },
    { 'X-Example': 123 },
    { 'X-Example': 'first', 'x-example': privatePlaceholder },
  ]

  for (const headers of invalidHeaders) {
    assert.throws(
      () => {
        // @ts-expect-error JavaScript callers can pass untyped values at runtime.
        updater.setHTTPHeaders(headers)
      },
      (error: unknown) => error instanceof TypeError && !error.message.includes(privatePlaceholder),
    )
  }
})

test('requires start before controlling Sparkle', () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge)

  assert.throws(() => updater.checkForUpdates(), UpdaterNotStartedError)
  assert.throws(() => updater.checkForUpdatesInBackground(), UpdaterNotStartedError)
  assert.throws(() => updater.getState(), UpdaterNotStartedError)
  assert.throws(() => updater.setAutomaticallyChecksForUpdates(true), UpdaterNotStartedError)
  assert.throws(() => updater.setAutomaticallyDownloadsUpdates(true), UpdaterNotStartedError)
})

test('listener registration is safe before Electron readiness', () => {
  const updater = createSparkleUpdater({
    getElectron: () => ({ app: { isReady: () => false } }),
    process: READY_PROCESS,
  })
  assert.doesNotThrow(() => updater.on('cycle-complete', noopListener))
  assert.doesNotThrow(() => updater.off('cycle-complete', noopListener))
})

test('subscribes before start and cleans up a failed native start', async () => {
  let next: ((event: unknown) => void) | undefined
  let cancelCount = 0
  const emittedVersions: string[] = []
  const bridge: NativeSparkleAdapter = {
    start: () => {
      next?.({
        type: 'update-available',
        update: { displayVersion: '1.0.0', version: '100' },
      })
    },
    checkForUpdates: () => undefined,
    checkForUpdatesInBackground: () => undefined,
    continueRelaunch: () => true,
    getState: () => ({
      automaticallyChecksForUpdates: false,
      automaticallyDownloadsUpdates: false,
      canCheckForUpdates: true,
      sessionInProgress: false,
    }),
    setHTTPHeaders: () => undefined,
    setAutomaticallyChecksForUpdates: () => undefined,
    setAutomaticallyDownloadsUpdates: () => undefined,
    setRelaunchPostponementEnabled: () => undefined,
    subscribe: (listener) => {
      next = listener
      return { cancel: () => (cancelCount += 1) }
    },
  }
  const updater = createSparkleUpdater({
    getElectron: () => ({ app: { isReady: () => true } }),
    loadNativeAdapter: () => bridge,
    process: READY_PROCESS,
  })
  updater.on('update-available', (event) => emittedVersions.push(event.update.version))

  await updater.start()
  assert.deepEqual(emittedVersions, ['100'])
  assert.equal(cancelCount, 0)

  const failingUpdater = createSparkleUpdater({
    getElectron: () => ({ app: { isReady: () => true } }),
    loadNativeAdapter: () => ({
      ...bridge,
      start: () => {
        throw new Error('failed')
      },
    }),
    process: READY_PROCESS,
  })
  await assert.rejects(failingUpdater.start(), /failed/)
  assert.equal(cancelCount, 1)
})

test('forwards controls and dispatches normalized native events', async () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge)
  const available: string[] = []
  const fileURLs: string[] = []
  const notAvailableChecks: Array<boolean | undefined> = []
  const errors: Error[] = []
  const onAvailable = (event: {
    type: 'update-available'
    update: { fileURL?: string; version: string }
  }) => {
    available.push(event.update.version)
    if (event.update.fileURL) {
      fileURLs.push(event.update.fileURL)
    }
  }

  updater.on('update-available', onAvailable)
  updater.on('update-not-available', (event) => notAvailableChecks.push(event.userInitiated))
  updater.on('error', (event) => errors.push(event.error))
  await updater.start()

  updater.checkForUpdates()
  updater.checkForUpdatesInBackground()
  updater.setAutomaticallyChecksForUpdates(false)
  updater.setAutomaticallyDownloadsUpdates(true)
  bridge.emit({
    type: 'update-available',
    update: {
      displayVersion: '2.0.0',
      fileURL: 'https://updates.example.test/App-2.0.0.zip',
      publicationDate: '2025-01-01T00:00:00.000Z',
      version: '200',
    },
  })
  bridge.emit({
    type: 'update-not-available',
    userInitiated: true,
  })
  bridge.emit({
    type: 'error',
    error: { code: 42, domain: 'SUSparkleErrorDomain', message: 'network unavailable' },
  })
  updater.off('update-available', onAvailable)
  bridge.emit({
    type: 'update-available',
    update: { displayVersion: '3.0.0', version: '300' },
  })

  assert.equal(bridge.calls.checkForUpdates, 1)
  assert.equal(bridge.calls.checkForUpdatesInBackground, 1)
  assert.deepEqual(bridge.calls.automaticallyChecksForUpdates, [false])
  assert.deepEqual(bridge.calls.automaticallyDownloadsUpdates, [true])
  assert.deepEqual(available, ['200'])
  assert.deepEqual(fileURLs, ['https://updates.example.test/App-2.0.0.zip'])
  assert.deepEqual(notAvailableChecks, [true])
  assert.equal(errors[0]?.message, 'network unavailable')
  assert.equal((errors[0] as Error & { code?: number }).code, 42)
  assert.equal((errors[0] as Error & { domain?: string }).domain, 'SUSparkleErrorDomain')
})

test('waits for the configured handler before continuing a relaunch', async () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge)
  const beforeRelaunchNotifications: string[] = []
  const preparedVersions: string[] = []
  let finishPreparation: (() => void) | undefined
  const preparation = new Promise<void>((resolve) => {
    finishPreparation = resolve
  })

  updater.setBeforeRelaunchHandler(async (update) => {
    preparedVersions.push(update.version)
    await preparation
  })
  updater.on('before-relaunch', () => beforeRelaunchNotifications.push('before-relaunch'))
  await updater.start()
  bridge.emit({
    type: 'relaunch-requested',
    relaunchRequestID: 'request-1',
    update: { displayVersion: '2.0.0', version: '200' },
  })
  await waitForAsyncHandlers()

  assert.deepEqual(preparedVersions, ['200'])
  assert.deepEqual(bridge.calls.continuedRelaunches, [])
  assert.deepEqual(beforeRelaunchNotifications, [])

  finishPreparation?.()
  await preparation
  await waitForAsyncHandlers()

  assert.deepEqual(bridge.calls.continuedRelaunches, ['request-1'])
  assert.deepEqual(bridge.calls.relaunchPostponementEnabled, [true])
  assert.deepEqual(beforeRelaunchNotifications, [])

  bridge.emit({ type: 'before-relaunch' })
  assert.deepEqual(beforeRelaunchNotifications, ['before-relaunch'])
})

test('reports thrown and rejected relaunch handlers without exposing failure details', async () => {
  const failures = [
    () => {
      throw new Error('private synchronous cleanup detail')
    },
    async () => {
      throw new Error('private asynchronous cleanup detail')
    },
  ]

  await Promise.all(
    failures.map(async (failure, index) => {
      const bridge = createFakeBridge()
      const updater = createReadyUpdater(bridge)
      const errors: Error[] = []
      updater.on('error', (event) => errors.push(event.error))
      updater.setBeforeRelaunchHandler(failure)
      await updater.start()

      const requestID = `request-${index}`
      const event = {
        type: 'relaunch-requested',
        relaunchRequestID: requestID,
        update: { displayVersion: '2.0.0', version: '200' },
      }
      bridge.emit(event)
      bridge.emit(event)
      await waitForAsyncHandlers()

      assert.deepEqual(bridge.calls.continuedRelaunches, [requestID])
      const [error] = errors
      assert.ok(error instanceof SparkleUpdaterError)
      assert.equal(error.code, 'BEFORE_RELAUNCH_HANDLER_FAILED')
      assert.equal(error.message, 'The application failed to prepare for the update relaunch.')
      assert.equal(error.cause, undefined)
    }),
  )
})

test('handler replacement and clearing affect future relaunch requests', async () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge)
  const preparedVersions: string[] = []
  updater.setBeforeRelaunchHandler(() => {
    preparedVersions.push('initial')
  })
  await updater.start()
  updater.setBeforeRelaunchHandler((update) => {
    preparedVersions.push(update.version)
  })

  bridge.emit({
    type: 'relaunch-requested',
    relaunchRequestID: 'request-3',
    update: { displayVersion: '3.0.0', version: '300' },
  })
  await waitForAsyncHandlers()
  updater.setBeforeRelaunchHandler(null)
  bridge.emit({
    type: 'relaunch-requested',
    relaunchRequestID: 'request-4',
    update: { displayVersion: '4.0.0', version: '400' },
  })
  await waitForAsyncHandlers()

  assert.deepEqual(preparedVersions, ['300'])
  assert.deepEqual(bridge.calls.continuedRelaunches, ['request-3', 'request-4'])
  assert.deepEqual(bridge.calls.relaunchPostponementEnabled, [true, true, false])
})

test('a dispatched relaunch request keeps its captured handler', async () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge)
  const calls: string[] = []
  let finishInitialHandler: (() => void) | undefined
  const initialHandler = new Promise<void>((resolve) => {
    finishInitialHandler = resolve
  })
  updater.setBeforeRelaunchHandler(async () => {
    calls.push('initial')
    await initialHandler
  })
  await updater.start()

  bridge.emit({
    type: 'relaunch-requested',
    relaunchRequestID: 'captured-handler-request',
    update: { displayVersion: '5.0.0', version: '500' },
  })
  await waitForAsyncHandlers()
  updater.setBeforeRelaunchHandler(() => {
    calls.push('replacement')
  })
  finishInitialHandler?.()
  await initialHandler
  await waitForAsyncHandlers()

  assert.deepEqual(calls, ['initial'])
  assert.deepEqual(bridge.calls.continuedRelaunches, ['captured-handler-request'])
})

test('retries a failed asynchronous initialization', async () => {
  const bridge = createFakeBridge()
  let attempts = 0
  const updater = createSparkleUpdater({
    getElectron: () => ({ app: { isReady: () => true } }),
    loadNativeAdapter: () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('first initialization failed')
      }
      return bridge.adapter
    },
    process: READY_PROCESS,
  })

  await assert.rejects(updater.start(), /first initialization failed/)
  await updater.start()
  assert.equal(attempts, 2)
  assert.equal(bridge.calls.start, 1)
})

test('retains buffered configuration when native startup is retried', async () => {
  const bridge = createFakeBridge()
  let nativeStarts = 0
  const retryingAdapter: NativeSparkleAdapter = {
    ...bridge.adapter,
    start: () => {
      nativeStarts += 1
      if (nativeStarts === 1) {
        throw new Error('first native start failed')
      }
      bridge.adapter.start()
    },
  }
  const updater = createSparkleUpdater({
    getElectron: () => ({ app: { isReady: () => true } }),
    loadNativeAdapter: () => retryingAdapter,
    process: READY_PROCESS,
  })
  const headers = { 'X-Example-Authorization': 'initial-placeholder' }
  updater.setHTTPHeaders(headers)
  updater.setBeforeRelaunchHandler(() => undefined)

  await assert.rejects(updater.start(), /first native start failed/)
  headers['X-Example-Authorization'] = 'changed-after-configuration'
  await updater.start()

  assert.equal(nativeStarts, 2)
  assert.deepEqual(bridge.calls.httpHeaders, [
    { 'X-Example-Authorization': 'initial-placeholder' },
    { 'X-Example-Authorization': 'initial-placeholder' },
  ])
  assert.deepEqual(bridge.calls.relaunchPostponementEnabled, [true, true])
})

test('resets its lifecycle when native state validation fails after start', async () => {
  const validBridge = createFakeBridge()
  let attempts = 0
  const updater = createSparkleUpdater({
    getElectron: () => ({ app: { isReady: () => true } }),
    loadNativeAdapter: () => {
      attempts += 1
      if (attempts === 1) {
        return {
          ...validBridge.adapter,
          getState: () => ({
            automaticallyChecksForUpdates: false,
            automaticallyDownloadsUpdates: false,
            canCheckForUpdates: 'invalid',
            sessionInProgress: false,
          }),
        } as unknown as NativeSparkleAdapter
      }
      return validBridge.adapter
    },
    process: READY_PROCESS,
  })

  await assert.rejects(
    updater.start(),
    (error: unknown) =>
      error instanceof SparkleUpdaterError && error.code === 'NATIVE_MODULE_INVALID',
  )
  await updater.start()
  assert.equal(updater.getState().started, true)
  assert.equal(attempts, 2)
})
