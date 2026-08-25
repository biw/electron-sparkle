import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sparkleLicense } from './acquire-sparkle.ts'

interface PackageManifest {
  bin?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
  name?: string
  optionalDependencies?: Record<string, string>
  private?: boolean
  swiftNode?: {
    linkerFlags?: string[]
    shipSwiftRuntime?: boolean
    swiftCompilerFlags?: string[]
  }
  version?: string
}

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceManifest = JSON.parse(
  readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'),
) as PackageManifest
if (typeof sourceManifest.name !== 'string' || typeof sourceManifest.version !== 'string') {
  throw new Error('The source package manifest is missing a name or version.')
}

const releaseDirectory = resolve(packageDirectory, process.argv[2] ?? 'release')
const packageName = sourceManifest.name.replace(/^@/, '').replaceAll('/', '-')
const mainTarball = resolve(releaseDirectory, `${packageName}-${sourceManifest.version}.tgz`)

const mainFiles = listTarball(mainTarball)

requireFiles(mainFiles, [
  'package/LICENSE',
  'package/README.md',
  'package/dist/Sparkle-2.9.6.zip',
  'package/dist/cli.js',
  'package/dist/electron_sparkle.darwin-arm64.node',
  'package/dist/electron_sparkle.darwin-x64.node',
  'package/dist/electron-builder.js',
  'package/dist/electron-forge.js',
  'package/dist/index.cjs',
  'package/dist/index.d.ts',
  'package/dist/index.js',
  `package/dist/${sparkleLicense.outputFilename}`,
  'package/package.json',
])
rejectPaths(mainFiles, [
  'package/.cache/',
  'package/THIRD_PARTY_LICENSES/',
  'package/THIRD_PARTY_LICENSES.md',
  'package/assets/',
  'package/dist/Sparkle.framework/',
  'package/dist/bin/',
  'package/dist_swift-node/',
  'package/node_modules/',
  'package/scripts/',
  'package/src/',
  'package/tests/',
  'package/vendor/',
])

const builderDeclarations = readFileFromTarball(
  mainTarball,
  'package/dist/electron-builder.d.ts',
).toString('utf8')
const forgeDeclarations = readFileFromTarball(
  mainTarball,
  'package/dist/electron-forge.d.ts',
).toString('utf8')
assert.doesNotMatch(builderDeclarations, /withElectronBuilderSparkle|SparklePackagerOptions/)
assert.match(forgeDeclarations, /ElectronSparkleOptions/)
assert.doesNotMatch(
  forgeDeclarations,
  /withElectronForgeSparkle|SparklePackagerOptions|SparkleAssetProvider|assetProvider/,
)

const mainManifest = readJsonFromTarball(mainTarball, 'package/package.json')
assert.equal(mainManifest.name, sourceManifest.name)
assert.equal(mainManifest.version, sourceManifest.version)
assert.deepEqual(mainManifest.bin, { 'electron-sparkle': 'dist/cli.js' })
assert.equal(mainManifest.engines, undefined)
assert.equal(mainManifest.private, undefined)
assert.equal(mainManifest.optionalDependencies, undefined)
assert.equal(mainManifest.devDependencies?.turbo, undefined)
assert.ok(!JSON.stringify(mainManifest).includes('workspace:'))
assert.deepEqual(mainManifest.swiftNode, {
  shipSwiftRuntime: false,
  swiftCompilerFlags: ['-F', '.cache', '-framework', 'Sparkle'],
  linkerFlags: ['-F', '.cache', '-framework', 'Sparkle', '-Wl,-rpath,@loader_path'],
})

const archive = readFileFromTarball(mainTarball, 'package/dist/Sparkle-2.9.6.zip')
assert.equal(
  createHash('sha256').update(archive).digest('hex'),
  '8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606',
)
const license = readFileFromTarball(mainTarball, `package/dist/${sparkleLicense.outputFilename}`)
assert.equal(createHash('sha256').update(license).digest('hex'), sparkleLicense.sha256)

process.stdout.write('electron-sparkle package tarball verified\n')

function listTarball(tarball: string): string[] {
  return runTarText(['-tzf', tarball]).trim().split('\n').filter(Boolean)
}

function requireFiles(files: string[], required: string[]): void {
  for (const file of required) {
    assert.ok(files.includes(file), `Package tarball is missing ${file}`)
  }
}

function rejectPaths(files: string[], prefixes: string[]): void {
  for (const prefix of prefixes) {
    assert.ok(
      !files.some((file) => file.startsWith(prefix)),
      `Package tarball unexpectedly contains ${prefix}`,
    )
  }
}

function readJsonFromTarball(tarball: string, path: string): PackageManifest {
  return JSON.parse(readFileFromTarball(tarball, path).toString('utf8')) as PackageManifest
}

function readFileFromTarball(tarball: string, path: string): Buffer {
  return runTarBuffer(['-xOzf', tarball, path])
}

function runTarText(arguments_: string[]): string {
  const result = spawnSync('/usr/bin/tar', arguments_, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  assertTarSucceeded(arguments_, result)
  return result.stdout
}

function runTarBuffer(arguments_: string[]): Buffer {
  const result = spawnSync('/usr/bin/tar', arguments_, {
    maxBuffer: 64 * 1024 * 1024,
  })
  assertTarSucceeded(arguments_, result)
  return result.stdout
}

function assertTarSucceeded(
  arguments_: string[],
  result: { status: number | null; stderr: string | Buffer },
): void {
  if (result.status !== 0) {
    throw new Error(`tar ${arguments_.join(' ')} failed: ${String(result.stderr ?? '').trim()}`)
  }
}
