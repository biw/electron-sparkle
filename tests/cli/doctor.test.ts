import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { runDoctor } from '../../src/cli/doctor.ts'

const distribution = {
  architecture: 'x64' as const,
  cacheKey: 'test-cache-key',
  root: '/cache/payload',
  frameworkPath: '/cache/payload/Sparkle.framework',
  addonPath: '/cache/payload/electron_sparkle.node',
  licensePath: '/cache/payload/Sparkle-LICENSE.txt',
  toolsDirectory: '/cache/payload/bin',
}

test('doctor verifies the installed framework and target-qualified addon', async () => {
  const calls: Array<{ executable: string; commandArguments: readonly string[] }> = []
  const result = await runDoctor({
    resolveDistribution: async () => distribution,
    access: async () => undefined,
    runCommand: async (executable, arguments_) => {
      calls.push({ executable, commandArguments: arguments_ })
      if (executable.endsWith('lipo')) {
        return { exitCode: 0, signal: null, stdout: 'arm64 x86_64\n', stderr: '' }
      }
      if (arguments_[0] === '-l') {
        return {
          exitCode: 0,
          signal: null,
          stdout:
            'Load command 1\n      cmd LC_RPATH\n  cmdsize 32\n     path @loader_path (offset 12)\n',
          stderr: '',
        }
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: 'electron_sparkle.node:\n\t@rpath/Sparkle.framework/Versions/B/Sparkle\n',
        stderr: '',
      }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(calls.filter((call) => call.executable.endsWith('lipo')).length, 2)
  assert.ok(
    calls.some(
      (call) =>
        call.executable.endsWith('lipo') &&
        call.commandArguments[1] === '/cache/payload/Sparkle.framework/Sparkle',
    ),
  )
  assert.ok(
    calls.some((call) => call.executable.endsWith('otool') && call.commandArguments[0] === '-l'),
  )
})

test('doctor reports a missing universal architecture', async () => {
  const result = await runDoctor({
    resolveDistribution: async () => distribution,
    access: async () => undefined,
    runCommand: async (executable, arguments_) => {
      if (executable.endsWith('lipo')) {
        return { exitCode: 0, signal: null, stdout: 'arm64\n', stderr: '' }
      }
      if (arguments_[0] === '-l') {
        return {
          exitCode: 0,
          signal: null,
          stdout: 'cmd LC_RPATH\npath @loader_path (offset 12)\n',
          stderr: '',
        }
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: '@rpath/Sparkle.framework/Versions/B/Sparkle\n',
        stderr: '',
      }
    },
  })

  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes('x86_64')))
})

test('doctor validates Info.plist and code signature for a packaged app', async () => {
  const result = await runDoctor({
    appPath: '/Applications/Test.app',
    access: async () => undefined,
    runCommand: async (executable, arguments_) => {
      if (executable.endsWith('lipo')) {
        return { exitCode: 0, signal: null, stdout: 'arm64 x86_64\n', stderr: '' }
      }
      if (executable.endsWith('otool')) {
        if (arguments_[0] === '-l') {
          return {
            exitCode: 0,
            signal: null,
            stdout:
              'Load command 1\n      cmd LC_RPATH\n  cmdsize 32\n     path @loader_path (offset 12)\n',
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: '@rpath/Sparkle.framework/Versions/B/Sparkle\n',
          stderr: '',
        }
      }
      if (executable.endsWith('plutil')) {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            SUFeedURL: 'https://updates.example.com/appcast.xml',
            SUPublicEDKey: 'public-key',
          }),
          stderr: '',
        }
      }
      if (executable.endsWith('codesign') && arguments_[0] === '--display') {
        return { exitCode: 0, signal: null, stdout: '', stderr: 'Signature=adhoc\n' }
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    },
  })

  assert.equal(result.ok, true)
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.message.includes('Code signature verifies')),
  )
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.message.includes('signature is ad hoc')),
  )
})

test('doctor reports a certificate-backed signing authority', async () => {
  const result = await runDoctor({
    appPath: '/Applications/Test.app',
    access: async () => undefined,
    runCommand: async (executable, arguments_) => {
      if (executable.endsWith('lipo')) {
        return { exitCode: 0, signal: null, stdout: 'arm64 x86_64\n', stderr: '' }
      }
      if (executable.endsWith('otool')) {
        return arguments_[0] === '-l'
          ? {
              exitCode: 0,
              signal: null,
              stdout: 'cmd LC_RPATH\npath @loader_path (offset 12)\n',
              stderr: '',
            }
          : {
              exitCode: 0,
              signal: null,
              stdout: '@rpath/Sparkle.framework/Versions/B/Sparkle\n',
              stderr: '',
            }
      }
      if (executable.endsWith('plutil')) {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            SUFeedURL: 'https://updates.example.com/appcast.xml',
            SUPublicEDKey: 'public-key',
          }),
          stderr: '',
        }
      }
      if (executable.endsWith('codesign') && arguments_[0] === '--display') {
        return {
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: 'Authority=Developer ID Application: Example Corp (TEAMID)\n',
        }
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    },
  })

  assert.equal(result.ok, true)
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('Developer ID Application: Example Corp'),
    ),
  )
})
