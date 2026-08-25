import { execFileSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, readlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasExpectedChecksum, sparkleArchive, sparkleLicense } from './acquire-sparkle.ts'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const distributionDirectory = join(packageDirectory, 'dist')
const frameworkDirectory = join(packageDirectory, '.cache', 'Sparkle.framework')
const toolsDirectory = join(packageDirectory, '.cache', 'bin')
const publishedArchive = join(distributionDirectory, `Sparkle-${sparkleArchive.version}.zip`)
const publishedLicense = join(distributionDirectory, sparkleLicense.outputFilename)
const allowSingleArchitecture = process.argv.includes('--allow-single-architecture')
const addons = {
  arm64: join(distributionDirectory, 'electron_sparkle.darwin-arm64.node'),
  x64: join(distributionDirectory, 'electron_sparkle.darwin-x64.node'),
} as const

if (!(await hasExpectedChecksum(publishedArchive, sparkleArchive.sha256))) {
  throw new Error(`Sparkle archive checksum verification failed: ${publishedArchive}`)
}
await Promise.all(
  [sparkleLicense.file, publishedLicense].map(async (license) => {
    if (!(await hasExpectedChecksum(license, sparkleLicense.sha256))) {
      throw new Error(`Sparkle license checksum verification failed: ${license}`)
    }
  }),
)
await verifyFramework()

const addonResults = await Promise.all(
  (Object.keys(addons) as Array<keyof typeof addons>).map(async (architecture) => {
    try {
      await verifyAddon(addons[architecture], architecture)
      return architecture
    } catch (error) {
      if (allowSingleArchitecture && isNotFound(error)) return undefined
      throw error
    }
  }),
)
const availableAddons = addonResults.filter(
  (architecture): architecture is keyof typeof addons => architecture !== undefined,
)

if (
  availableAddons.length === 0 ||
  (!allowSingleArchitecture && availableAddons.length !== Object.keys(addons).length)
) {
  throw new Error(
    `Expected ${allowSingleArchitecture ? 'at least one' : 'both'} target-qualified native addon${allowSingleArchitecture ? '' : 's'} in ${distributionDirectory}.`,
  )
}

await Promise.all(
  ['generate_keys', 'sign_update', 'generate_appcast'].map((tool) =>
    access(join(toolsDirectory, tool), fsConstants.X_OK),
  ),
)

process.stdout.write(
  `electron-sparkle native distribution verified (${availableAddons.join(', ')})\n`,
)

async function verifyFramework(): Promise<void> {
  const framework = await lstat(frameworkDirectory)
  if (!framework.isDirectory() || framework.isSymbolicLink()) {
    throw new Error(`Sparkle framework is missing or invalid: ${frameworkDirectory}`)
  }
  const currentVersion = await readlink(join(frameworkDirectory, 'Versions', 'Current'))
  if (currentVersion !== 'B') {
    throw new Error(`Sparkle framework has an unexpected current version: ${currentVersion}`)
  }
  const frameworkArchitectures = architectures(join(frameworkDirectory, 'Sparkle'))
  if (!frameworkArchitectures.includes('arm64') || !frameworkArchitectures.includes('x86_64')) {
    throw new Error(
      `Sparkle framework must be universal; found ${frameworkArchitectures.join(', ')}.`,
    )
  }
}

async function verifyAddon(path: string, architecture: keyof typeof addons): Promise<void> {
  const addon = await lstat(path)
  if (!addon.isFile()) throw new Error(`Native addon is missing: ${path}`)

  const expectedArchitecture = architecture === 'x64' ? 'x86_64' : architecture
  const addonArchitectures = architectures(path)
  if (!addonArchitectures.includes(expectedArchitecture)) {
    throw new Error(
      `${path} is missing ${expectedArchitecture}; found ${addonArchitectures.join(', ')}.`,
    )
  }

  const linkedLibraries = execFileSync('/usr/bin/otool', ['-L', path], { encoding: 'utf8' })
  if (!linkedLibraries.includes('@rpath/Sparkle.framework/Versions/B/Sparkle')) {
    throw new Error(`${path} is not linked against Sparkle.framework.`)
  }

  const loadCommands = execFileSync('/usr/bin/otool', ['-l', path], { encoding: 'utf8' })
  if (!/cmd\s+LC_RPATH[\s\S]*?path\s+@loader_path(?:\s|$)/.test(loadCommands)) {
    throw new Error(`${path} is missing its @loader_path rpath.`)
  }
}

function architectures(path: string): string[] {
  return execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' }).trim().split(/\s+/)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  )
}
