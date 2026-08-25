/** Error identifiers returned by the platform-neutral runtime facade. */
export type SparkleUpdaterErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'MAS_UNSUPPORTED'
  | 'ELECTRON_UNAVAILABLE'
  | 'NOT_MAIN_PROCESS'
  | 'ELECTRON_NOT_READY'
  | 'UPDATER_NOT_STARTED'
  | 'NATIVE_MODULE_NOT_FOUND'
  | 'NATIVE_MODULE_INVALID'
  | 'NATIVE_MODULE_LOAD_FAILED'

export interface SparkleUpdaterErrorOptions {
  cause?: unknown
}

/**
 * A recoverable configuration or environment error from `electron-sparkle`.
 * Test `error.code` instead of matching the message.
 */
export class SparkleUpdaterError extends Error {
  readonly code: SparkleUpdaterErrorCode
  override readonly cause?: unknown

  constructor(
    code: SparkleUpdaterErrorCode,
    message: string,
    options: SparkleUpdaterErrorOptions = {},
  ) {
    super(message)
    this.name = 'SparkleUpdaterError'
    this.code = code
    this.cause = options.cause
  }
}

/** Thrown when a control method is called before `await updater.start()`. */
export class UpdaterNotStartedError extends SparkleUpdaterError {
  constructor() {
    super(
      'UPDATER_NOT_STARTED',
      'Call and await updater.start() before controlling the Sparkle updater.',
    )
    this.name = 'UpdaterNotStartedError'
  }
}
