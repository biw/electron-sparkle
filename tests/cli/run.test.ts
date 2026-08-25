import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { runCli } from '../../src/cli/run.ts'

test('forwards official-tool arguments and exit status without inspecting them', async () => {
  const calls: Array<{ executable: string; arguments_: readonly string[] }> = []
  const exitCode = await runCli(['sign-update', '--ed-key', 'private-input', 'release.zip'], {
    resolveOfficialTool: async () => '/package/dist/bin/sign_update',
    spawnTool: async (executable, arguments_) => {
      calls.push({ executable, arguments_ })
      return { exitCode: 17, signal: null }
    },
  })

  assert.equal(exitCode, 17)
  assert.deepEqual(calls, [
    {
      executable: '/package/dist/bin/sign_update',
      arguments_: ['--ed-key', 'private-input', 'release.zip'],
    },
  ])
})

test('doctor prints diagnostics and returns failure status', async () => {
  const output: string[] = []
  const errors: string[] = []
  const exitCode = await runCli(['doctor', '--app', '/Applications/Test.app'], {
    writeOut: (line) => output.push(line),
    writeError: (line) => errors.push(line),
    doctor: async (options) => {
      assert.equal(options.appPath, '/Applications/Test.app')
      return {
        ok: false,
        diagnostics: [
          { severity: 'success', message: 'artifacts present' },
          { severity: 'error', message: 'missing arm64' },
        ],
      }
    },
  })

  assert.equal(exitCode, 1)
  assert.match(output.join(''), /artifacts present/)
  assert.match(errors.join(''), /missing arm64/)
})

test('doctor accepts only its documented --app argument', async () => {
  const errors: string[] = []
  const exitCode = await runCli(['doctor', '--unexpected'], {
    writeError: (line) => errors.push(line),
  })

  assert.equal(exitCode, 2)
  assert.match(errors.join(''), /Usage: electron-sparkle doctor/)
})
