import { SparkleUpdaterError } from './errors.ts'

export interface ElectronAppLike {
  isReady(): boolean
  isPackaged?: boolean
}

export interface ElectronModuleLike {
  app?: ElectronAppLike
}

export interface ProcessLike {
  platform: string
  arch?: string
  type?: string
  mas?: boolean
  resourcesPath?: string
  env?: Record<string, string | undefined>
}

export interface RuntimeEnvironment {
  process: ProcessLike
  getElectron(): ElectronModuleLike | undefined
}

export interface ValidatedElectronEnvironment {
  app: ElectronAppLike
  process: ProcessLike
}

/**
 * Validates only Electron and platform prerequisites. Native addon loading
 * deliberately happens afterwards so unsupported systems never resolve a
 * macOS native artifact.
 */
export function validateElectronEnvironment(
  environment: RuntimeEnvironment,
): ValidatedElectronEnvironment {
  const runtimeProcess = environment.process

  if (runtimeProcess.platform !== 'darwin') {
    throw new SparkleUpdaterError(
      'UNSUPPORTED_PLATFORM',
      'electron-sparkle only runs in the macOS Electron main process.',
    )
  }

  if (runtimeProcess.mas === true) {
    throw new SparkleUpdaterError(
      'MAS_UNSUPPORTED',
      'electron-sparkle does not support Mac App Store applications.',
    )
  }

  if (runtimeProcess.type === 'renderer') {
    throw new SparkleUpdaterError(
      'NOT_MAIN_PROCESS',
      "electron-sparkle must be called from Electron's main process.",
    )
  }

  let electron: ElectronModuleLike | undefined
  try {
    electron = environment.getElectron()
  } catch (cause) {
    throw new SparkleUpdaterError(
      'ELECTRON_UNAVAILABLE',
      'electron-sparkle could not load Electron. Install Electron and call it from the main process.',
      { cause },
    )
  }

  if (!electron?.app || typeof electron.app.isReady !== 'function') {
    throw new SparkleUpdaterError(
      'ELECTRON_UNAVAILABLE',
      "electron-sparkle requires Electron's `app` module in the main process.",
    )
  }

  if (!electron.app.isReady()) {
    throw new SparkleUpdaterError(
      'ELECTRON_NOT_READY',
      'Call updater.start() after `await app.whenReady()`.',
    )
  }

  return { app: electron.app, process: runtimeProcess }
}
