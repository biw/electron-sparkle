/**
 * Options written to the application Info.plist for Sparkle.
 *
 * The two required values deliberately live in the packaged app rather than
 * JavaScript so Sparkle can validate an update before Electron starts.
 */
export interface ElectronSparkleOptions {
  readonly SUFeedURL: string
  readonly SUPublicEDKey: string
  readonly SUEnableAutomaticChecks?: boolean
  readonly SUAutomaticallyUpdate?: boolean
  readonly SUAllowsAutomaticUpdates?: boolean
  readonly SUScheduledCheckInterval?: number
  readonly SUShowReleaseNotes?: boolean
}

/** The native paths and accompanying license copied into an application bundle. */
export interface SparkleAssets {
  readonly frameworkPath: string
  readonly addonPath: string
  readonly licensePath: string
  readonly packageVersion: string
  readonly sparkleVersion: string
}

/** A lazy provider keeps packager entry points safe to import on non-macOS systems. */
export interface SparkleAssetProvider {
  resolve(architecture?: string | number): Promise<SparkleAssets>
}

export interface BuilderAfterPackContext {
  readonly appOutDir: string
  readonly arch?: string | number
  readonly electronPlatformName: string
  readonly packager?: {
    readonly appInfo?: {
      readonly productFilename?: string
    }
    readonly platformSpecificBuildOptions?: {
      x64ArchFiles?: string | null
    }
  }
}

export type BuilderAfterPackHook = {
  bivarianceHack(context: BuilderAfterPackContext): void | Promise<void>
}['bivarianceHack']

export interface ElectronForgePackagerConfiguration {
  readonly extendInfo?: Record<string, unknown> | string | null
  readonly osxSign?: boolean | Record<string, unknown> | null
  readonly platform?: string
  readonly osxUniversal?:
    | ({ readonly x64ArchFiles?: string | null } & Record<string, unknown>)
    | null
}

/** A structural subset; importing Electron Forge is intentionally unnecessary. */
export interface ElectronForgeConfiguration {
  readonly packagerConfig?: ElectronForgePackagerConfiguration | null
  readonly platform?: string
}
