import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { onTestFinished, test } from 'vite-plus/test'

import { afterPack, electronSparkle } from '../../src/electron-builder.ts'

const TARGET_ADDON_GLOB = '**/electron-sparkle/dist/electron_sparkle.darwin-*.node'
const distributionDirectory = join(import.meta.dirname, '..', '..', 'dist')
const hasPublishedDarwinArtifacts =
  existsSync(join(distributionDirectory, 'Sparkle-2.9.6.zip')) &&
  existsSync(join(distributionDirectory, 'licenses', 'Sparkle-LICENSE.txt')) &&
  existsSync(join(distributionDirectory, `electron_sparkle.darwin-${process.arch}.node`))

test('electron-builder native hook exports are aliases and skip unsupported platforms', async () => {
  assert.strictEqual(afterPack, electronSparkle)

  await electronSparkle({ appOutDir: '/not-used', electronPlatformName: 'win32' })

  const platformSpecificBuildOptions = {
    x64ArchFiles: '**/existing-native.node',
    identity: '-',
    hardenedRuntime: false,
  }
  await electronSparkle({
    appOutDir: '/not-used',
    arch: 4,
    electronPlatformName: 'darwin',
    packager: { platformSpecificBuildOptions },
  })
  assert.equal(
    platformSpecificBuildOptions.x64ArchFiles,
    `{**/existing-native.node,${TARGET_ADDON_GLOB}}`,
  )
  assert.equal(platformSpecificBuildOptions.identity, '-')
  assert.equal(platformSpecificBuildOptions.hardenedRuntime, false)

  await assert.rejects(
    async () => electronSparkle({ appOutDir: '/not-used', electronPlatformName: 'mas' }),
    /does not support Mac App Store/,
  )
  await assert.rejects(
    async () => electronSparkle({ appOutDir: '/not-used', electronPlatformName: 'mas-dev' }),
    /does not support Mac App Store/,
  )
})

test(
  'electron-builder native hook stages the published assets on macOS',
  { skip: process.platform !== 'darwin' || !hasPublishedDarwinArtifacts },
  async () => {
    const fixture = await createFixture()
    onTestFinished(() => rm(fixture.root, { recursive: true, force: true }))

    await electronSparkle({
      appOutDir: fixture.outDir,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'Example' } },
    })

    await assertDefaultStagedAssets(fixture.appPath)
  },
)

test(
  'electron-builder native hook safely restages its own assets',
  { skip: process.platform !== 'darwin' || !hasPublishedDarwinArtifacts },
  async () => {
    const fixture = await createFixture()
    onTestFinished(() => rm(fixture.root, { recursive: true, force: true }))
    const context = {
      appOutDir: fixture.outDir,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'Example' } },
    }

    await electronSparkle(context)
    await electronSparkle(context)

    await assertDefaultStagedAssets(fixture.appPath)
  },
)

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'electron-sparkle-builder-'))
  const outDir = join(root, 'out')
  const appPath = join(outDir, 'Example.app')
  await mkdir(appPath, { recursive: true })

  return { root, outDir, appPath }
}

async function assertDefaultStagedAssets(appPath: string): Promise<void> {
  const frameworks = join(appPath, 'Contents', 'Frameworks')
  const resources = join(appPath, 'Contents', 'Resources')
  assert.equal((await lstat(join(frameworks, 'Sparkle.framework'))).isDirectory(), true)
  assert.equal((await lstat(join(frameworks, 'electron_sparkle.node'))).isFile(), true)
  assert.match(
    await readFile(join(resources, 'ThirdPartyLicenses', 'Sparkle-LICENSE.txt'), 'utf8'),
    /Copyright \(c\) 2006-2013 Andy Matuschak/,
  )

  const marker: unknown = JSON.parse(
    await readFile(join(resources, '.electron-sparkle.json'), 'utf8'),
  )
  assert.equal(typeof marker, 'object')
  assert.ok(marker !== null)
  assert.deepEqual(
    {
      schemaVersion: (marker as Record<string, unknown>).schemaVersion,
      packageName: (marker as Record<string, unknown>).packageName,
      sparkleVersion: (marker as Record<string, unknown>).sparkleVersion,
    },
    {
      schemaVersion: 1,
      packageName: 'electron-sparkle',
      sparkleVersion: '2.9.6',
    },
  )
  await assert.rejects(readFile(join(frameworks, '.electron-sparkle.json')), { code: 'ENOENT' })
}
