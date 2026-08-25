import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CommandResult,
  type CommandRunner,
  type DarwinArchitecture,
  type DarwinDistribution,
  type MaterializeDarwinDistributionOptions,
  materializeDarwinDistribution,
  runCommand,
} from '../tooling/artifacts.ts'

export type DoctorSeverity = 'error' | 'success'

export interface DoctorDiagnostic {
  readonly severity: DoctorSeverity
  readonly message: string
}

export interface DoctorResult {
  readonly ok: boolean
  readonly diagnostics: readonly DoctorDiagnostic[]
}

export interface DoctorOptions extends MaterializeDarwinDistributionOptions {
  /** A packaged .app bundle. Omit to inspect this package's installed artifacts. */
  readonly appPath?: string
  readonly resolveDistribution?: (
    options: MaterializeDarwinDistributionOptions,
  ) => DarwinDistribution | Promise<DarwinDistribution>
  readonly runCommand?: CommandRunner
  readonly access?: typeof access
}

interface DoctorTargets {
  readonly frameworkPath: string
  readonly addonPath: string
  readonly licensePath: string
  readonly addonArchitecture?: DarwinArchitecture
  readonly plistPath?: string
  readonly codeSignTarget?: string
}

/** Perform offline structural checks; doctor never contacts an update feed. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const diagnostics: DoctorDiagnostic[] = []
  const command = options.runCommand ?? runCommand
  const checkAccess = options.access ?? access

  let targets: DoctorTargets
  if (options.appPath) {
    targets = targetsForApp(options.appPath)
  } else {
    const resolveDistribution = options.resolveDistribution ?? materializeDarwinDistribution
    try {
      const distribution = await resolveDistribution(options)
      diagnostics.push(success(`Installed Sparkle artifacts: ${distribution.root}`))
      targets = targetsForDistribution(distribution)
    } catch (error) {
      diagnostics.push(failure(errorMessage(error)))
      return result(diagnostics)
    }
  }

  const accessDiagnostics = await Promise.all(
    (
      [
        ['Sparkle framework', targets.frameworkPath],
        ['native addon', targets.addonPath],
        ['Sparkle license', targets.licensePath],
      ] as const
    ).map(async ([label, path]) => {
      try {
        await checkAccess(path)
        return success(`${label} found: ${path}`)
      } catch {
        return failure(`${label} is missing: ${path}`)
      }
    }),
  )
  diagnostics.push(...accessDiagnostics)

  await diagnoseArchitectures(
    command,
    join(targets.frameworkPath, 'Sparkle'),
    'Sparkle framework',
    diagnostics,
  )
  await diagnoseAddonArchitectures(
    command,
    targets.addonPath,
    targets.addonArchitecture,
    diagnostics,
  )
  await diagnoseAddonLinkage(command, targets.addonPath, diagnostics)
  await diagnoseAddonRpath(command, targets.addonPath, diagnostics)

  if (targets.plistPath) {
    await diagnosePlist(command, targets.plistPath, diagnostics)
  }
  if (targets.codeSignTarget) {
    await diagnoseCodeSignature(command, targets.codeSignTarget, diagnostics)
  }

  return result(diagnostics)
}

function targetsForDistribution(distribution: DarwinDistribution): DoctorTargets {
  return {
    frameworkPath: distribution.frameworkPath,
    addonPath: distribution.addonPath,
    licensePath: distribution.licensePath,
    addonArchitecture: distribution.architecture,
  }
}

function targetsForApp(appPath: string): DoctorTargets {
  const frameworks = join(appPath, 'Contents', 'Frameworks')
  const resources = join(appPath, 'Contents', 'Resources')
  return {
    frameworkPath: join(frameworks, 'Sparkle.framework'),
    addonPath: join(frameworks, 'electron_sparkle.node'),
    licensePath: join(resources, 'ThirdPartyLicenses', 'Sparkle-LICENSE.txt'),
    plistPath: join(appPath, 'Contents', 'Info.plist'),
    codeSignTarget: appPath,
  }
}

async function diagnoseAddonArchitectures(
  command: CommandRunner,
  path: string,
  expectedArchitecture: DarwinArchitecture | undefined,
  diagnostics: DoctorDiagnostic[],
): Promise<void> {
  const commandResult = await safelyRun(command, '/usr/bin/lipo', ['-archs', path])
  if (!commandResult.ok) {
    diagnostics.push(
      failure(`Could not inspect native addon architectures: ${commandResult.message}`),
    )
    return
  }

  const architectures = new Set(commandResult.result.stdout.trim().split(/\s+/).filter(Boolean))
  const expected = expectedArchitecture === 'x64' ? 'x86_64' : expectedArchitecture
  if (expected && !architectures.has(expected)) {
    diagnostics.push(failure(`native addon is missing required architecture: ${expected}.`))
    return
  }
  if (!expected && !architectures.has('arm64') && !architectures.has('x86_64')) {
    diagnostics.push(failure('native addon does not contain a supported macOS architecture.'))
    return
  }

  diagnostics.push(success(`native addon supports ${[...architectures].toSorted().join(' and ')}.`))
}

async function diagnoseArchitectures(
  command: CommandRunner,
  path: string,
  label: string,
  diagnostics: DoctorDiagnostic[],
): Promise<void> {
  const commandResult = await safelyRun(command, '/usr/bin/lipo', ['-archs', path])
  if (!commandResult.ok) {
    diagnostics.push(failure(`Could not inspect ${label} architectures: ${commandResult.message}`))
    return
  }

  const architectures = new Set(commandResult.result.stdout.trim().split(/\s+/).filter(Boolean))
  const missing = ['arm64', 'x86_64'].filter((architecture) => !architectures.has(architecture))
  if (missing.length > 0) {
    diagnostics.push(
      failure(`${label} is missing required architecture(s): ${missing.join(', ')}.`),
    )
    return
  }
  diagnostics.push(success(`${label} supports arm64 and x86_64.`))
}

async function diagnoseAddonLinkage(
  command: CommandRunner,
  addonPath: string,
  diagnostics: DoctorDiagnostic[],
): Promise<void> {
  const commandResult = await safelyRun(command, '/usr/bin/otool', ['-L', addonPath])
  if (!commandResult.ok) {
    diagnostics.push(failure(`Could not inspect native addon linkage: ${commandResult.message}`))
    return
  }
  if (!commandResult.result.stdout.includes('Sparkle.framework')) {
    diagnostics.push(failure('Native addon is not linked against Sparkle.framework.'))
    return
  }
  diagnostics.push(success('Native addon links Sparkle.framework.'))
}

async function diagnoseAddonRpath(
  command: CommandRunner,
  addonPath: string,
  diagnostics: DoctorDiagnostic[],
): Promise<void> {
  const commandResult = await safelyRun(command, '/usr/bin/otool', ['-l', addonPath])
  if (!commandResult.ok) {
    diagnostics.push(failure(`Could not inspect native addon rpaths: ${commandResult.message}`))
    return
  }
  if (!/cmd\s+LC_RPATH[\s\S]*?path\s+@loader_path(?:\s|$)/.test(commandResult.result.stdout)) {
    diagnostics.push(failure('Native addon is missing the required LC_RPATH @loader_path.'))
    return
  }
  diagnostics.push(success('Native addon has LC_RPATH @loader_path.'))
}

async function diagnosePlist(
  command: CommandRunner,
  plistPath: string,
  diagnostics: DoctorDiagnostic[],
): Promise<void> {
  const commandResult = await safelyRun(command, '/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    plistPath,
  ])
  if (!commandResult.ok) {
    diagnostics.push(failure(`Could not read Info.plist: ${commandResult.message}`))
    return
  }

  let plist: unknown
  try {
    plist = JSON.parse(commandResult.result.stdout)
  } catch {
    diagnostics.push(failure(`Info.plist did not produce valid JSON: ${plistPath}`))
    return
  }
  if (!isRecord(plist)) {
    diagnostics.push(failure(`Info.plist root is not a dictionary: ${plistPath}`))
    return
  }

  for (const key of ['SUFeedURL', 'SUPublicEDKey'] as const) {
    if (typeof plist[key] !== 'string' || plist[key].trim().length === 0) {
      diagnostics.push(failure(`Info.plist is missing a non-empty ${key} value.`))
    } else {
      diagnostics.push(success(`Info.plist contains ${key}.`))
    }
  }

  if ('SUScheduledCheckInterval' in plist) {
    const interval = plist.SUScheduledCheckInterval
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 3600) {
      diagnostics.push(
        failure('Info.plist SUScheduledCheckInterval must be a number of at least 3600 seconds.'),
      )
    } else {
      diagnostics.push(success('Info.plist has a valid SUScheduledCheckInterval.'))
    }
  }
}

async function diagnoseCodeSignature(
  command: CommandRunner,
  appPath: string,
  diagnostics: DoctorDiagnostic[],
): Promise<void> {
  const commandResult = await safelyRun(command, '/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    appPath,
  ])
  if (!commandResult.ok) {
    diagnostics.push(failure(`Code-signature verification failed: ${commandResult.message}`))
    return
  }
  diagnostics.push(success('Code signature verifies with codesign --verify --deep --strict.'))

  const signatureDetails = await safelyRun(command, '/usr/bin/codesign', [
    '--display',
    '--verbose=2',
    appPath,
  ])
  if (!signatureDetails.ok) {
    diagnostics.push(
      failure(`Could not inspect code-signing identity: ${signatureDetails.message}`),
    )
    return
  }

  const details = `${signatureDetails.result.stdout}\n${signatureDetails.result.stderr}`
  if (/(?:^|\n)Signature=adhoc(?:\n|$)/.test(details)) {
    diagnostics.push(
      success(
        'Code signature is ad hoc; Sparkle update authenticity depends on SUPublicEDKey and EdDSA-signed archives.',
      ),
    )
    return
  }

  const authority = details.match(/(?:^|\n)Authority=([^\n]+)/)?.[1]
  diagnostics.push(
    success(
      authority
        ? `Code signature uses certificate authority: ${authority}.`
        : 'Code signature uses a certificate-backed identity.',
    ),
  )
}

async function safelyRun(
  command: CommandRunner,
  executable: string,
  arguments_: readonly string[],
): Promise<{ ok: true; result: CommandResult } | { ok: false; message: string }> {
  try {
    const commandResult = await command(executable, arguments_)
    if (commandResult.exitCode === 0) {
      return { ok: true, result: commandResult }
    }
    return {
      ok: false,
      message:
        commandResult.stderr.trim() ||
        commandResult.stdout.trim() ||
        `${executable} exited ${commandResult.exitCode ?? 'by signal'}`,
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

function success(message: string): DoctorDiagnostic {
  return { severity: 'success', message }
}

function failure(message: string): DoctorDiagnostic {
  return { severity: 'error', message }
}

function result(diagnostics: readonly DoctorDiagnostic[]): DoctorResult {
  return { ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), diagnostics }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
