import { execFileSync } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureSparkleArchive,
  hasExpectedChecksum,
  sparkleArchive,
  sparkleLicense,
} from './acquire-sparkle.ts'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const cacheDirectory = join(packageDirectory, '.cache')
const frameworkDirectory = join(cacheDirectory, 'Sparkle.framework')
const toolsDirectory = join(cacheDirectory, 'bin')
const markerFile = join(cacheDirectory, 'sparkle-archive-sha256')

function extractArchive(archive: string, destination: string): void {
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, destination], { stdio: 'inherit' })
}

function copyFramework(source: string, destination: string): void {
  execFileSync('/usr/bin/ditto', [source, destination], { stdio: 'inherit' })
}

async function isPrepared() {
  try {
    const [marker, framework, tools, licenseIsExpected] = await Promise.all([
      readFile(markerFile, 'utf8'),
      lstat(frameworkDirectory),
      lstat(toolsDirectory),
      hasExpectedChecksum(sparkleLicense.file, sparkleLicense.sha256),
    ])
    return (
      marker.trim() === sparkleArchive.sha256 &&
      framework.isDirectory() &&
      !framework.isSymbolicLink() &&
      tools.isDirectory() &&
      licenseIsExpected
    )
  } catch {
    return false
  }
}

export async function prepareSparkleFramework() {
  const archive = await ensureSparkleArchive()
  if (!(await isPrepared())) {
    const temporaryDirectory = join(cacheDirectory, `.sparkle-extract-${process.pid}-${Date.now()}`)
    await mkdir(temporaryDirectory, { recursive: true })
    try {
      extractArchive(archive, temporaryDirectory)
      const extractedFramework = join(
        temporaryDirectory,
        'Sparkle.xcframework',
        'macos-arm64_x86_64',
        'Sparkle.framework',
      )
      const extractedLicense = join(temporaryDirectory, 'LICENSE')
      const extractedTools = join(temporaryDirectory, 'bin')
      const framework = await lstat(extractedFramework)
      if (!framework.isDirectory() || framework.isSymbolicLink()) {
        throw new Error('Sparkle archive did not contain the expected macOS universal framework.')
      }
      if (!(await hasExpectedChecksum(extractedLicense, sparkleLicense.sha256))) {
        throw new Error('Sparkle archive did not contain the expected upstream license.')
      }

      await rm(frameworkDirectory, { force: true, recursive: true })
      await rm(toolsDirectory, { force: true, recursive: true })
      copyFramework(extractedFramework, frameworkDirectory)
      copyFramework(extractedTools, toolsDirectory)
      await copyFile(extractedLicense, sparkleLicense.file)
      await writeFile(markerFile, `${sparkleArchive.sha256}\n`)
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
  }

  return {
    archive,
    frameworkDirectory,
    licenseFile: sparkleLicense.file,
    toolsDirectory,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.platform === 'darwin') {
    const distribution = await prepareSparkleFramework()
    process.stdout.write(`${distribution.archive}\n`)
  } else {
    process.stdout.write('Sparkle preparation skipped outside macOS\n')
  }
}
