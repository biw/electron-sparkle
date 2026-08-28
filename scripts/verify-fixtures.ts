import assert from 'node:assert/strict'
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process'
import { access, mkdtemp, readFile, readdir, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { hasExpectedChecksum, sparkleLicense } from './acquire-sparkle.ts'

interface Fixture {
  app: string
  addonArchitectures: readonly string[]
  afterPackMarker?: string
  executable: string
  name: string
  resolveHookPlistKeys?: string[]
}

assert.equal(process.platform, 'darwin', 'Fixture verification requires macOS')

const projectDirectory = resolve(import.meta.dirname, '..')
const packageVersion = await readPackageVersion(join(projectDirectory, 'package.json'))
const shouldSignFixtures = process.env.ELECTRON_SPARKLE_SIGN_FIXTURES !== 'false'
const fixtures: Fixture[] = [
  {
    app: resolve(
      projectDirectory,
      'tests/fixtures/electron-builder/out/mac-universal/ElectronSparkleBuilderFixture.app',
    ),
    addonArchitectures: ['arm64', 'x86_64'],
    afterPackMarker: 'fixture-after-pack.txt',
    executable: 'ElectronSparkleBuilderFixture',
    name: 'Electron Builder',
  },
  {
    app: resolve(
      projectDirectory,
      'tests/fixtures/electron-forge/out/ElectronSparkleForgeFixture-darwin-arm64/ElectronSparkleForgeFixture.app',
    ),
    addonArchitectures: ['arm64'],
    executable: 'ElectronSparkleForgeFixture',
    resolveHookPlistKeys: [
      'ElectronSparkleFixtureResolveHook',
      'ElectronSparkleFixtureEarlierPlugin',
    ],
    name: 'Electron Forge',
  },
]

const resultDirectory = await mkdtemp(join(tmpdir(), 'electron-sparkle-smoke-'))

try {
  await Promise.all(fixtures.map((fixture) => verifyFixture(fixture)))
} finally {
  await rm(resultDirectory, { force: true, recursive: true })
}

process.stdout.write('Electron Builder and Electron Forge fixtures verified\n')

async function verifyFixture(fixture: Fixture): Promise<void> {
  const contents = join(fixture.app, 'Contents')
  const frameworks = join(contents, 'Frameworks')
  const framework = join(frameworks, 'Sparkle.framework')
  const frameworkBinary = join(framework, 'Sparkle')
  const addon = join(frameworks, 'electron_sparkle.node')
  const resources = join(contents, 'Resources')
  const installMarker = join(resources, '.electron-sparkle.json')
  const sparkleLicensePath = join(resources, 'ThirdPartyLicenses', 'Sparkle-LICENSE.txt')

  await Promise.all([
    access(fixture.app),
    access(framework),
    access(addon),
    access(installMarker),
    access(sparkleLicensePath),
  ])
  assert.equal(
    await hasExpectedChecksum(sparkleLicensePath, sparkleLicense.sha256),
    true,
    `${fixture.name} does not contain Sparkle's complete upstream license`,
  )
  assert.equal(await readlink(join(framework, 'Versions', 'Current')), 'B')

  assert.deepEqual(JSON.parse(await readFile(installMarker, 'utf8')), {
    schemaVersion: 1,
    packageName: 'electron-sparkle',
    packageVersion,
    sparkleVersion: '2.9.6',
  })
  await assertFrameworksContainCodeOnly(frameworks, fixture.name)

  const frameworkArchitectures = run('/usr/bin/lipo', ['-archs', frameworkBinary]).stdout
  assert.match(frameworkArchitectures, /\barm64\b/)
  assert.match(frameworkArchitectures, /\bx86_64\b/)

  const addonArchitectures = run('/usr/bin/lipo', ['-archs', addon]).stdout
  for (const architecture of fixture.addonArchitectures) {
    assert.match(addonArchitectures, new RegExp(`\\b${architecture}\\b`))
  }
  for (const architecture of ['arm64', 'x86_64']) {
    if (!fixture.addonArchitectures.includes(architecture)) {
      assert.doesNotMatch(addonArchitectures, new RegExp(`\\b${architecture}\\b`))
    }
  }

  assert.match(run('/usr/bin/otool', ['-L', addon]).stdout, /Sparkle\.framework/)
  assert.match(run('/usr/bin/otool', ['-l', addon]).stdout, /@loader_path/)

  const plist = JSON.parse(
    run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(contents, 'Info.plist')]).stdout,
  )
  assert.equal(plist.SUFeedURL, 'https://updates.example.invalid/appcast.xml')
  assert.equal(typeof plist.SUPublicEDKey, 'string')
  assert.equal(plist.SUEnableAutomaticChecks, false)

  for (const key of fixture.resolveHookPlistKeys ?? []) {
    assert.equal(plist[key], true)
  }

  if (fixture.afterPackMarker) {
    assert.equal(
      await readFile(join(resources, fixture.afterPackMarker), 'utf8'),
      'existing afterPack ran\n',
    )
  }

  if (shouldSignFixtures) {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fixture.app])
    const signature = run('/usr/bin/codesign', ['--display', '--verbose=2', fixture.app])
    assert.match(
      `${signature.stdout}\n${signature.stderr}`,
      /(?:^|\n)Signature=adhoc(?:\n|$)/,
      `${fixture.name} was not signed ad hoc by its packager`,
    )

    run(process.execPath, [
      resolve(projectDirectory, 'dist/cli.js'),
      'doctor',
      '--app',
      fixture.app,
    ])
  } else {
    const signatureVerification = spawnSync(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', fixture.app],
      { encoding: 'utf8' },
    )
    assert.equal(signatureVerification.error, undefined)
    assert.notEqual(
      signatureVerification.status,
      0,
      `${fixture.name} was signed for an untrusted pull request`,
    )
  }

  const resultPath = join(resultDirectory, `${basename(fixture.app)}.json`)
  const executable = join(contents, 'MacOS', fixture.executable)
  const smoke = run(executable, [], {
    env: {
      ...process.env,
      ELECTRON_SPARKLE_SMOKE_RESULT: resultPath,
    },
    timeout: 30_000,
  })
  assert.equal(smoke.status, 0, `${fixture.name} smoke launch failed`)

  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.equal(result.state.started, true)
  assert.equal(result.state.automaticallyChecksForUpdates, false)
  assert.ok(result.stateEvents >= 1)
}

async function assertFrameworksContainCodeOnly(
  frameworks: string,
  fixtureName: string,
): Promise<void> {
  const directorySuffixes = ['.app', '.appex', '.bundle', '.framework', '.plugin', '.xpc']
  const fileSuffixes = ['.dylib', '.node']

  for (const entry of await readdir(frameworks, { withFileTypes: true })) {
    const isAllowedDirectory =
      entry.isDirectory() && directorySuffixes.some((suffix) => entry.name.endsWith(suffix))
    const isAllowedFile =
      entry.isFile() && fileSuffixes.some((suffix) => entry.name.endsWith(suffix))

    assert.ok(
      isAllowedDirectory || isAllowedFile,
      `${fixtureName} contains a non-code entry in Contents/Frameworks: ${entry.name}`,
    )
  }
}

async function readPackageVersion(path: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    typeof value.version !== 'string'
  ) {
    throw new Error(`Package manifest is missing a version: ${path}`)
  }
  return value.version
}

type RunOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding' | 'maxBuffer'>

function run(
  executable: string,
  arguments_: string[],
  options: RunOptions = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(executable, arguments_, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${executable} ${arguments_.join(' ')} failed (${result.status ?? result.signal}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      { cause: result.error },
    )
  }
  return result
}
