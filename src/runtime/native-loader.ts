import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import type {
  NativeAddonResolver,
  NativeSparkleAdapter,
  NativeSparkleLocation,
  NativeUnsubscribe,
} from './adapter.ts'
import { SparkleUpdaterError } from './errors.ts'
import type { ElectronAppLike, ProcessLike } from './environment.ts'

const nativeRequire = createRequire(import.meta.url)

export const NATIVE_ADDON_FILENAME = 'electron_sparkle.node'

export interface NativeLoaderContext {
  app: ElectronAppLike
  process: ProcessLike
}

export interface NativeModuleLoaderOptions {
  resolveNativeAddon?: NativeAddonResolver
}

interface StreamHandle {
  cancel?: () => void
  unsubscribe?: () => void
  [Symbol.dispose]?: () => void
}

interface StreamNativeModule {
  start?: unknown
  checkForUpdates?: unknown
  checkForUpdatesInBackground?: unknown
  continueRelaunch?: unknown
  getState?: unknown
  setHTTPHeaders?: unknown
  setAutomaticallyChecksForUpdates?: unknown
  setAutomaticallyDownloadsUpdates?: unknown
  setRelaunchPostponementEnabled?: unknown
  subscribe?: unknown
  events?: unknown
  createAdapter?: unknown
  default?: unknown
}

/** The fixed post-packaging location mandated by Electron's macOS layout. */
export function getPackagedAddonPath(resourcesPath: string): string {
  return resolve(resourcesPath, '..', 'Frameworks', NATIVE_ADDON_FILENAME)
}

/**
 * Resolves an addon without importing it. This keeps `import "electron-sparkle"`
 * harmless on Windows and Linux.
 */
export async function resolveNativeAddonPath(
  context: NativeLoaderContext,
  options: NativeModuleLoaderOptions = {},
): Promise<string> {
  const packagedPath = context.process.resourcesPath
    ? getPackagedAddonPath(context.process.resourcesPath)
    : undefined

  if (context.app.isPackaged) {
    if (packagedPath && existsSync(packagedPath)) {
      return packagedPath
    }

    throw new SparkleUpdaterError(
      'NATIVE_MODULE_NOT_FOUND',
      `Could not find ${NATIVE_ADDON_FILENAME} in the packaged app's Contents/Frameworks directory. Configure electron-sparkle's packager helper before signing.`,
    )
  }

  const explicitPath = context.process.env?.ELECTRON_SPARKLE_NATIVE_PATH
  if (explicitPath) {
    return explicitPath
  }

  if (options.resolveNativeAddon) {
    const location = await options.resolveNativeAddon()
    return validateLocation(location)
  }

  return resolveDefaultDevelopmentAddon(context.process.arch)
}

/** Loads and validates the native bridge only after runtime preconditions pass. */
export async function loadNativeAdapter(
  context: NativeLoaderContext,
  options: NativeModuleLoaderOptions = {},
): Promise<NativeSparkleAdapter> {
  const addonPath = await resolveNativeAddonPath(context, options)

  if (!existsSync(addonPath)) {
    throw new SparkleUpdaterError(
      'NATIVE_MODULE_NOT_FOUND',
      `Could not find the electron-sparkle native addon at ${addonPath}.`,
    )
  }

  let nativeModule: unknown
  try {
    nativeModule = nativeRequire(addonPath)
  } catch (cause) {
    throw new SparkleUpdaterError(
      'NATIVE_MODULE_LOAD_FAILED',
      `Could not load the electron-sparkle native addon at ${addonPath}. Ensure Sparkle.framework is available in Contents/Frameworks.`,
      { cause },
    )
  }

  return toNativeAdapter(nativeModule)
}

/**
 * Converts either the final adapter shape or swift-node's `events` stream into
 * the stable adapter interface. Keeping this translation here lets the Swift
 * package evolve without changing the public JavaScript API.
 */
export function toNativeAdapter(nativeModule: unknown): NativeSparkleAdapter {
  const module = unwrapModule(nativeModule)
  assertFunction(module, 'start')
  assertFunction(module, 'checkForUpdates')
  assertFunction(module, 'checkForUpdatesInBackground')
  assertFunction(module, 'continueRelaunch')
  assertFunction(module, 'getState')
  assertFunction(module, 'setHTTPHeaders')
  assertFunction(module, 'setAutomaticallyChecksForUpdates')
  assertFunction(module, 'setAutomaticallyDownloadsUpdates')
  assertFunction(module, 'setRelaunchPostponementEnabled')

  const continueRelaunch = (requestID: string): boolean => {
    const result = module.continueRelaunch!(requestID)
    if (typeof result !== 'boolean') {
      throw new SparkleUpdaterError(
        'NATIVE_MODULE_INVALID',
        'The electron-sparkle native addon returned an invalid relaunch continuation result.',
      )
    }
    return result
  }

  if (typeof module.subscribe === 'function') {
    return {
      start: () => module.start!(),
      checkForUpdates: () => module.checkForUpdates!(),
      checkForUpdatesInBackground: () => module.checkForUpdatesInBackground!(),
      continueRelaunch,
      getState: () => module.getState!() as ReturnType<NativeSparkleAdapter['getState']>,
      setHTTPHeaders: (headers) => module.setHTTPHeaders!(headers),
      setAutomaticallyChecksForUpdates: (enabled) =>
        module.setAutomaticallyChecksForUpdates!(enabled),
      setAutomaticallyDownloadsUpdates: (enabled) =>
        module.setAutomaticallyDownloadsUpdates!(enabled),
      setRelaunchPostponementEnabled: (enabled) => module.setRelaunchPostponementEnabled!(enabled),
      subscribe: (listener) => module.subscribe!(listener) as NativeUnsubscribe | void,
    }
  }

  if (typeof module.events === 'function') {
    return {
      start: () => module.start!(),
      checkForUpdates: () => module.checkForUpdates!(),
      checkForUpdatesInBackground: () => module.checkForUpdatesInBackground!(),
      continueRelaunch,
      getState: () => module.getState!() as ReturnType<NativeSparkleAdapter['getState']>,
      setHTTPHeaders: (headers) => module.setHTTPHeaders!(headers),
      setAutomaticallyChecksForUpdates: (enabled) =>
        module.setAutomaticallyChecksForUpdates!(enabled),
      setAutomaticallyDownloadsUpdates: (enabled) =>
        module.setAutomaticallyDownloadsUpdates!(enabled),
      setRelaunchPostponementEnabled: (enabled) => module.setRelaunchPostponementEnabled!(enabled),
      subscribe: (listener) => {
        const stream = module.events as (
          onValue: (event: unknown) => void,
          onError?: (error: unknown) => void,
        ) => StreamHandle | undefined
        const handle = stream(listener, (error) => listener({ type: 'error', error }))
        return toUnsubscribe(handle)
      },
    }
  }

  throw new SparkleUpdaterError(
    'NATIVE_MODULE_INVALID',
    'The electron-sparkle native addon does not expose `subscribe` or swift-node `events`.',
  )
}

function validateLocation(location: NativeSparkleLocation): string {
  if (!location || typeof location.addonPath !== 'string' || !location.addonPath) {
    throw new SparkleUpdaterError(
      'NATIVE_MODULE_NOT_FOUND',
      'The electron-sparkle native addon resolver did not provide an addon path.',
    )
  }

  return location.addonPath
}

async function resolveDefaultDevelopmentAddon(architecture?: string): Promise<string> {
  try {
    // Keep artifact resolution lazy so importing electron-sparkle remains
    // harmless on Windows and Linux.
    const { materializeDarwinDistribution } = await import('../tooling/artifacts.ts')
    return (await materializeDarwinDistribution({ architecture })).addonPath
  } catch (cause) {
    throw new SparkleUpdaterError(
      'NATIVE_MODULE_NOT_FOUND',
      'Could not resolve electron-sparkle’s macOS development addon. Reinstall electron-sparkle from a complete published package.',
      { cause },
    )
  }
}

function unwrapModule(nativeModule: unknown): StreamNativeModule {
  if (!isRecord(nativeModule)) {
    throw new SparkleUpdaterError(
      'NATIVE_MODULE_INVALID',
      'The electron-sparkle native addon did not export an object.',
    )
  }

  if (typeof nativeModule.createAdapter === 'function') {
    let adapter: unknown
    try {
      adapter = nativeModule.createAdapter()
    } catch (cause) {
      throw new SparkleUpdaterError(
        'NATIVE_MODULE_INVALID',
        "The electron-sparkle native addon's createAdapter() failed.",
        { cause },
      )
    }
    if (!isRecord(adapter)) {
      throw new SparkleUpdaterError(
        'NATIVE_MODULE_INVALID',
        "The electron-sparkle native addon's createAdapter() did not return an object.",
      )
    }
    return adapter
  }

  if (isRecord(nativeModule.default)) {
    return nativeModule.default
  }

  return nativeModule
}

function assertFunction(
  module: StreamNativeModule,
  property: keyof StreamNativeModule,
): asserts module is StreamNativeModule & Record<typeof property, Function> {
  if (typeof module[property] !== 'function') {
    throw new SparkleUpdaterError(
      'NATIVE_MODULE_INVALID',
      `The electron-sparkle native addon is missing ${property}().`,
    )
  }
}

function toUnsubscribe(handle: StreamHandle | undefined): NativeUnsubscribe | undefined {
  if (!handle) {
    return undefined
  }

  if (typeof handle.unsubscribe === 'function') {
    return { unsubscribe: () => handle.unsubscribe!() }
  }

  if (typeof handle.cancel === 'function') {
    return { cancel: () => handle.cancel!() }
  }

  if (typeof handle[Symbol.dispose] === 'function') {
    return { [Symbol.dispose]: () => handle[Symbol.dispose]!() }
  }

  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
