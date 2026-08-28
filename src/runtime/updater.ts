import type { NativeAddonResolver, NativeSparkleAdapter, NativeUnsubscribe } from './adapter.ts'
import { createRequire } from 'node:module'
import { SparkleUpdaterError, UpdaterNotStartedError } from './errors.ts'
import {
  type ElectronModuleLike,
  type ProcessLike,
  validateElectronEnvironment,
} from './environment.ts'
import { loadNativeAdapter, type NativeLoaderContext } from './native-loader.ts'
import type {
  SparkleBeforeRelaunchHandler,
  SparkleHTTPHeaders,
  SparkleUpdate,
  SparkleUpdater,
  SparkleUpdaterEvent,
  SparkleUpdaterEventType,
  SparkleUpdaterListener,
  SparkleUpdaterState,
} from './types.ts'

export interface CreateSparkleUpdaterOptions {
  /** Test-only override for Electron's lazily required main-process module. */
  getElectron?: () => ElectronModuleLike | undefined
  /** Test-only process facade; defaults to the real Node/Electron process. */
  process?: ProcessLike
  /** Test-only adapter override. It is never evaluated until `start()`. */
  loadNativeAdapter?: (
    context: NativeLoaderContext,
  ) => NativeSparkleAdapter | Promise<NativeSparkleAdapter>
  /** Test-only development addon resolver. */
  resolveNativeAddon?: NativeAddonResolver
}

/**
 * Internal factory used by the package's test suite. The package root exports
 * only the lazy `updater` singleton.
 */
export function createSparkleUpdater(options: CreateSparkleUpdaterOptions = {}): SparkleUpdater {
  const runtimeProcess = options.process ?? process
  const getElectron = options.getElectron ?? getElectronModule
  const listeners = new Map<SparkleUpdaterEventType, Set<(event: SparkleUpdaterEvent) => void>>()
  const handledRelaunchRequestIDs = new Set<string>()
  let adapter: NativeSparkleAdapter | undefined
  let adapterPromise: Promise<NativeSparkleAdapter> | undefined
  let beforeRelaunchHandler: SparkleBeforeRelaunchHandler | null = null
  let httpHeaders: Record<string, string> = {}
  let startPromise: Promise<void> | undefined
  let started = false

  const validate = () => validateElectronEnvironment({ process: runtimeProcess, getElectron })

  const getAdapter = async (context: NativeLoaderContext): Promise<NativeSparkleAdapter> => {
    if (!adapterPromise) {
      adapterPromise = Promise.resolve(
        options.loadNativeAdapter
          ? options.loadNativeAdapter(context)
          : loadNativeAdapter(
              context,
              options.resolveNativeAddon ? { resolveNativeAddon: options.resolveNativeAddon } : {},
            ),
      ).then((resolvedAdapter) => {
        adapter = resolvedAdapter
        return resolvedAdapter
      })
    }
    return adapterPromise
  }

  const getState = (): SparkleUpdaterState => {
    validate()
    const nativeState = normalizeState(requireStarted().getState())

    return { started, ...nativeState }
  }

  const updater: SparkleUpdater = {
    start(): Promise<void> {
      const context = validate()
      if (started) {
        return Promise.resolve()
      }
      if (startPromise) {
        return startPromise
      }

      startPromise = getAdapter(context)
        .then((nativeAdapter) => {
          const subscription = nativeAdapter.subscribe(dispatchNativeEvent)
          try {
            nativeAdapter.setHTTPHeaders({ ...httpHeaders })
            nativeAdapter.setRelaunchPostponementEnabled(beforeRelaunchHandler !== null)
            nativeAdapter.start()
            started = true
            dispatch({ type: 'state-changed', state: getState() })
            // Keep the stream handle on the returned updater object.
            // swift-node cancels an unreferenced stream handle, while Sparkle
            // has no stop lifecycle during a normal Electron process.
            retainNativeSubscription(updater, subscription)
          } catch (error) {
            unsubscribe(subscription)
            throw error
          }
        })
        .catch((error: unknown) => {
          adapter = undefined
          adapterPromise = undefined
          startPromise = undefined
          started = false
          throw error
        })
      return startPromise
    },

    checkForUpdates(): void {
      validate()
      requireStarted().checkForUpdates()
    },

    checkForUpdatesInBackground(): void {
      validate()
      requireStarted().checkForUpdatesInBackground()
    },

    getState,

    setHTTPHeaders(headers: SparkleHTTPHeaders): void {
      const copiedHeaders = copyHTTPHeaders(headers)
      if (started) {
        requireStarted().setHTTPHeaders(copiedHeaders)
      }
      httpHeaders = copiedHeaders
    },

    setBeforeRelaunchHandler(handler: SparkleBeforeRelaunchHandler | null): void {
      assertBeforeRelaunchHandler(handler)
      if (started) {
        requireStarted().setRelaunchPostponementEnabled(handler !== null)
      }
      beforeRelaunchHandler = handler
    },

    setAutomaticallyChecksForUpdates(enabled: boolean): void {
      assertBoolean(enabled, 'setAutomaticallyChecksForUpdates')
      validate()
      requireStarted().setAutomaticallyChecksForUpdates(enabled)
    },

    setAutomaticallyDownloadsUpdates(enabled: boolean): void {
      assertBoolean(enabled, 'setAutomaticallyDownloadsUpdates')
      validate()
      requireStarted().setAutomaticallyDownloadsUpdates(enabled)
    },

    on<TType extends SparkleUpdaterEventType>(
      type: TType,
      listener: SparkleUpdaterListener<TType>,
    ): SparkleUpdater {
      assertEventListener(type, listener)
      const eventListeners = listeners.get(type) ?? new Set<(event: SparkleUpdaterEvent) => void>()
      eventListeners.add(listener as unknown as (event: SparkleUpdaterEvent) => void)
      listeners.set(type, eventListeners)
      return updater
    },

    off<TType extends SparkleUpdaterEventType>(
      type: TType,
      listener: SparkleUpdaterListener<TType>,
    ): SparkleUpdater {
      assertEventListener(type, listener)
      listeners.get(type)?.delete(listener as unknown as (event: SparkleUpdaterEvent) => void)
      return updater
    },
  }

  function dispatchNativeEvent(value: unknown): void {
    if (isRecord(value) && value.type === 'relaunch-requested') {
      handleRelaunchRequest(value)
      return
    }

    const event = normalizeEvent(value, started)
    if (event) {
      dispatch(event)
    }
  }

  function dispatch(event: SparkleUpdaterEvent): void {
    const eventListeners = listeners.get(event.type)
    if (!eventListeners) {
      return
    }

    for (const listener of eventListeners) {
      try {
        listener(event)
      } catch (error) {
        // An application listener must not roll back a successful native
        // initialization. Preserve Node's usual visible failure semantics,
        // but report it after this lifecycle callback returns.
        queueMicrotask(() => {
          throw error
        })
      }
    }
  }

  function handleRelaunchRequest(value: Record<string, unknown>): void {
    const requestID = value.relaunchRequestID
    if (typeof requestID !== 'string' || requestID.length === 0) {
      dispatchInvalidNativeEvent('The native addon emitted an invalid relaunch request.')
      return
    }
    if (handledRelaunchRequestIDs.has(requestID)) {
      return
    }
    handledRelaunchRequestIDs.add(requestID)

    const update = normalizeUpdate(value.update)
    if (!update) {
      dispatchInvalidNativeEvent('The native addon emitted a relaunch request without an update.')
      continueRelaunch(requestID)
      return
    }

    const handler = beforeRelaunchHandler
    if (!handler) {
      continueRelaunch(requestID)
      return
    }

    void Promise.resolve()
      .then(() => handler(update))
      .then(
        () => continueRelaunch(requestID),
        () => {
          dispatch({
            type: 'error',
            error: new SparkleUpdaterError(
              'BEFORE_RELAUNCH_HANDLER_FAILED',
              'The application failed to prepare for the update relaunch.',
            ),
          })
          continueRelaunch(requestID)
        },
      )
  }

  function continueRelaunch(requestID: string): void {
    try {
      adapter?.continueRelaunch(requestID)
    } catch (cause) {
      dispatch({
        type: 'error',
        error: new SparkleUpdaterError(
          'NATIVE_MODULE_INVALID',
          'The native addon could not continue the postponed update relaunch.',
          { cause },
        ),
      })
    }
  }

  function dispatchInvalidNativeEvent(message: string): void {
    dispatch({
      type: 'error',
      error: new SparkleUpdaterError('NATIVE_MODULE_INVALID', message),
    })
  }

  function requireStarted(): NativeSparkleAdapter {
    if (started && adapter) {
      return adapter
    }

    throw new UpdaterNotStartedError()
  }
  return updater
}

/** The sole public singleton, intentionally inert until a method is invoked. */
export const updater = createSparkleUpdater()

const runtimeRequire = createRequire(import.meta.url)

function getElectronModule(): ElectronModuleLike | undefined {
  // No top-level Electron import: this module must be safe to import from
  // Windows/Linux Node processes and renderer bundles.
  try {
    return runtimeRequire('electron') as ElectronModuleLike
  } catch {
    return undefined
  }
}

function normalizeState(value: unknown): Omit<SparkleUpdaterState, 'started'> {
  if (!isRecord(value)) {
    throw new SparkleUpdaterError(
      'NATIVE_MODULE_INVALID',
      'The electron-sparkle native addon returned an invalid updater state.',
    )
  }

  return {
    canCheckForUpdates: readBooleanState(value, 'canCheckForUpdates'),
    sessionInProgress: readBooleanState(value, 'sessionInProgress'),
    automaticallyChecksForUpdates: readBooleanState(value, 'automaticallyChecksForUpdates'),
    automaticallyDownloadsUpdates: readBooleanState(value, 'automaticallyDownloadsUpdates'),
  }
}

function readBooleanState(
  state: Record<string, unknown>,
  key: keyof Omit<SparkleUpdaterState, 'started'>,
): boolean {
  const value = state[key]
  if (typeof value !== 'boolean') {
    throw new SparkleUpdaterError(
      'NATIVE_MODULE_INVALID',
      `The electron-sparkle native addon returned an invalid ${key} state value.`,
    )
  }
  return value
}

function normalizeEvent(value: unknown, started: boolean): SparkleUpdaterEvent | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return undefined
  }

  switch (value.type) {
    case 'state-changed': {
      if (!isRecord(value.state)) return undefined
      return {
        type: 'state-changed',
        state: {
          started,
          ...normalizeState(value.state),
        },
      }
    }
    case 'update-available':
    case 'update-downloaded':
    case 'before-install': {
      const update = normalizeUpdate(value.update)
      return update ? { type: value.type, update } : undefined
    }
    case 'update-not-available':
      return {
        type: 'update-not-available',
        ...(typeof value.userInitiated === 'boolean' ? { userInitiated: value.userInitiated } : {}),
      }
    case 'before-relaunch':
    case 'cycle-complete':
      return { type: value.type }
    case 'error':
      return { type: 'error', error: toError(value.error) }
    default:
      return undefined
  }
}

function normalizeUpdate(value: unknown): SparkleUpdate | undefined {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    typeof value.displayVersion !== 'string'
  ) {
    return undefined
  }

  const publicationDate = toDate(value.publicationDate)
  return {
    version: value.version,
    displayVersion: value.displayVersion,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.fileURL === 'string' ? { fileURL: value.fileURL } : {}),
    ...(typeof value.releaseNotesURL === 'string'
      ? { releaseNotesURL: value.releaseNotesURL }
      : {}),
    ...(typeof value.infoURL === 'string' ? { infoURL: value.infoURL } : {}),
    ...(typeof value.contentLength === 'number' ? { contentLength: value.contentLength } : {}),
    ...(publicationDate ? { publicationDate } : {}),
  }
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
  }

  return undefined
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value
  }

  if (typeof value === 'string') {
    return new Error(value)
  }

  if (isRecord(value)) {
    const error = new Error(
      typeof value.message === 'string'
        ? value.message
        : 'Sparkle reported an unknown updater error.',
    ) as Error & { code?: number | string; domain?: string }

    if (typeof value.domain === 'string') {
      error.domain = value.domain
    }
    if (typeof value.code === 'string' || typeof value.code === 'number') {
      error.code = value.code
    }
    return error
  }

  return new Error('Sparkle reported an unknown updater error.')
}

function assertBoolean(value: boolean, methodName: string): void {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${methodName} expects a boolean.`)
  }
}

function assertBeforeRelaunchHandler(
  value: unknown,
): asserts value is SparkleBeforeRelaunchHandler | null {
  if (value !== null && typeof value !== 'function') {
    throw new TypeError('setBeforeRelaunchHandler expects a function or null.')
  }
}

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function copyHTTPHeaders(value: unknown): Record<string, string> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('setHTTPHeaders expects a plain string-to-string object.')
  }

  const normalizedNames = new Set<string>()
  const entries: Array<[string, string]> = []
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    const headerValue = 'value' in descriptor ? descriptor.value : undefined
    const normalizedName = name.toLowerCase()
    if (
      !descriptor.enumerable ||
      !HTTP_HEADER_NAME_PATTERN.test(name) ||
      typeof headerValue !== 'string' ||
      headerValue.includes('\r') ||
      headerValue.includes('\n') ||
      normalizedNames.has(normalizedName)
    ) {
      throw new TypeError('setHTTPHeaders received an invalid header object.')
    }
    normalizedNames.add(normalizedName)
    entries.push([name, headerValue])
  }

  return Object.fromEntries(entries)
}

function assertEventListener(
  type: SparkleUpdaterEventType,
  listener: unknown,
): asserts listener is SparkleUpdaterListener<SparkleUpdaterEventType> {
  if (!isEventType(type)) {
    throw new TypeError(`Unknown electron-sparkle event: ${String(type)}.`)
  }

  if (typeof listener !== 'function') {
    throw new TypeError('electron-sparkle event listeners must be functions.')
  }
}

function isEventType(value: string): value is SparkleUpdaterEventType {
  return (
    value === 'state-changed' ||
    value === 'update-available' ||
    value === 'update-not-available' ||
    value === 'update-downloaded' ||
    value === 'before-install' ||
    value === 'before-relaunch' ||
    value === 'cycle-complete' ||
    value === 'error'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const nativeSubscription = Symbol('electron-sparkle.nativeSubscription')

function retainNativeSubscription(
  runtimeUpdater: SparkleUpdater,
  subscription: NativeUnsubscribe | void,
): void {
  Object.defineProperty(runtimeUpdater, nativeSubscription, {
    configurable: false,
    enumerable: false,
    value: subscription,
    writable: false,
  })
}

function unsubscribe(subscription: NativeUnsubscribe | void): void {
  if (!subscription) {
    return
  }

  if (typeof subscription === 'function') {
    subscription()
    return
  }
  if ('unsubscribe' in subscription) {
    subscription.unsubscribe()
    return
  }
  if ('cancel' in subscription) {
    subscription.cancel()
    return
  }
  subscription[Symbol.dispose]?.()
}
