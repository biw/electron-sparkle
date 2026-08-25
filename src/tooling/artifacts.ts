import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, platform } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { ElectronSparkleToolingError } from './errors.ts'

export const SPARKLE_VERSION = '2.9.6'
export const SPARKLE_ARCHIVE_FILENAME = `Sparkle-${SPARKLE_VERSION}.zip`
export const SPARKLE_ARCHIVE_SHA256 =
  '8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606'
export const SPARKLE_LICENSE_FILENAME = 'Sparkle-LICENSE.txt'
export const SPARKLE_LICENSE_SHA256 =
  '389a4e4e9a32f059775b13a06e25a591445ba229d2838d26dd3e7c0c45127cfe'
export const NATIVE_MODULE_NAME = 'electron_sparkle'
const SPARKLE_FRAMEWORK_VERSION = 'B'

const SPARKLE_FRAMEWORK_IN_ARCHIVE = join(
  'Sparkle.xcframework',
  'macos-arm64_x86_64',
  'Sparkle.framework',
)

export type DarwinArchitecture = 'arm64' | 'x64'
export type OfficialToolName = 'generate-keys' | 'sign-update' | 'generate-appcast'

export interface PublishedDarwinArtifacts {
  readonly architecture: DarwinArchitecture
  readonly root: string
  readonly archivePath: string
  readonly archiveSha256: string
  readonly addonPath: string
  readonly licensePath: string
  readonly licenseSha256: string
}

export interface DarwinDistribution {
  readonly architecture: DarwinArchitecture
  readonly cacheKey: string
  readonly root: string
  readonly frameworkPath: string
  readonly addonPath: string
  readonly licensePath: string
  readonly toolsDirectory: string
}

export type CommandResult = Readonly<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}>

export type CommandRunner = (
  executable: string,
  arguments_: readonly string[],
  options?: Readonly<{ cwd?: string }>,
) => Promise<CommandResult>

export interface ArtifactOperations {
  readonly readFile: typeof readFile
  readonly readlink: typeof readlink
  readonly access: typeof access
  readonly stat: typeof stat
  readonly mkdir: typeof mkdir
  readonly mkdtemp: typeof mkdtemp
  readonly rename: typeof rename
  readonly rm: typeof rm
  readonly copyFile: typeof copyFile
  readonly getPlatform: () => NodeJS.Platform
  readonly getHomeDirectory: () => string
  readonly runCommand: CommandRunner
}

export type ArtifactOperationOverrides = Partial<ArtifactOperations>

export interface ResolveDarwinArtifactsOptions extends ArtifactOperationOverrides {
  readonly architecture?: string | number | undefined
  readonly packageRoot?: string
  readonly allowNonDarwin?: boolean
}

export interface MaterializeDarwinDistributionOptions extends ResolveDarwinArtifactsOptions {
  readonly cacheDirectory?: string
  readonly source?: PublishedDarwinArtifacts
}

export interface OfficialToolOptions extends MaterializeDarwinDistributionOptions {
  readonly name: OfficialToolName
}

const OFFICIAL_TOOL_FILENAMES: Readonly<Record<OfficialToolName, string>> = {
  'generate-keys': 'generate_keys',
  'sign-update': 'sign_update',
  'generate-appcast': 'generate_appcast',
}

const requireFromHere = createRequire(import.meta.url)

const defaultOperations: ArtifactOperations = {
  readFile,
  readlink,
  access,
  stat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  copyFile,
  getPlatform: platform,
  getHomeDirectory: homedir,
  runCommand,
}

export function nativeAddonFilename(architecture: DarwinArchitecture): string {
  return `${NATIVE_MODULE_NAME}.darwin-${architecture}.node`
}

/** Resolve the archive and target-qualified addon published in this package. */
export function resolvePublishedDarwinArtifacts(
  options: ResolveDarwinArtifactsOptions = {},
): PublishedDarwinArtifacts {
  const operations = operationsFor(options)
  assertDarwin(operations, options.allowNonDarwin)
  const architecture = normalizeDarwinArchitecture(options.architecture)
  const packageRoot = options.packageRoot ?? defaultPackageRoot()
  const root = join(packageRoot, 'dist')

  return {
    architecture,
    root,
    archivePath: join(root, SPARKLE_ARCHIVE_FILENAME),
    archiveSha256: SPARKLE_ARCHIVE_SHA256,
    addonPath: join(root, nativeAddonFilename(architecture)),
    licensePath: join(root, 'licenses', SPARKLE_LICENSE_FILENAME),
    licenseSha256: SPARKLE_LICENSE_SHA256,
  }
}

/**
 * Restore Sparkle's framework symlinks and executable modes from its official
 * zip. npm package tarballs intentionally omit symlinks, so publishing the
 * framework directory itself would produce an invalid signed bundle.
 */
export async function materializeDarwinDistribution(
  options: MaterializeDarwinDistributionOptions = {},
): Promise<DarwinDistribution> {
  const operations = operationsFor(options)
  assertDarwin(operations, options.allowNonDarwin)
  const source = options.source ?? resolvePublishedDarwinArtifacts(options)
  const architecture = normalizeDarwinArchitecture(source.architecture)

  await Promise.all([
    assertReadable(operations, source.archivePath, 'Sparkle archive'),
    assertReadable(operations, source.addonPath, 'native addon'),
    assertReadable(operations, source.licensePath, 'Sparkle license'),
  ])

  const [, addonSha256, licenseSha256] = await Promise.all([
    verifyArchiveChecksum(operations, source.archivePath, source.archiveSha256),
    checksumFile(operations, source.addonPath),
    checksumFile(operations, source.licensePath),
  ])
  if (licenseSha256.toLowerCase() !== source.licenseSha256.toLowerCase()) {
    throw new ElectronSparkleToolingError(
      'LICENSE_CHECKSUM_MISMATCH',
      `Sparkle license checksum mismatch at ${source.licensePath}: expected ${source.licenseSha256}, received ${licenseSha256}.`,
    )
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        addonSha256,
        architecture,
        archiveSha256: source.archiveSha256.toLowerCase(),
        licenseSha256,
        sparkleVersion: SPARKLE_VERSION,
      }),
    )
    .digest('hex')
  const cacheKey = `${SPARKLE_VERSION}-${architecture}-${fingerprint}`
  const cacheDirectory =
    options.cacheDirectory ??
    join(operations.getHomeDirectory(), 'Library', 'Caches', 'electron-sparkle')
  const root = join(cacheDirectory, cacheKey, 'payload')
  const materialized = distributionAt(root, cacheKey, architecture)

  if (await isCompleteDistribution(operations, materialized)) return materialized

  await operations.mkdir(cacheDirectory, { recursive: true })
  const stagingDirectory = await operations.mkdtemp(join(cacheDirectory, '.electron-sparkle-'))
  const stagingPayload = join(stagingDirectory, 'payload')
  const extractedDirectory = join(stagingDirectory, 'archive')

  try {
    await Promise.all([
      operations.mkdir(stagingPayload, { recursive: true }),
      operations.mkdir(extractedDirectory, { recursive: true }),
    ])
    await extractZip(operations, source.archivePath, extractedDirectory)
    await Promise.all([
      copyWithDitto(
        operations,
        join(extractedDirectory, SPARKLE_FRAMEWORK_IN_ARCHIVE),
        join(stagingPayload, 'Sparkle.framework'),
      ),
      copyWithDitto(operations, join(extractedDirectory, 'bin'), join(stagingPayload, 'bin')),
      operations.copyFile(source.addonPath, join(stagingPayload, 'electron_sparkle.node')),
      operations.copyFile(source.licensePath, join(stagingPayload, SPARKLE_LICENSE_FILENAME)),
    ])

    const staged = distributionAt(stagingPayload, cacheKey, architecture)
    if (!(await isCompleteDistribution(operations, staged))) {
      throw new ElectronSparkleToolingError(
        'MATERIALIZATION_FAILED',
        'The restored Sparkle distribution is incomplete.',
      )
    }

    await operations.mkdir(dirname(root), { recursive: true })
    try {
      await operations.rename(stagingPayload, root)
    } catch {
      if (await isCompleteDistribution(operations, materialized)) return materialized
      await operations.rm(root, { force: true, recursive: true })
      await operations.rename(stagingPayload, root)
    }

    return materialized
  } catch (error) {
    if (error instanceof ElectronSparkleToolingError) throw error
    throw new ElectronSparkleToolingError(
      'MATERIALIZATION_FAILED',
      `Could not restore Sparkle ${SPARKLE_VERSION} from ${source.archivePath}.`,
      { cause: error },
    )
  } finally {
    await operations.rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined)
  }
}

export function normalizeDarwinArchitecture(
  architecture: string | number | undefined = process.arch,
): DarwinArchitecture {
  if (architecture === 'arm64' || architecture === 3) return 'arm64'
  if (architecture === 'x64' || architecture === 'x86_64' || architecture === 1) return 'x64'

  throw new ElectronSparkleToolingError(
    'UNSUPPORTED_ARCHITECTURE',
    `electron-sparkle supports macOS arm64 and x64 builds; received ${String(architecture)}.`,
  )
}

export async function resolveOfficialTool(options: OfficialToolOptions): Promise<string> {
  const distribution = await materializeDarwinDistribution(options)
  const tool = join(distribution.toolsDirectory, OFFICIAL_TOOL_FILENAMES[options.name])
  try {
    await operationsFor(options).access(tool, fsConstants.X_OK)
  } catch (error) {
    throw new ElectronSparkleToolingError(
      'OFFICIAL_TOOL_MISSING',
      `Sparkle's official ${OFFICIAL_TOOL_FILENAMES[options.name]} tool is missing or not executable at ${tool}.`,
      { cause: error },
    )
  }
  return tool
}

export async function verifyArchiveChecksum(
  operations: Pick<ArtifactOperations, 'readFile'>,
  archivePath: string,
  expectedChecksum: string,
): Promise<void> {
  const actualChecksum = await checksumFile(operations, archivePath)
  if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new ElectronSparkleToolingError(
      'ARCHIVE_CHECKSUM_MISMATCH',
      `Sparkle archive checksum mismatch at ${archivePath}: expected ${expectedChecksum}, received ${actualChecksum}.`,
    )
  }
}

export function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{ cwd?: string }> = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...arguments_], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      resolvePromise({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

async function extractZip(
  operations: Pick<ArtifactOperations, 'runCommand'>,
  archivePath: string,
  destination: string,
): Promise<void> {
  const result = await operations.runCommand('/usr/bin/ditto', [
    '-x',
    '-k',
    archivePath,
    destination,
  ])
  assertSuccessfulCommand(result, `extract Sparkle archive ${archivePath}`)
}

async function copyWithDitto(
  operations: Pick<ArtifactOperations, 'runCommand'>,
  source: string,
  destination: string,
): Promise<void> {
  const result = await operations.runCommand('/usr/bin/ditto', [source, destination])
  assertSuccessfulCommand(result, `copy Sparkle distribution path ${basename(source)}`)
}

function assertSuccessfulCommand(result: CommandResult, action: string): void {
  if (result.exitCode === 0) return
  const detail = result.stderr.trim() || result.stdout.trim()
  throw new ElectronSparkleToolingError(
    'MATERIALIZATION_FAILED',
    `Could not ${action}${detail ? `: ${detail}` : '.'}`,
  )
}

function distributionAt(
  root: string,
  cacheKey: string,
  architecture: DarwinArchitecture,
): DarwinDistribution {
  return {
    architecture,
    cacheKey,
    root,
    frameworkPath: join(root, 'Sparkle.framework'),
    addonPath: join(root, 'electron_sparkle.node'),
    licensePath: join(root, SPARKLE_LICENSE_FILENAME),
    toolsDirectory: join(root, 'bin'),
  }
}

async function isCompleteDistribution(
  operations: Pick<ArtifactOperations, 'access' | 'readlink' | 'stat'>,
  distribution: DarwinDistribution,
): Promise<boolean> {
  try {
    const [framework, addon, license, generateKeys, signUpdate, generateAppcast, currentVersion] =
      await Promise.all([
        operations.stat(distribution.frameworkPath),
        operations.stat(distribution.addonPath),
        operations.stat(distribution.licensePath),
        operations.stat(join(distribution.toolsDirectory, 'generate_keys')),
        operations.stat(join(distribution.toolsDirectory, 'sign_update')),
        operations.stat(join(distribution.toolsDirectory, 'generate_appcast')),
        operations.readlink(join(distribution.frameworkPath, 'Versions', 'Current')),
        operations.access(join(distribution.frameworkPath, 'Sparkle'), fsConstants.R_OK),
        operations.access(join(distribution.toolsDirectory, 'generate_keys'), fsConstants.X_OK),
        operations.access(join(distribution.toolsDirectory, 'sign_update'), fsConstants.X_OK),
        operations.access(join(distribution.toolsDirectory, 'generate_appcast'), fsConstants.X_OK),
      ])
    return (
      framework.isDirectory() &&
      addon.isFile() &&
      license.isFile() &&
      generateKeys.isFile() &&
      signUpdate.isFile() &&
      generateAppcast.isFile() &&
      currentVersion === SPARKLE_FRAMEWORK_VERSION
    )
  } catch {
    return false
  }
}

async function assertReadable(
  operations: Pick<ArtifactOperations, 'access'>,
  path: string,
  label: string,
): Promise<void> {
  try {
    await operations.access(path, fsConstants.R_OK)
  } catch (error) {
    throw new ElectronSparkleToolingError(
      'DARWIN_ARTIFACTS_MISSING',
      `electron-sparkle's ${label} is missing or unreadable at ${path}. Reinstall the package from a complete release.`,
      { cause: error },
    )
  }
}

async function checksumFile(
  operations: Pick<ArtifactOperations, 'readFile'>,
  path: string,
): Promise<string> {
  return createHash('sha256')
    .update(await operations.readFile(path))
    .digest('hex')
}

function assertDarwin(
  operations: Pick<ArtifactOperations, 'getPlatform'>,
  allowNonDarwin = false,
): void {
  if (!allowNonDarwin && operations.getPlatform() !== 'darwin') {
    throw new ElectronSparkleToolingError(
      'UNSUPPORTED_PLATFORM',
      'electron-sparkle’s Sparkle integration is available only on macOS (darwin).',
    )
  }
}

function operationsFor(overrides: ArtifactOperationOverrides): ArtifactOperations {
  return { ...defaultOperations, ...overrides }
}

function defaultPackageRoot(): string {
  return dirname(requireFromHere.resolve('electron-sparkle/package.json'))
}
