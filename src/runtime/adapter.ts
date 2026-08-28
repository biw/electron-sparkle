import type { SparkleUpdaterEvent, SparkleUpdaterState } from './types.ts'

/**
 * The deliberately small boundary between the JavaScript facade and the
 * swift-node module. The native package may expose this shape directly or be
 * adapted by `native-loader.ts`; consumers never interact with it.
 */
export interface NativeSparkleAdapter {
  start(): void
  checkForUpdates(): void
  checkForUpdatesInBackground(): void
  continueRelaunch(requestID: string): boolean
  getState(): NativeSparkleUpdaterState
  setHTTPHeaders(headers: Record<string, string>): void
  setAutomaticallyChecksForUpdates(enabled: boolean): void
  setAutomaticallyDownloadsUpdates(enabled: boolean): void
  setRelaunchPostponementEnabled(enabled: boolean): void
  subscribe(listener: (event: unknown) => void): NativeUnsubscribe | void
}

/** State from the bridge before the runtime adds its own `started` field. */
export interface NativeSparkleUpdaterState extends Omit<SparkleUpdaterState, 'started'> {}

export type NativeUnsubscribe =
  | (() => void)
  | { unsubscribe(): void }
  | { cancel(): void }
  | { [Symbol.dispose](): void }

/** A testable location of the Darwin addon. */
export interface NativeSparkleLocation {
  addonPath: string
  frameworkPath?: string
}

/**
 * Tests and embedders may override how a development addon path is resolved.
 */
export type NativeAddonResolver = () => NativeSparkleLocation | Promise<NativeSparkleLocation>

/** A raw event shape emitted by an adapter is normalized before public use. */
export type NativeSparkleEvent = SparkleUpdaterEvent | Record<string, unknown>
