import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'vite-plus/test'

import { sha256, sparkleArchive } from '../../scripts/acquire-sparkle.ts'
import { SPARKLE_ARCHIVE_SHA256, SPARKLE_VERSION } from '../../src/tooling/artifacts.ts'
import viteConfig from '../../vite.config.ts'

const packageDirectory = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('pins the official Sparkle 2.9.6 package-manager archive', () => {
  assert.equal(sparkleArchive.version, '2.9.6')
  assert.equal(
    sparkleArchive.sha256,
    '8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606',
  )
  assert.match(sparkleArchive.url, /Sparkle-for-Swift-Package-Manager\.zip$/)
  assert.equal(SPARKLE_VERSION, sparkleArchive.version)
  assert.equal(SPARKLE_ARCHIVE_SHA256, sparkleArchive.sha256)
  assert.equal(
    sha256(Buffer.from('electron-sparkle')),
    'f2f38ccbd24621b6b8669948c79c8071c3cc44625da956aa4e4d3b9de0942df9',
  )
})

test('native bridge exposes the runtime adapter contract and event taxonomy', async () => {
  const source = await readFile(join(packageDirectory, 'src', 'SparkleBridge.swift'), 'utf8')
  for (const name of [
    'func start()',
    'func checkForUpdates() throws',
    'func getState() -> SparkleUpdaterState',
    'func setAutomaticallyChecksForUpdates(_ value: Bool) throws',
    'func setAutomaticallyDownloadsUpdates(_ value: Bool) throws',
    'func events() -> AsyncStream<SparkleUpdaterEvent>',
  ]) {
    assert.match(source, new RegExp(name.replace(/[()]/g, '\\$&')))
  }
  for (const type of [
    'state-changed',
    'update-available',
    'update-not-available',
    'update-downloaded',
    'before-install',
    'before-relaunch',
    'cycle-complete',
    'error',
  ]) {
    assert.match(source, new RegExp(`type: "${type}"`))
  }
  assert.match(source, /SUError\.noUpdateError/)
})

test('package metadata configures swift-node to link the staged Sparkle framework', async () => {
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
    name?: string
    private?: boolean
    scripts?: Record<string, string>
    swiftNode?: unknown
  }
  assert.equal(manifest.name, 'electron-sparkle')
  assert.equal(manifest.private, undefined)
  assert.deepEqual(manifest.swiftNode, {
    shipSwiftRuntime: false,
    swiftCompilerFlags: ['-F', '.cache', '-framework', 'Sparkle'],
    linkerFlags: ['-F', '.cache', '-framework', 'Sparkle', '-Wl,-rpath,@loader_path'],
  })
  assert.equal(manifest.devDependencies?.['swift-node'], '1.0.1')
  assert.equal(manifest.devDependencies?.['swift-node-unplugin'], '1.0.1')
  assert.equal(manifest.devDependencies?.['@actions/artifact'], '6.2.1')
  assert.equal(manifest.scripts?.build, 'node scripts/prepare-sparkle.ts && vp pack')
  assert.equal(manifest.scripts?.prepublish, 'node scripts/prepare-publish.ts')
})

test('deployment runs CI on main and uses the shared trusted-publish workflows', async () => {
  const [ciWorkflow, releaseWorkflow] = await Promise.all([
    readFile(join(packageDirectory, '.github', 'workflows', 'ci.yml'), 'utf8'),
    readFile(join(packageDirectory, '.github', 'workflows', 'release.yml'), 'utf8'),
  ])
  assert.match(ciWorkflow, /^  push:\n    branches: \[main\]$/m)
  assert.match(ciWorkflow, /^  workflow_call:$/m)
  assert.match(ciWorkflow, /^  pull_request:$/m)
  assert.match(ciWorkflow, /group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/)
  assert.match(releaseWorkflow, /npm-trusted-publish-workflows\/.github\/workflows\/check\.yml@v1/)
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/ci\.yml/)
  assert.match(
    releaseWorkflow,
    /npm-trusted-publish-workflows\/.github\/workflows\/publish\.yml@v1/,
  )
  assert.match(
    releaseWorkflow,
    /publish:\n    needs: ci\n    permissions:\n      actions: read\n      contents: write\n      id-token: write/,
  )
})

test('the root README preserves package integration and operations guidance', async () => {
  const readme = await readFile(join(packageDirectory, 'README.md'), 'utf8')
  for (const heading of [
    '## How do cross-platform updates work?',
    '## How do I migrate to electron-sparkle?',
    '## What kind of update server do I need?',
    '## Publish an update',
    '## Validate and test',
  ]) {
    assert.ok(readme.includes(heading), `README is missing ${heading}`)
  }
})

test('pins Node 24 for repository tooling', async () => {
  const nodeVersion = await readFile(join(packageDirectory, '.nvmrc'), 'utf8')
  assert.equal(nodeVersion.trim(), '24')
})

test('Vite+ emits swift-node native assets only for macOS builds', () => {
  const plugins =
    (viteConfig as { pack?: { plugins?: Array<{ name?: string }> } }).pack?.plugins ?? []
  assert.deepEqual(
    plugins.map((plugin) => plugin.name),
    process.platform === 'darwin' ? ['sparkle-release-archive', 'swift-node-native-assets'] : [],
  )
})
