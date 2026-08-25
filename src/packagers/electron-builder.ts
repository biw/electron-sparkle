import {
  defaultSparkleAssetProvider,
  installSparkleAssets,
  mergeTargetQualifiedAddonGlob,
  resolveBuilderAppPath,
} from './native-assets.ts'
import { SparklePackagerConfigurationError } from './errors.ts'
import type { BuilderAfterPackHook } from './types.ts'

/**
 * Stage Sparkle immediately after electron-builder packages a macOS app and
 * before it signs the bundle.
 *
 * Use this directly when another afterPack task is already configured:
 *
 * ```ts
 * afterPack: async (context) => {
 *   await anotherAfterPackTask(context)
 *   await electronSparkle(context)
 * }
 * ```
 *
 * The application Info.plist must separately contain Sparkle's SUFeedURL and
 * SUPublicEDKey values.
 */
export const electronSparkle: BuilderAfterPackHook = async (context) => {
  if (context.electronPlatformName === 'mas' || context.electronPlatformName === 'mas-dev') {
    throw new SparklePackagerConfigurationError(
      'electron-sparkle does not support Mac App Store or mas-dev targets.',
    )
  }
  if (context.electronPlatformName !== 'darwin') {
    return
  }
  const platformOptions = context.packager?.platformSpecificBuildOptions
  if (platformOptions) {
    platformOptions.x64ArchFiles = mergeTargetQualifiedAddonGlob(platformOptions.x64ArchFiles)
  }
  // electron-builder runs afterPack for each architecture slice before
  // merging a universal app, then runs it once more with Arch.universal (4).
  // The slice hooks have already staged target-qualified addons, which
  // @electron/universal combines into the final fat binary.
  if (context.arch === 'universal' || context.arch === 4) {
    return
  }

  const appPath = await resolveBuilderAppPath(context)
  await installSparkleAssets(appPath, defaultSparkleAssetProvider, context.arch)
}

/** Named hook electron-builder resolves for `afterPack: 'electron-sparkle/electron-builder'`. */
export const afterPack = electronSparkle
