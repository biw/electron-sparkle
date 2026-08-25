import { spawn } from 'node:child_process'
import { type OfficialToolName, resolveOfficialTool } from '../tooling/artifacts.ts'
import { runDoctor, type DoctorOptions } from './doctor.ts'

export interface CliIo {
  readonly writeOut: (text: string) => void
  readonly writeError: (text: string) => void
}

export interface ToolProcess {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

export interface CliDependencies extends Partial<CliIo> {
  readonly resolveOfficialTool?: (options: { name: OfficialToolName }) => Promise<string>
  readonly spawnTool?: (executable: string, arguments_: readonly string[]) => Promise<ToolProcess>
  readonly doctor?: (options: DoctorOptions) => ReturnType<typeof runDoctor>
  readonly doctorOptions?: DoctorOptions
}

const USAGE = `Usage: electron-sparkle <command> [arguments]\n\nCommands:\n  generate-keys [args]       Run Sparkle's official generate_keys tool\n  sign-update [args]         Run Sparkle's official sign_update tool\n  generate-appcast [args]    Run Sparkle's official generate_appcast tool\n  doctor [--app <path>]      Validate installed artifacts or a packaged macOS app\n`

/** Entrypoint used by the bin shim. Tool arguments are passed through verbatim. */
export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const io: CliIo = {
    writeOut: dependencies.writeOut ?? ((text) => process.stdout.write(text)),
    writeError: dependencies.writeError ?? ((text) => process.stderr.write(text)),
  }
  const [command, ...arguments_] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.writeOut(USAGE)
    return 0
  }

  if (command === 'doctor') {
    return runDoctorCommand(arguments_, io, dependencies)
  }

  if (isOfficialToolName(command)) {
    return runOfficialToolCommand(command, arguments_, io, dependencies)
  }

  io.writeError(`Unknown command: ${command}\n\n${USAGE}`)
  return 2
}

async function runOfficialToolCommand(
  name: OfficialToolName,
  arguments_: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  try {
    const resolveTool = dependencies.resolveOfficialTool ?? resolveOfficialTool
    const toolPath = await resolveTool({ name })
    const spawnTool = dependencies.spawnTool ?? spawnWithInheritedIo
    const result = await spawnTool(toolPath, arguments_)
    if (result.exitCode !== null) {
      return result.exitCode
    }
    io.writeError(`${name} ended due to ${result.signal ?? 'an unknown signal'}.\n`)
    return 1
  } catch (error) {
    io.writeError(`${errorMessage(error)}\n`)
    return 1
  }
}

async function runDoctorCommand(
  arguments_: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseDoctorArguments(arguments_)
  if (typeof parsed === 'string') {
    io.writeError(`${parsed}\n`)
    return 2
  }

  try {
    const doctor = dependencies.doctor ?? runDoctor
    const result = await doctor({
      ...dependencies.doctorOptions,
      ...(parsed.appPath ? { appPath: parsed.appPath } : {}),
    })
    for (const diagnostic of result.diagnostics) {
      const writer = diagnostic.severity === 'error' ? io.writeError : io.writeOut
      writer(`${diagnostic.severity === 'error' ? '✗' : '✓'} ${diagnostic.message}\n`)
    }
    return result.ok ? 0 : 1
  } catch (error) {
    io.writeError(`${errorMessage(error)}\n`)
    return 1
  }
}

function parseDoctorArguments(arguments_: readonly string[]): { appPath?: string } | string {
  if (arguments_.length === 0) {
    return {}
  }
  if (arguments_.length === 2 && arguments_[0] === '--app' && arguments_[1]) {
    return { appPath: arguments_[1] }
  }
  return 'Usage: electron-sparkle doctor [--app <path>]'
}

function isOfficialToolName(value: string): value is OfficialToolName {
  return value === 'generate-keys' || value === 'sign-update' || value === 'generate-appcast'
}

function spawnWithInheritedIo(
  executable: string,
  arguments_: readonly string[],
): Promise<ToolProcess> {
  return new Promise((resolvePromise, reject) => {
    // Do not inspect arguments or streams here: Sparkle's tools may read private
    // key material from Keychain/stdin, and this wrapper must never handle it.
    const child = spawn(executable, [...arguments_], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal }))
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
