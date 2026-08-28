import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform === 'darwin') {
  process.stdout.write('cross-platform install check skipped on darwin\n')
  process.exit(0)
}

const projectDirectory = resolve(import.meta.dirname, '..')
const packageManifest = await readPackageManifest(join(projectDirectory, 'package.json'))
const mainTarball = resolve(projectDirectory, 'release', npmTarballName(packageManifest))
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'electron-sparkle-install-'))
const vitePlusInstall =
  process.platform === 'win32'
    ? {
        executable: process.env.ComSpec ?? 'cmd.exe',
        arguments: ['/d', '/s', '/c', 'vp install --no-lockfile'],
      }
    : { executable: 'vp', arguments: ['install', '--no-lockfile'] }

try {
  await writeFile(
    join(temporaryDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'electron-sparkle-cross-platform-install',
        private: true,
        version: '1.0.0',
        dependencies: {
          'electron-sparkle': fileSpecifier(mainTarball),
        },
      },
      null,
      2,
    )}\n`,
  )

  run(vitePlusInstall.executable, vitePlusInstall.arguments, temporaryDirectory)

  await assert.rejects(access(join(temporaryDirectory, 'node_modules/electron-sparkle-darwin')), {
    code: 'ENOENT',
  })

  run(
    process.execPath,
    [
      '-e',
      "const { ElectronSparkle } = require('electron-sparkle/electron-forge'); if (typeof ElectronSparkle !== 'function') throw new Error('CommonJS Forge export is unavailable'); const { updater } = require('electron-sparkle'); try { updater.start(); process.exit(2) } catch (error) { if (error.code !== 'UNSUPPORTED_PLATFORM') throw error }",
    ],
    temporaryDirectory,
  )

  process.stdout.write('cross-platform single-package install verified\n')
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

function fileSpecifier(path: string): string {
  return `file:${path.replaceAll('\\', '/')}`
}

interface PackageManifest {
  name: string
  version: string
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('version' in value) ||
    typeof value.version !== 'string'
  ) {
    throw new Error(`Package manifest is missing a name or version: ${path}`)
  }
  return { name: value.name, version: value.version }
}

function npmTarballName(manifest: PackageManifest): string {
  const packageName = manifest.name.replace(/^@/, '').replaceAll('/', '-')
  return `${packageName}-${manifest.version}.tgz`
}

function run(executable: string, arguments_: string[], cwd: string): void {
  const result = spawnSync(executable, arguments_, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  })
  const command = `${executable} ${arguments_.join(' ')}`
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`, {
      cause: result.error,
    })
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`)
  }
}
