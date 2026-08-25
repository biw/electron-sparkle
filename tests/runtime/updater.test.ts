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
    start: number
    checkForUpdates: number
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
    start: 0,
    checkForUpdates: 0,
    automaticallyChecksForUpdates: [] as boolean[],
    automaticallyDownloadsUpdates: [] as boolean[],
  }

  return {
    adapter: {
      start: () => {
        calls.start += 1
      },
      checkForUpdates: () => {
        calls.checkForUpdates += 1
      },
      getState: () => state,
      setAutomaticallyChecksForUpdates: (enabled) => {
        calls.automaticallyChecksForUpdates.push(enabled)
      },
      setAutomaticallyDownloadsUpdates: (enabled) => {
        calls.automaticallyDownloadsUpdates.push(enabled)
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

test('requires start before controlling Sparkle', () => {
  const bridge = createFakeBridge()
  const updater = createReadyUpdater(bridge)

  assert.throws(() => updater.checkForUpdates(), UpdaterNotStartedError)
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
    getState: () => ({
      automaticallyChecksForUpdates: false,
      automaticallyDownloadsUpdates: false,
      canCheckForUpdates: true,
      sessionInProgress: false,
    }),
    setAutomaticallyChecksForUpdates: () => undefined,
    setAutomaticallyDownloadsUpdates: () => undefined,
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
  assert.deepEqual(bridge.calls.automaticallyChecksForUpdates, [false])
  assert.deepEqual(bridge.calls.automaticallyDownloadsUpdates, [true])
  assert.deepEqual(available, ['200'])
  assert.deepEqual(fileURLs, ['https://updates.example.test/App-2.0.0.zip'])
  assert.deepEqual(notAvailableChecks, [true])
  assert.equal(errors[0]?.message, 'network unavailable')
  assert.equal((errors[0] as Error & { code?: number }).code, 42)
  assert.equal((errors[0] as Error & { domain?: string }).domain, 'SUSparkleErrorDomain')
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
