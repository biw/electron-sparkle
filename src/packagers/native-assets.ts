import { createRequire } from 'node:module'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { materializeDarwinDistribution, SPARKLE_VERSION } from '../tooling/artifacts.ts'
import { SparklePackagerConfigurationError } from './errors.ts'
import type { SparkleAssetProvider, SparkleAssets } from './types.ts'

const FRAMEWORK_NAME = 'Sparkle.framework'
const ADDON_NAME = 'electron_sparkle.node'
const LICENSE_NAME = 'Sparkle-LICENSE.txt'
const INSTALL_MARKER_NAME = '.electron-sparkle.json'
const INSTALL_SCHEMA_VERSION = 1
const PACKAGE_NAME = 'electron-sparkle'
const TARGET_QUALIFIED_ADDON_GLOB = '**/electron-sparkle/dist/electron_sparkle.darwin-*.node'

interface InstallMarker {
  readonly schemaVersion: number
  readonly packageName: string
  readonly packageVersion: string
  readonly sparkleVersion: string
}

const requireFromHere = createRequire(import.meta.url)

/** Keep identical target prebuilds from confusing @electron/universal. */
export function mergeTargetQualifiedAddonGlob(existing?: string | null): string {
  if (!existing) return TARGET_QUALIFIED_ADDON_GLOB
  if (existing.includes(TARGET_QUALIFIED_ADDON_GLOB)) return existing
  return `{${existing},${TARGET_QUALIFIED_ADDON_GLOB}}`
}

export async function installSparkleAssets(
  appPath: string,
  assetProvider: SparkleAssetProvider,
  architecture?: string | number,
): Promise<void> {
  const assets = await assetProvider.resolve(architecture)
  await assertSourceAssets(assets)

  const resourcesPath = join(appPath, 'Contents', 'Resources')
  const frameworksPath = join(appPath, 'Contents', 'Frameworks')
  const frameworkDestination = join(frameworksPath, FRAMEWORK_NAME)
  const addonDestination = join(frameworksPath, ADDON_NAME)
  const licensesPath = join(resourcesPath, 'ThirdPartyLicenses')
  const licenseDestination = join(licensesPath, LICENSE_NAME)
  // Contents/Frameworks may contain code only. Keeping package metadata there
  // makes Developer ID signing treat the JSON marker as an unsigned code object.
  const markerPath = join(resourcesPath, INSTALL_MARKER_NAME)

  await Promise.all([
    mkdir(resourcesPath, { recursive: true }),
    mkdir(frameworksPath, { recursive: true }),
    mkdir(licensesPath, { recursive: true }),
  ])
  const [marker, frameworkExists, addonExists] = await Promise.all([
    readInstallMarker(markerPath),
    pathExists(frameworkDestination),
    pathExists(addonDestination),
  ])

  if ((frameworkExists || addonExists) && !isElectronSparkleMarker(marker)) {
    throw new SparklePackagerConfigurationError(
      `Cannot install Sparkle because ${frameworksPath} already contains ${frameworkExists ? FRAMEWORK_NAME : ADDON_NAME} without an electron-sparkle install marker.`,
    )
  }

  const tempSuffix = `.electron-sparkle-${process.pid}-${Math.random().toString(16).slice(2)}`
  const frameworkTemporaryPath = `${frameworkDestination}${tempSuffix}`
  const addonTemporaryPath = `${addonDestination}${tempSuffix}`
  const licenseTemporaryPath = `${licenseDestination}${tempSuffix}`

  try {
    await cp(assets.frameworkPath, frameworkTemporaryPath, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    })
    await cp(assets.addonPath, addonTemporaryPath, {
      dereference: false,
      verbatimSymlinks: true,
    })
    await cp(assets.licensePath, licenseTemporaryPath, {
      dereference: false,
      verbatimSymlinks: true,
    })

    await Promise.all([
      rm(frameworkDestination, { recursive: true, force: true }),
      rm(addonDestination, { force: true }),
      rm(licenseDestination, { force: true }),
    ])
    await rename(frameworkTemporaryPath, frameworkDestination)
    await rename(addonTemporaryPath, addonDestination)
    await rename(licenseTemporaryPath, licenseDestination)
    await writeFile(markerPath, `${JSON.stringify(createInstallMarker(assets), null, 2)}\n`, 'utf8')
  } catch (error) {
    await Promise.all([
      rm(frameworkTemporaryPath, { recursive: true, force: true }),
      rm(addonTemporaryPath, { force: true }),
      rm(licenseTemporaryPath, { force: true }),
    ])
    throw error
  }
}

export async function resolveBuilderAppPath(context: {
  readonly appOutDir: string
  readonly packager?: { readonly appInfo?: { readonly productFilename?: string } }
}): Promise<string> {
  const productFilename = context.packager?.appInfo?.productFilename
  if (productFilename) {
    return join(context.appOutDir, `${productFilename}.app`)
  }

  const appBundles = (await readdir(context.appOutDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => entry.name)

  if (appBundles.length === 1) {
    return join(context.appOutDir, appBundles[0]!)
  }

  throw new SparklePackagerConfigurationError(
    `Could not determine the macOS .app bundle in ${context.appOutDir}. electron-builder must provide packager.appInfo.productFilename or stage exactly one .app bundle.`,
  )
}

/** This default resolves the target-qualified addon published in this package. */
export const defaultSparkleAssetProvider: SparkleAssetProvider = {
  async resolve(architecture): Promise<SparkleAssets> {
    const distribution = await materializeDarwinDistribution({ architecture })
    const packageVersion = await resolvePackageVersion()

    return {
      frameworkPath: distribution.frameworkPath,
      addonPath: distribution.addonPath,
      licensePath: distribution.licensePath,
      packageVersion,
      sparkleVersion: SPARKLE_VERSION,
    }
  },
}

async function assertSourceAssets(assets: SparkleAssets): Promise<void> {
  if (
    !assets ||
    typeof assets.frameworkPath !== 'string' ||
    typeof assets.addonPath !== 'string' ||
    typeof assets.licensePath !== 'string'
  ) {
    throw new SparklePackagerConfigurationError(
      'The electron-sparkle asset provider returned invalid framework, addon, or license paths.',
    )
  }

  try {
    const [framework, addon, license] = await Promise.all([
      stat(assets.frameworkPath),
      stat(assets.addonPath),
      stat(assets.licensePath),
    ])
    if (!framework.isDirectory() || !addon.isFile() || !license.isFile()) {
      throw new Error('Unexpected asset file types.')
    }
  } catch (error) {
    throw new SparklePackagerConfigurationError(
      'The electron-sparkle asset provider returned a missing or invalid framework, addon, or license path.',
      { cause: error },
    )
  }
}

function createInstallMarker(assets: SparkleAssets): InstallMarker {
  return {
    schemaVersion: INSTALL_SCHEMA_VERSION,
    packageName: PACKAGE_NAME,
    packageVersion: assets.packageVersion,
    sparkleVersion: assets.sparkleVersion,
  }
}

async function readInstallMarker(markerPath: string): Promise<InstallMarker | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(markerPath, 'utf8'))
    if (!isInstallMarker(value)) {
      return undefined
    }
    return value
  } catch (error) {
    if (isNotFound(error)) {
      return undefined
    }
    return undefined
  }
}

function isInstallMarker(value: unknown): value is InstallMarker {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const marker = value as Record<string, unknown>
  return (
    marker.schemaVersion === INSTALL_SCHEMA_VERSION &&
    marker.packageName === PACKAGE_NAME &&
    typeof marker.packageVersion === 'string' &&
    typeof marker.sparkleVersion === 'string'
  )
}

function isElectronSparkleMarker(marker: InstallMarker | undefined): boolean {
  return (
    marker?.schemaVersion === INSTALL_SCHEMA_VERSION &&
    marker.packageName === PACKAGE_NAME &&
    marker.packageVersion !== 'unknown' &&
    marker.sparkleVersion === SPARKLE_VERSION
  )
}

async function resolvePackageVersion(): Promise<string> {
  try {
    const packageJsonPath = requireFromHere.resolve('electron-sparkle/package.json')
    const packageJson: unknown = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    if (
      typeof packageJson === 'object' &&
      packageJson !== null &&
      typeof (packageJson as Record<string, unknown>).version === 'string'
    ) {
      return (packageJson as Record<string, unknown>).version as string
    }
  } catch {
    // Development checkout and tests may not support package self-resolution.
  }
  return 'unknown'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) {
      return false
    }
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  )
}
