import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { onTestFinished, test } from 'vite-plus/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build as buildPlist, buildBinary as buildBinaryPlist } from 'plist'

import { ElectronSparkle } from '../../src/packagers/electron-forge.ts'
import type { SparkleAssetProvider } from '../../src/packagers/types.ts'

const PUBLIC_KEY = Buffer.alloc(32, 3).toString('base64')
const BASE_OPTIONS = {
  SUFeedURL: 'https://updates.example.test/appcast.xml',
  SUPublicEDKey: PUBLIC_KEY,
} as const
const TARGET_ADDON_GLOB = '**/electron-sparkle/dist/electron_sparkle.darwin-*.node'

test('ElectronSparkle follows Forge mutating-hook semantics and stages assets before signing', async () => {
  const fixture = await createFixture()
  onTestFinished(() => rm(fixture.root, { recursive: true, force: true }))

  const calls: string[] = []
  const original = {
    packagerConfig: {
      extendInfo: { ExistingValue: 'kept' },
      extraResource: 'application-resource.json',
      afterCopyExtraResources: ['./existing-hook.cjs'],
      osxSign: {
        identity: '-',
        identityValidation: false,
        optionsForFile: 'preserved by the plugin',
      },
    },
  }
  const plugin = withAssetProvider(
    new ElectronSparkle({
      ...BASE_OPTIONS,
      SUAllowsAutomaticUpdates: true,
      SUEnableAutomaticChecks: false,
      SUAutomaticallyUpdate: true,
      SUScheduledCheckInterval: 7200,
      SUShowReleaseNotes: false,
    }),
    fixture.assetProvider(calls),
  )

  assert.equal(plugin.name, 'electron-sparkle')
  assert.equal(Object.getOwnPropertyDescriptor(plugin, '__isElectronForgePlugin')?.value, true)
  assert.equal(
    Object.getOwnPropertyDescriptor(plugin, '__isElectronForgePlugin')?.enumerable,
    false,
  )

  plugin.init('/project', original)
  const hooks = plugin.getHooks()
  const currentConfig = {
    ...original,
    packagerConfig: {
      ...original.packagerConfig,
      extendInfo: {
        ...original.packagerConfig.extendInfo,
        EarlierHookValue: 'also kept',
      },
    },
  }
  // Forge keeps a replacement returned by an earlier plugin as the final
  // result, while continuing to pass currentConfig to later plugins.
  const resolved = await runEarlierReplacementHook(original, currentConfig)
  await hooks.resolveForgeConfig(original, currentConfig)

  assert.notEqual(resolved, original)
  assert.deepEqual(original, {
    packagerConfig: {
      extendInfo: {
        ExistingValue: 'kept',
        SUAllowsAutomaticUpdates: true,
        SUEnableAutomaticChecks: false,
        SUFeedURL: BASE_OPTIONS.SUFeedURL,
        SUPublicEDKey: BASE_OPTIONS.SUPublicEDKey,
        SUAutomaticallyUpdate: true,
        SUScheduledCheckInterval: 7200,
        SUShowReleaseNotes: false,
      },
      extraResource: 'application-resource.json',
      afterCopyExtraResources: ['./existing-hook.cjs'],
      osxSign: {
        identity: '-',
        identityValidation: false,
        optionsForFile: 'preserved by the plugin',
      },
      osxUniversal: { x64ArchFiles: TARGET_ADDON_GLOB },
    },
  })
  assert.deepEqual(resolved.packagerConfig, {
    extendInfo: {
      EarlierHookValue: 'also kept',
      EarlierPluginValue: 'also kept',
      ExistingValue: 'kept',
      SUAllowsAutomaticUpdates: true,
      SUEnableAutomaticChecks: false,
      SUFeedURL: BASE_OPTIONS.SUFeedURL,
      SUPublicEDKey: BASE_OPTIONS.SUPublicEDKey,
      SUAutomaticallyUpdate: true,
      SUScheduledCheckInterval: 7200,
      SUShowReleaseNotes: false,
    },
    extraResource: 'application-resource.json',
    afterCopyExtraResources: ['./existing-hook.cjs'],
    osxSign: {
      identity: '-',
      identityValidation: false,
      optionsForFile: 'preserved by the plugin',
    },
    osxUniversal: { x64ArchFiles: TARGET_ADDON_GLOB },
  })

  await hooks.prePackage[0]!(resolved, 'darwin', 'arm64')
  await hooks.packageAfterCopy[0]!(resolved, fixture.buildPath, '43.0.0', 'darwin', 'arm64')

  assert.deepEqual(calls, ['resolve'])
  assert.equal(
    await readFile(
      join(fixture.appPath, 'Contents', 'Frameworks', 'Sparkle.framework', 'Sparkle'),
      'utf8',
    ),
    'framework',
  )
  assert.equal(
    await readFile(
      join(fixture.appPath, 'Contents', 'Frameworks', 'electron_sparkle.node'),
      'utf8',
    ),
    'addon',
  )
  assert.equal(
    await readFile(
      join(fixture.appPath, 'Contents', 'Resources', 'ThirdPartyLicenses', 'Sparkle-LICENSE.txt'),
      'utf8',
    ),
    'Sparkle license',
  )
})

test('ElectronSparkle rejects MAS early and surfaces late Forge staging errors from postPackage', async () => {
  const fixture = await createFixture()
  onTestFinished(() => rm(fixture.root, { recursive: true, force: true }))

  const plugin = new ElectronSparkle(BASE_OPTIONS)

  const hooks = plugin.getHooks()
  await assert.rejects(plugin.resolveForgeConfig({}, { platform: 'mas' }), /Mac App Store/)
  await assert.rejects(hooks.prePackage[0]!({}, 'mas', 'arm64'), /Mac App Store/)
  await assert.rejects(hooks.prePackage[0]!({}, 'all', 'arm64'), /Mac App Store/)

  // Forge 7 drops packageAfterCopy promise rejections. The plugin must let
  // Electron Packager finish its callback and rethrow through postPackage.
  await hooks.packageAfterCopy[0]!({}, fixture.root, '43.0.0', 'darwin', 'arm64')
  await assert.rejects(
    hooks.postPackage[0]!({}, { platform: 'darwin', arch: 'arm64', outputPaths: [] }),
    /Expected <App>\.app\/Contents\/Resources\/app/,
  )
})

test('ElectronSparkle rejects a final Forge bundle that lost Sparkle plist values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'electron-sparkle-forge-output-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))

  const outputPath = join(root, 'ElectronSparkle-darwin-arm64')
  const appPath = join(outputPath, 'Example.app')
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  await mkdir(join(appPath, 'Contents'), { recursive: true })
  await writeFile(plistPath, buildPlist({ CFBundleName: 'Example' }))

  const plugin = new ElectronSparkle(BASE_OPTIONS)
  const postPackage = plugin.getHooks().postPackage[0]!
  const packageResult = {
    platform: 'darwin',
    arch: 'arm64',
    outputPaths: [outputPath],
  }

  await assert.rejects(
    postPackage({}, packageResult),
    /SUFeedURL, SUPublicEDKey.*must preserve currentConfig\.packagerConfig\.extendInfo/,
  )

  await writeFile(
    plistPath,
    buildPlist({
      CFBundleName: 'Example',
      SUFeedURL: BASE_OPTIONS.SUFeedURL,
      SUPublicEDKey: BASE_OPTIONS.SUPublicEDKey,
    }),
  )
  await postPackage({}, packageResult)
})

test('ElectronSparkle accepts a final binary Forge Info.plist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'electron-sparkle-forge-binary-output-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))

  const outputPath = join(root, 'ElectronSparkle-darwin-arm64')
  const appPath = join(outputPath, 'Example.app')
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  await mkdir(join(appPath, 'Contents'), { recursive: true })
  await writeFile(
    plistPath,
    buildBinaryPlist({
      CFBundleName: 'Example',
      SUFeedURL: BASE_OPTIONS.SUFeedURL,
      SUPublicEDKey: BASE_OPTIONS.SUPublicEDKey,
    }),
  )

  const plugin = new ElectronSparkle(BASE_OPTIONS)
  await plugin.getHooks().postPackage[0]!(
    {},
    {
      platform: 'darwin',
      arch: 'arm64',
      outputPaths: [outputPath],
    },
  )
})

test('ElectronSparkle verifies Darwin outputs in a multi-platform Forge package', async () => {
  const fixture = await createFixture()
  const outputRoot = await mkdtemp(join(tmpdir(), 'electron-sparkle-forge-multi-output-'))
  onTestFinished(() => rm(fixture.root, { recursive: true, force: true }))
  onTestFinished(() => rm(outputRoot, { recursive: true, force: true }))

  const calls: string[] = []
  const plugin = withAssetProvider(new ElectronSparkle(BASE_OPTIONS), fixture.assetProvider(calls))
  const hooks = plugin.getHooks()
  await hooks.prePackage[0]!({}, 'all', 'ia32')
  assert.deepEqual(calls, [])

  await hooks.prePackage[0]!({}, 'darwin,win32', 'arm64')
  assert.deepEqual(calls, ['resolve'])

  const windowsOutputPath = join(outputRoot, 'ElectronSparkle-win32-arm64')
  const darwinOutputPath = join(outputRoot, 'ElectronSparkle-darwin-arm64')
  const appPath = join(darwinOutputPath, 'Example.app')
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  await mkdir(windowsOutputPath, { recursive: true })
  await mkdir(join(appPath, 'Contents'), { recursive: true })
  await writeFile(plistPath, buildPlist({ CFBundleName: 'Example' }))

  const packageResult = {
    platform: 'darwin,win32',
    arch: 'arm64',
    outputPaths: [windowsOutputPath, darwinOutputPath],
  }
  await assert.rejects(
    hooks.postPackage[0]!({}, packageResult),
    /SUFeedURL, SUPublicEDKey.*must preserve currentConfig\.packagerConfig\.extendInfo/,
  )

  await writeFile(
    plistPath,
    buildPlist({
      CFBundleName: 'Example',
      SUFeedURL: BASE_OPTIONS.SUFeedURL,
      SUPublicEDKey: BASE_OPTIONS.SUPublicEDKey,
    }),
  )
  await hooks.postPackage[0]!({}, packageResult)
})

test('ElectronSparkle permits Forge packages skipped because overwrite is false', async () => {
  const plugin = new ElectronSparkle(BASE_OPTIONS)

  await plugin.getHooks().postPackage[0]!(
    {},
    {
      platform: 'darwin',
      arch: 'arm64',
      outputPaths: [],
    },
  )
})

test('ElectronSparkle refuses to replace unowned native assets', async () => {
  const fixture = await createFixture()
  onTestFinished(() => rm(fixture.root, { recursive: true, force: true }))
  await writeFile(
    join(fixture.appPath, 'Contents', 'Frameworks', 'electron_sparkle.node'),
    'foreign addon',
  )

  const plugin = withAssetProvider(new ElectronSparkle(BASE_OPTIONS), fixture.assetProvider([]))
  const hooks = plugin.getHooks()
  await hooks.packageAfterCopy[0]!({}, fixture.buildPath, '43.0.0', 'darwin', 'arm64')

  await assert.rejects(
    hooks.postPackage[0]!({}, { platform: 'darwin', arch: 'arm64', outputPaths: [] }),
    /without an electron-sparkle install marker/,
  )
})

test('ElectronSparkle validates updater options and Forge configuration', async () => {
  assert.throws(
    () => new ElectronSparkle({ ...BASE_OPTIONS, SUFeedURL: 'file:///appcast.xml' }),
    /HTTP or HTTPS/,
  )
  assert.throws(
    () => new ElectronSparkle({ ...BASE_OPTIONS, SUPublicEDKey: 'not-a-key' }),
    /base64-encoded 32-byte/,
  )
  assert.throws(
    () => new ElectronSparkle({ ...BASE_OPTIONS, SUScheduledCheckInterval: 3599 }),
    /no smaller than 3600/,
  )

  const plugin = new ElectronSparkle(BASE_OPTIONS)
  await assert.rejects(
    plugin.resolveForgeConfig({}, { packagerConfig: { extendInfo: './Info.plist' } }),
    /cannot be merged safely/,
  )
  await assert.rejects(
    plugin.resolveForgeConfig(
      {},
      {
        packagerConfig: {
          extendInfo: { SUFeedURL: 'https://wrong.example.test/appcast.xml' },
        },
      },
    ),
    /SUFeedURL conflicts/,
  )
})

async function runEarlierReplacementHook(
  _forgeConfig: unknown,
  config: {
    packagerConfig: {
      extendInfo: Record<string, unknown>
      extraResource: string
      afterCopyExtraResources: string[]
    }
  },
) {
  return {
    ...config,
    packagerConfig: {
      ...config.packagerConfig,
      extendInfo: {
        ...config.packagerConfig.extendInfo,
        EarlierPluginValue: 'also kept',
      },
    },
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'electron-sparkle-forge-'))
  const stagingPath = join(root, 'staging')
  const appPath = join(stagingPath, 'Example.app')
  const buildPath = join(appPath, 'Contents', 'Resources', 'app')
  const sourceFramework = join(root, 'source', 'Sparkle.framework')
  const sourceAddon = join(root, 'source', 'electron_sparkle.node')
  const sourceLicense = join(root, 'source', 'Sparkle-LICENSE.txt')
  await mkdir(join(appPath, 'Contents', 'Frameworks'), { recursive: true })
  await mkdir(buildPath, { recursive: true })
  await mkdir(sourceFramework, { recursive: true })
  await writeFile(join(sourceFramework, 'Sparkle'), 'framework')
  await writeFile(sourceAddon, 'addon')
  await writeFile(sourceLicense, 'Sparkle license')

  return {
    root,
    appPath,
    buildPath,
    assetProvider(calls: string[]): SparkleAssetProvider {
      return {
        async resolve() {
          calls.push('resolve')
          return {
            frameworkPath: sourceFramework,
            addonPath: sourceAddon,
            licensePath: sourceLicense,
            packageVersion: '0.1.0',
            sparkleVersion: '2.9.6',
          }
        },
      }
    },
  }
}

function withAssetProvider(
  plugin: ElectronSparkle,
  assetProvider: SparkleAssetProvider,
): ElectronSparkle {
  assert.equal(Reflect.set(plugin, 'configuredAssetProvider', assetProvider), true)
  return plugin
}
