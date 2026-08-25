import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform === 'darwin') {
  process.stdout.write('cross-platform install check skipped on darwin\n')
  process.exit(0)
}

const projectDirectory = resolve(import.meta.dirname, '..')
const mainTarball = resolve(projectDirectory, 'release/electron-sparkle-0.1.0.tgz')
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
