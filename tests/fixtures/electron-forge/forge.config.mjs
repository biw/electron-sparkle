import { ElectronSparkle } from 'electron-sparkle/electron-forge'
import { writeFileSync } from 'node:fs'

const sparklePublicEDKey = Buffer.alloc(32, 43).toString('base64')
const shouldSignFixtures = process.env.ELECTRON_SPARKLE_SIGN_FIXTURES !== 'false'

const earlierConfigPlugin = {
  name: 'electron-sparkle-fixture-earlier-config',
  config: {},
  __isElectronForgePlugin: true,
  init() {},
  getHooks() {
    return {
      resolveForgeConfig: async (_config, currentConfig) => ({
        ...currentConfig,
        packagerConfig: {
          ...currentConfig.packagerConfig,
          extendInfo: {
            ...currentConfig.packagerConfig.extendInfo,
            ElectronSparkleFixtureEarlierPlugin: true,
          },
        },
      }),
    }
  },
}

export default {
  packagerConfig: {
    asar: true,
    electronVersion: '43.4.1',
    name: 'ElectronSparkleForgeFixture',
    // @electron/osx-sign signs nested code inside-out. `-` is codesign's
    // ad-hoc identity; validation and timestamps only apply to certificates.
    osxSign: shouldSignFixtures
      ? {
          identity: '-',
          identityValidation: false,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: () => ({
            hardenedRuntime: false,
            timestamp: 'none',
          }),
        }
      : false,
  },
  hooks: {
    resolveForgeConfig: async (_config, currentConfig) => ({
      ...currentConfig,
      packagerConfig: {
        ...currentConfig.packagerConfig,
        extendInfo: {
          ...currentConfig.packagerConfig.extendInfo,
          ElectronSparkleFixtureResolveHook: true,
        },
      },
    }),
    packageAfterCopy: async (_config, buildPath, electronVersion, platform, arch) => {
      if (process.env.ELECTRON_SPARKLE_FORGE_HOOK_LOG) {
        writeFileSync(
          process.env.ELECTRON_SPARKLE_FORGE_HOOK_LOG,
          JSON.stringify({ arch, buildPath, electronVersion, platform }),
        )
      }
    },
  },
  makers: [],
  plugins: [
    earlierConfigPlugin,
    new ElectronSparkle({
      SUFeedURL: 'https://updates.example.invalid/appcast.xml',
      SUPublicEDKey: sparklePublicEDKey,
      SUEnableAutomaticChecks: false,
    }),
  ],
}
