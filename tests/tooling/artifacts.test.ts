import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { onTestFinished, test } from 'vite-plus/test'

import {
  type MaterializeDarwinDistributionOptions,
  materializeDarwinDistribution,
  nativeAddonFilename,
  normalizeDarwinArchitecture,
  resolvePublishedDarwinArtifacts,
  resolveOfficialTool,
  verifyArchiveChecksum,
} from '../../src/tooling/artifacts.ts'
import { ElectronSparkleToolingError } from '../../src/tooling/errors.ts'

test('uses swift-node target-qualified Darwin addon names', () => {
  assert.equal(nativeAddonFilename('arm64'), 'electron_sparkle.darwin-arm64.node')
  assert.equal(nativeAddonFilename('x64'), 'electron_sparkle.darwin-x64.node')
  assert.equal(normalizeDarwinArchitecture(3), 'arm64')
  assert.equal(normalizeDarwinArchitecture(1), 'x64')
  assert.equal(normalizeDarwinArchitecture('x86_64'), 'x64')
})

test('rejects architectures that electron-sparkle does not publish', () => {
  assert.throws(
    () => normalizeDarwinArchitecture('ia32'),
    (error: unknown) =>
      error instanceof ElectronSparkleToolingError && error.code === 'UNSUPPORTED_ARCHITECTURE',
  )
})

test('resolves the archive and selected addon from one package', () => {
  const artifacts = resolvePublishedDarwinArtifacts({
    allowNonDarwin: true,
    architecture: 'arm64',
    packageRoot: '/package',
  })

  assert.deepEqual(artifacts, {
    architecture: 'arm64',
    root: '/package/dist',
    archivePath: '/package/dist/Sparkle-2.9.6.zip',
    archiveSha256: '8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606',
    addonPath: '/package/dist/electron_sparkle.darwin-arm64.node',
    licensePath: '/package/dist/licenses/Sparkle-LICENSE.txt',
    licenseSha256: '389a4e4e9a32f059775b13a06e25a591445ba229d2838d26dd3e7c0c45127cfe',
  })
})

test('does not resolve Darwin artifacts on unsupported platforms', () => {
  assert.throws(
    () =>
      resolvePublishedDarwinArtifacts({
        architecture: 'arm64',
        getPlatform: () => 'linux',
        packageRoot: '/package',
      }),
    (error: unknown) =>
      error instanceof ElectronSparkleToolingError && error.code === 'UNSUPPORTED_PLATFORM',
  )
})

test('verifyArchiveChecksum rejects a tampered upstream archive', async () => {
  await assert.rejects(
    () =>
      verifyArchiveChecksum(
        { readFile: async () => Buffer.from('tampered') as never },
        '/package/dist/Sparkle-2.9.6.zip',
        '8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606',
      ),
    (error: unknown) =>
      error instanceof ElectronSparkleToolingError && error.code === 'ARCHIVE_CHECKSUM_MISMATCH',
  )
})

test('materializes Sparkle and the selected addon while preserving framework symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'electron-sparkle-artifacts-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'package')
  const archivePath = join(packageRoot, 'dist', 'Sparkle-2.9.6.zip')
  const addonPath = join(packageRoot, 'dist', 'electron_sparkle.darwin-arm64.node')
  const licensePath = join(packageRoot, 'dist', 'licenses', 'Sparkle-LICENSE.txt')
  const archive = Buffer.from('test upstream archive')
  const archiveSha256 = createHash('sha256').update(archive).digest('hex')
  const license = Buffer.from('test upstream license')
  const licenseSha256 = createHash('sha256').update(license).digest('hex')
  await mkdir(join(packageRoot, 'dist', 'licenses'), { recursive: true })
  await writeFile(archivePath, archive)
  await writeFile(addonPath, 'not a real native addon')
  await writeFile(licensePath, license)

  const calls: string[][] = []
  const options = {
    architecture: 'arm64',
    cacheDirectory: join(root, 'cache'),
    getPlatform: () => 'darwin',
    source: {
      architecture: 'arm64',
      root: join(packageRoot, 'dist'),
      archivePath,
      archiveSha256,
      addonPath,
      licensePath,
      licenseSha256,
    },
    runCommand: async (_executable, arguments_) => {
      calls.push([...arguments_])
      if (arguments_[0] === '-x') {
        const destination = arguments_[3]
        assert.ok(destination)
        const framework = join(
          destination,
          'Sparkle.xcframework',
          'macos-arm64_x86_64',
          'Sparkle.framework',
        )
        await mkdir(join(framework, 'Versions', 'B'), { recursive: true })
        await writeFile(join(framework, 'Versions', 'B', 'Sparkle'), 'framework')
        await symlink('B', join(framework, 'Versions', 'Current'))
        await symlink('Versions/Current/Sparkle', join(framework, 'Sparkle'))
        await mkdir(join(destination, 'bin'), { recursive: true })
        await Promise.all(
          ['generate_keys', 'sign_update', 'generate_appcast'].map(async (tool) => {
            const toolPath = join(destination, 'bin', tool)
            await writeFile(toolPath, '#!/bin/sh\n')
            await chmod(toolPath, 0o755)
          }),
        )
      } else {
        const source = arguments_[0]
        const destination = arguments_[1]
        assert.ok(source && destination)
        await cp(source, destination, { recursive: true, verbatimSymlinks: true })
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    },
  } satisfies MaterializeDarwinDistributionOptions
  const distribution = await materializeDarwinDistribution(options)

  assert.equal(calls.length, 3)
  assert.equal(await readlink(join(distribution.frameworkPath, 'Versions', 'Current')), 'B')
  assert.equal(await readFile(distribution.licensePath, 'utf8'), license.toString('utf8'))
  assert.match(distribution.root, /2\.9\.6-/)

  await chmod(join(distribution.toolsDirectory, 'sign_update'), 0o644)
  const repairedDistribution = await materializeDarwinDistribution(options)
  assert.equal(repairedDistribution.root, distribution.root)
  assert.equal(calls.length, 6)
  assert.equal(
    await resolveOfficialTool({ ...options, name: 'sign-update' }),
    join(repairedDistribution.toolsDirectory, 'sign_update'),
  )

  await writeFile(addonPath, 'a rebuilt native addon')
  const rebuiltDistribution = await materializeDarwinDistribution(options)
  assert.notEqual(rebuiltDistribution.root, distribution.root)
  assert.equal(await readFile(rebuiltDistribution.addonPath, 'utf8'), 'a rebuilt native addon')
})
