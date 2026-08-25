import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DefaultArtifactClient } from '@actions/artifact'

import { githubArtifactContext } from './github-artifact-context.ts'

interface PackageManifest {
  name: string
  version: string
}

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const packageManifest = await readManifest(join(packageDirectory, 'package.json'))
const expectedTarball = npmTarballName(packageManifest)
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'electron-sparkle-publish-'))

try {
  const tarball = await acquireTarball(temporaryDirectory, expectedTarball)
  execFileSync(
    process.execPath,
    [join(packageDirectory, 'scripts', 'verify-package-tarballs.ts'), dirname(tarball)],
    {
      cwd: packageDirectory,
      stdio: 'inherit',
    },
  )

  const extractedDirectory = join(temporaryDirectory, 'unpacked')
  await mkdir(extractedDirectory)
  execFileSync('/usr/bin/tar', ['-xzf', tarball, '-C', extractedDirectory], {
    stdio: 'inherit',
  })

  const stagedPackage = join(extractedDirectory, 'package')
  const stagedManifest = await readManifest(join(stagedPackage, 'package.json'))
  if (
    stagedManifest.name !== packageManifest.name ||
    stagedManifest.version !== packageManifest.version
  ) {
    throw new Error(
      `CI artifact contains ${stagedManifest.name}@${stagedManifest.version}; expected ${packageManifest.name}@${packageManifest.version}.`,
    )
  }

  const distributionDirectory = join(packageDirectory, 'dist')
  await rm(distributionDirectory, { force: true, recursive: true })
  await cp(join(stagedPackage, 'dist'), distributionDirectory, { recursive: true })
  process.stdout.write(`Staged ${expectedTarball} for trusted publishing\n`)
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

async function acquireTarball(directory: string, expectedFilename: string): Promise<string> {
  const configuredTarball = process.env.ELECTRON_SPARKLE_PACKAGE_TARBALL
  if (configuredTarball) {
    const tarball = resolve(packageDirectory, configuredTarball)
    const candidates = await findFiles(dirname(tarball), expectedFilename)
    if (!candidates.includes(tarball)) {
      throw new Error(`Configured package tarball does not exist: ${tarball}`)
    }
    return tarball
  }

  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error(
      'No CI package is available. Set ELECTRON_SPARKLE_PACKAGE_TARBALL to a verified local tarball.',
    )
  }

  const artifactClient = new DefaultArtifactClient()
  const findBy = githubArtifactContext()
  const { artifact } = await artifactClient.getArtifact('npm-packages', { findBy })
  const { downloadPath } = await artifactClient.downloadArtifact(artifact.id, {
    findBy,
    path: directory,
  })
  const candidates = await findFiles(downloadPath ?? directory, expectedFilename)
  const [tarball] = candidates
  if (!tarball || candidates.length !== 1) {
    throw new Error(
      `Expected one ${expectedFilename} in the npm-packages artifact; found ${candidates.length}.`,
    )
  }
  return tarball
}

async function findFiles(directory: string, filename: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const matches = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return findFiles(path, filename)
      return entry.isFile() && entry.name === filename ? [path] : []
    }),
  )
  return matches.flat()
}

async function readManifest(path: string): Promise<PackageManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Partial<PackageManifest>
  if (typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error(`Package manifest is missing a name or version: ${path}`)
  }
  return { name: value.name, version: value.version }
}

function npmTarballName(manifest: PackageManifest): string {
  const name = manifest.name.replace(/^@/, '').replaceAll('/', '-')
  return `${name}-${manifest.version}.tgz`
}
