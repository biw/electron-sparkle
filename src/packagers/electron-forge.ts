import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  defaultSparkleAssetProvider,
  installSparkleAssets,
  mergeTargetQualifiedAddonGlob,
} from './native-assets.ts'
import { SparklePackagerConfigurationError } from './errors.ts'
import {
  assertPlainRecord,
  hasMasTarget,
  mergeSparklePlist,
  sparklePlistValues,
} from './options.ts'
import type {
  ElectronForgeConfiguration,
  ElectronForgePackagerConfiguration,
  ElectronSparkleOptions,
  SparkleAssetProvider,
  SparkleAssets,
} from './types.ts'

interface ForgePackageResult {
  readonly platform: string
  readonly arch: string
  readonly outputPaths: readonly string[]
}

const FORGE_PLATFORMS = ['darwin', 'linux', 'mas', 'win32'] as const
const FORGE_ARCHITECTURES = ['ia32', 'x64', 'armv7l', 'arm64', 'mips64el', 'universal'] as const
const FORGE_MAC_ARCHITECTURES = new Set(['x64', 'arm64', 'universal'])
const DARWIN_OUTPUT_SUFFIX = new RegExp(`-darwin-(?:${FORGE_ARCHITECTURES.join('|')})$`)

/**
 * A native Electron Forge 7 plugin that configures and stages Sparkle.
 *
 * The class intentionally implements Forge's plugin shape instead of importing
 * `@electron-forge/plugin-base`: Forge identifies plugins through its internal
 * marker, and avoiding that dependency keeps this optional integration safe to
 * import in projects that use electron-builder only.
 */
export class ElectronSparkle {
  readonly name = 'electron-sparkle'
  readonly config: ElectronSparkleOptions

  /** @internal Electron Forge uses this non-enumerable marker to identify plugins. */
  declare readonly __isElectronForgePlugin: true

  private readonly sparkleValues: ReturnType<typeof sparklePlistValues>
  private readonly configuredAssetProvider: SparkleAssetProvider
  private readonly cachedAssetProvider: SparkleAssetProvider = {
    resolve: (architecture) => this.resolveAssets(architecture),
  }
  private readonly resolvedAssets = new Map<string, Promise<SparkleAssets>>()
  private readonly deferredPackageErrors: Error[] = []

  constructor(config: ElectronSparkleOptions) {
    this.config = config
    this.sparkleValues = sparklePlistValues(config)
    this.configuredAssetProvider = defaultSparkleAssetProvider

    Object.defineProperty(this, '__isElectronForgePlugin', {
      value: true,
      enumerable: false,
      configurable: false,
    })
  }

  /**
   * Seed Forge's shared configuration before project and plugin mutating hooks
   * run. Forge does not thread one plugin's returned replacement into the next
   * plugin, so seeding here keeps Sparkle values independent of plugin order.
   */
  init(_dir: string, forgeConfig: ElectronForgeConfiguration): void {
    mergeSparkleIntoForgeConfig(forgeConfig, this.sparkleValues)
  }

  /**
   * Merge the Info.plist values while Forge resolves configuration, then stage
   * native assets from Forge's own `packageAfterCopy` lifecycle hook. That hook
   * executes before Electron Packager's macOS signing step.
   */
  getHooks() {
    return {
      prePackage: [this.prePackage],
      resolveForgeConfig: this.resolveForgeConfig,
      packageAfterCopy: [this.packageAfterCopy],
      postPackage: [this.postPackage],
    }
  }

  /**
   * Surface missing native artifacts before Electron Packager starts. Forge runs
   * this hook through its normal promise-aware task runner.
   */
  readonly prePackage = async (
    _forgeConfig: ElectronForgeConfiguration,
    platform: string,
    arch: string,
  ): Promise<void> => {
    this.deferredPackageErrors.length = 0
    this.resolvedAssets.clear()

    const platforms = forgePlatformList(platform)
    const targetsMacArchitecture = forgeArchitectureList(arch).some((target) =>
      FORGE_MAC_ARCHITECTURES.has(target),
    )

    if (platforms.includes('mas-dev') || (platforms.includes('mas') && targetsMacArchitecture)) {
      throw new SparklePackagerConfigurationError(
        'electron-sparkle does not support Mac App Store or mas-dev targets.',
      )
    }
    if (platforms.includes('darwin') && targetsMacArchitecture) {
      const architectures = forgeArchitectureList(arch)
      const nativeArchitectures =
        architectures.includes('all') || architectures.includes('universal')
          ? ['arm64', 'x64']
          : architectures.filter((target) => target === 'arm64' || target === 'x64')
      await Promise.all(nativeArchitectures.map((target) => this.resolveAssets(target)))
    }
  }

  readonly resolveForgeConfig = async <T extends ElectronForgeConfiguration>(
    _forgeConfig: ElectronForgeConfiguration,
    currentConfig: T,
  ): Promise<void> => {
    // Revalidate and reassert after the project's resolveForgeConfig hook.
    mergeSparkleIntoForgeConfig(currentConfig, this.sparkleValues)
  }

  readonly packageAfterCopy = async (
    _forgeConfig: ElectronForgeConfiguration,
    buildPath: string,
    _electronVersion: string,
    platform: string,
    arch: string,
  ): Promise<void> => {
    try {
      if (platform === 'mas' || platform === 'mas-dev') {
        throw new SparklePackagerConfigurationError(
          'electron-sparkle does not support Mac App Store or mas-dev targets.',
        )
      }
      if (platform !== 'darwin') {
        return
      }

      await installSparkleAssets(
        resolveForgeAppPathFromAfterCopy(buildPath),
        this.cachedAssetProvider,
        arch,
      )
    } catch (error) {
      // Forge 7 drops promise rejections from packageAfterCopy because it
      // adapts the hook to Electron Packager's callback API. Defer the failure
      // to postPackage, which Forge executes through a promise-aware runner.
      this.deferredPackageErrors.push(normalizeForgePackageError(error))
    }
  }

  /**
   * Re-throw deferred staging errors and verify the final plist after every
   * mutating config hook has run and Electron Packager has written the bundle.
   */
  readonly postPackage = async (
    _forgeConfig: ElectronForgeConfiguration,
    result: ForgePackageResult,
  ): Promise<void> => {
    const deferredErrors = this.deferredPackageErrors.splice(0)
    if (deferredErrors.length === 1) {
      throw deferredErrors[0]
    }
    if (deferredErrors.length > 1) {
      throw new AggregateError(
        deferredErrors,
        'electron-sparkle could not stage Sparkle for one or more Electron Forge packages.',
      )
    }
    const platforms = forgePlatformList(result.platform)
    if (!platforms.includes('darwin') || result.outputPaths.length === 0) {
      return
    }

    const darwinOutputPaths =
      platforms.length === 1
        ? result.outputPaths
        : result.outputPaths.filter(isDarwinForgeOutputPath)

    // Electron Packager omits intentionally skipped targets from outputPaths
    // when overwrite is false. An empty Darwin subset therefore means there
    // is no newly packaged bundle to verify.
    if (darwinOutputPaths.length === 0) {
      return
    }

    await assertPackagedSparklePlist(darwinOutputPaths, this.sparkleValues)
  }

  private resolveAssets(architecture?: string | number): Promise<SparkleAssets> {
    const key = String(architecture ?? process.arch)
    const existing = this.resolvedAssets.get(key)
    if (existing) return existing

    const assets = this.configuredAssetProvider.resolve(architecture)
    this.resolvedAssets.set(key, assets)
    return assets
  }
}

function assertForgeSupportsSparkle(config: ElectronForgeConfiguration): void {
  if (hasMasTarget(config.platform) || hasMasTarget(config.packagerConfig?.platform)) {
    throw new SparklePackagerConfigurationError(
      'electron-sparkle does not support Mac App Store or mas-dev targets.',
    )
  }

  if (
    config.packagerConfig !== undefined &&
    config.packagerConfig !== null &&
    !isPackagerConfiguration(config.packagerConfig)
  ) {
    throw new SparklePackagerConfigurationError('Electron Forge packagerConfig must be an object.')
  }

  const extendInfo = config.packagerConfig?.extendInfo
  if (typeof extendInfo === 'string') {
    throw new SparklePackagerConfigurationError(
      'Electron Forge extendInfo configured as a plist file cannot be merged safely. Use an object instead.',
    )
  }
  if (extendInfo !== undefined && extendInfo !== null) {
    assertPlainRecord(extendInfo, 'Electron Forge extendInfo')
  }
}

function mergeForgeExtendInfo(
  extendInfo: ElectronForgePackagerConfiguration['extendInfo'],
  sparkleValues: ReturnType<typeof sparklePlistValues>,
): Record<string, unknown> {
  if (typeof extendInfo === 'string') {
    throw new SparklePackagerConfigurationError(
      'Electron Forge extendInfo configured as a plist file cannot be merged safely. Use an object instead.',
    )
  }
  return mergeSparklePlist(extendInfo, sparkleValues)
}

function mergeForgeUniversalOptions(
  options: ElectronForgePackagerConfiguration['osxUniversal'],
): Record<string, unknown> & { readonly x64ArchFiles: string } {
  if (options !== undefined && options !== null) {
    assertPlainRecord(options, 'Electron Forge osxUniversal')
    if (
      options.x64ArchFiles !== undefined &&
      options.x64ArchFiles !== null &&
      typeof options.x64ArchFiles !== 'string'
    ) {
      throw new SparklePackagerConfigurationError(
        'Electron Forge osxUniversal.x64ArchFiles must be a string when using electron-sparkle.',
      )
    }
  }

  return {
    ...options,
    x64ArchFiles: mergeTargetQualifiedAddonGlob(options?.x64ArchFiles),
  }
}

function mergeSparkleIntoForgeConfig<T extends ElectronForgeConfiguration>(
  currentConfig: T,
  sparkleValues: ReturnType<typeof sparklePlistValues>,
): void {
  assertForgeSupportsSparkle(currentConfig)

  const packagerConfig = currentConfig.packagerConfig ?? {}
  const extendInfo = mergeForgeExtendInfo(packagerConfig.extendInfo, sparkleValues)
  const osxUniversal = mergeForgeUniversalOptions(packagerConfig.osxUniversal)

  Object.assign(currentConfig, {
    packagerConfig: {
      ...packagerConfig,
      extendInfo,
      osxUniversal,
    },
  })
}

/**
 * Electron Packager passes its copied application source directory to
 * `afterCopy`: `<App>.app/Contents/Resources/app`. Resolve the enclosing
 * bundle directly from that lifecycle path.
 */
function resolveForgeAppPathFromAfterCopy(buildPath: string): string {
  const resourcesPath = dirname(buildPath)
  const contentsPath = dirname(resourcesPath)
  const appPath = dirname(contentsPath)

  if (
    basename(buildPath) !== 'app' ||
    basename(resourcesPath) !== 'Resources' ||
    basename(contentsPath) !== 'Contents' ||
    !appPath.endsWith('.app')
  ) {
    throw new SparklePackagerConfigurationError(
      `Could not determine the macOS .app bundle from Electron Forge packageAfterCopy path ${buildPath}. Expected <App>.app/Contents/Resources/app.`,
    )
  }

  return appPath
}

async function assertPackagedSparklePlist(
  outputPaths: readonly string[],
  sparkleValues: ReturnType<typeof sparklePlistValues>,
): Promise<void> {
  await Promise.all(
    outputPaths.map(async (outputPath) => {
      const appPath = await resolvePackagedForgeAppPath(outputPath)
      const plistPath = join(appPath, 'Contents', 'Info.plist')
      let plistValue: unknown
      try {
        const { parse } = await import('plist')
        const plistContents = await readFile(plistPath)
        plistValue = parse(
          plistContents.subarray(0, 8).toString('ascii') === 'bplist00'
            ? plistContents
            : plistContents.toString('utf8'),
        )
      } catch (error) {
        throw new SparklePackagerConfigurationError(
          `Could not read the packaged Electron Forge Info.plist at ${plistPath}.`,
          { cause: error },
        )
      }

      if (typeof plistValue !== 'object' || plistValue === null || Array.isArray(plistValue)) {
        throw new SparklePackagerConfigurationError(
          `The packaged Electron Forge Info.plist at ${plistPath} is not a dictionary.`,
        )
      }

      const plist = plistValue as Record<string, unknown>
      const mismatchedKeys = Object.entries(sparkleValues)
        .filter(([key, expected]) => plist[key] !== expected)
        .map(([key]) => key)
      if (mismatchedKeys.length > 0) {
        throw new SparklePackagerConfigurationError(
          `The packaged Electron Forge Info.plist is missing or changed electron-sparkle values: ${mismatchedKeys.join(', ')}. Every resolveForgeConfig hook must preserve currentConfig.packagerConfig.extendInfo.`,
        )
      }
    }),
  )
}

function forgePlatformList(platform: string): readonly string[] {
  if (platform === 'all') {
    return FORGE_PLATFORMS
  }

  return platform.split(',').map((target) => target.trim())
}

function forgeArchitectureList(arch: string): readonly string[] {
  if (arch === 'all') {
    return FORGE_ARCHITECTURES
  }

  return arch.split(',').map((target) => target.trim())
}

function isDarwinForgeOutputPath(outputPath: string): boolean {
  return outputPath.endsWith('.app') || DARWIN_OUTPUT_SUFFIX.test(basename(outputPath))
}

async function resolvePackagedForgeAppPath(outputPath: string): Promise<string> {
  if (outputPath.endsWith('.app')) {
    return outputPath
  }

  let appBundles: string[]
  try {
    appBundles = (await readdir(outputPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => entry.name)
  } catch (error) {
    throw new SparklePackagerConfigurationError(
      `Could not inspect Electron Forge package output ${outputPath}.`,
      { cause: error },
    )
  }

  if (appBundles.length !== 1) {
    throw new SparklePackagerConfigurationError(
      `Could not determine the macOS .app bundle in Electron Forge package output ${outputPath}. Expected exactly one top-level .app bundle.`,
    )
  }

  return join(outputPath, appBundles[0]!)
}

function normalizeForgePackageError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new SparklePackagerConfigurationError(
        'electron-sparkle could not stage Sparkle for Electron Forge.',
        { cause: error },
      )
}

function isPackagerConfiguration(value: unknown): value is ElectronForgePackagerConfiguration {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
