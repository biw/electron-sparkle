import { electronSparkle } from 'electron-sparkle/electron-builder'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const publicEDKey = Buffer.alloc(32, 42).toString('base64')
const shouldSignFixtures = process.env.ELECTRON_SPARKLE_SIGN_FIXTURES !== 'false'

export default {
  appId: 'dev.electron-sparkle.builder-fixture',
  productName: 'ElectronSparkleBuilderFixture',
  directories: {
    output: 'out',
  },
  files: ['main.cjs', 'package.json'],
  mac: {
    target: 'dir',
    // Trusted workflows exercise electron-builder's certificate-free signing
    // path after electron-sparkle stages its native assets. Pull requests leave
    // the fixture unsigned.
    identity: shouldSignFixtures ? '-' : null,
    hardenedRuntime: false,
    extendInfo: {
      SUFeedURL: 'https://updates.example.invalid/appcast.xml',
      SUPublicEDKey: publicEDKey,
      SUEnableAutomaticChecks: false,
    },
  },
  afterPack: async (context) => {
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    await writeFile(
      path.join(appPath, 'Contents', 'Resources', 'fixture-after-pack.txt'),
      'existing afterPack ran\n',
    )
    await electronSparkle(context)
  },
}
