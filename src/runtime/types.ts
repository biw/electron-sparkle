/**
 * Information about a release reported by Sparkle.
 *
 * Sparkle does not require every appcast item to provide all of these fields,
 * so consumers should treat the optional properties as display hints.
 */
export interface SparkleUpdate {
  /** The machine-readable release version (for example, `42`). */
  version: string
  /** The user-facing version (for example, `4.2.0`). */
  displayVersion: string
  title?: string
  fileURL?: string
  releaseNotesURL?: string
  infoURL?: string
  contentLength?: number
  publicationDate?: Date
}

/** Custom headers Sparkle sends with update-related HTTP requests. */
export type SparkleHTTPHeaders = Readonly<Record<string, string>>

/**
 * Application-owned work that must finish before Sparkle relaunches the app.
 *
 * The returned promise controls the postponement lifetime. Applications that
 * need a deadline should implement one inside this handler.
 */
export type SparkleBeforeRelaunchHandler = (update: SparkleUpdate) => void | Promise<void>

/** The updater state that is safe to present in an Electron main-process UI. */
export interface SparkleUpdaterState {
  /** True once the native updater controller has been initialized. */
  started: boolean
  canCheckForUpdates: boolean
  sessionInProgress: boolean
  automaticallyChecksForUpdates: boolean
  automaticallyDownloadsUpdates: boolean
}

export type SparkleUpdaterEvent =
  | { type: 'state-changed'; state: SparkleUpdaterState }
  | { type: 'update-available'; update: SparkleUpdate }
  | { type: 'update-not-available'; userInitiated?: boolean }
  | { type: 'update-downloaded'; update: SparkleUpdate }
  | { type: 'before-install'; update: SparkleUpdate }
  | { type: 'before-relaunch' }
  | { type: 'cycle-complete' }
  | { type: 'error'; error: Error }

export type SparkleUpdaterEventType = SparkleUpdaterEvent['type']

export type SparkleUpdaterListener<TType extends SparkleUpdaterEventType> = (
  event: Extract<SparkleUpdaterEvent, { type: TType }>,
) => void

/** The runtime API exposed by the `electron-sparkle` package. */
export interface SparkleUpdater {
  /** Initializes Sparkle once. Subsequent calls are no-ops. */
  start(): Promise<void>
  /** Opens Sparkle's standard user-initiated update-check UI. */
  checkForUpdates(): void
  /** Starts a background check without opening the user-initiated check UI. */
  checkForUpdatesInBackground(): void
  /** Returns Sparkle's current state. */
  getState(): SparkleUpdaterState
  /**
   * Replaces the custom headers used for subsequent Sparkle requests.
   *
   * This may be called before start() so the first update cycle is
   * authenticated. An empty object clears all custom headers.
   */
  setHTTPHeaders(headers: SparkleHTTPHeaders): void
  /**
   * Sets the sole handler that may postpone a future Sparkle relaunch.
   *
   * Pass null to restore Sparkle's default relaunch behavior.
   */
  setBeforeRelaunchHandler(handler: SparkleBeforeRelaunchHandler | null): void
  /** Persists whether Sparkle should periodically check for updates. */
  setAutomaticallyChecksForUpdates(enabled: boolean): void
  /** Persists whether Sparkle may download an available update automatically. */
  setAutomaticallyDownloadsUpdates(enabled: boolean): void
  on<TType extends SparkleUpdaterEventType>(
    type: TType,
    listener: SparkleUpdaterListener<TType>,
  ): SparkleUpdater
  off<TType extends SparkleUpdaterEventType>(
    type: TType,
    listener: SparkleUpdaterListener<TType>,
  ): SparkleUpdater
}
