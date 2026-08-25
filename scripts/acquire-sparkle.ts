import { createHash, type BinaryLike } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))

export const sparkleArchive = {
  file: join(packageDirectory, '.cache', 'Sparkle-2.9.6.zip'),
  sha256: '8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606',
  url: 'https://github.com/sparkle-project/Sparkle/releases/download/2.9.6/Sparkle-for-Swift-Package-Manager.zip',
  version: '2.9.6',
}

export const sparkleLicense = {
  file: join(packageDirectory, '.cache', 'Sparkle-LICENSE.txt'),
  outputFilename: 'licenses/Sparkle-LICENSE.txt',
  sha256: '389a4e4e9a32f059775b13a06e25a591445ba229d2838d26dd3e7c0c45127cfe',
}

export function sha256(contents: BinaryLike): string {
  return createHash('sha256').update(contents).digest('hex')
}

export async function hasExpectedChecksum(
  path: string,
  expectedChecksum: string,
): Promise<boolean> {
  try {
    return sha256(await readFile(path)) === expectedChecksum
  } catch {
    return false
  }
}

export async function ensureSparkleArchive() {
  if (await hasExpectedChecksum(sparkleArchive.file, sparkleArchive.sha256)) {
    return sparkleArchive.file
  }

  await mkdir(dirname(sparkleArchive.file), { recursive: true })
  const response = await fetch(sparkleArchive.url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(
      `Could not download Sparkle ${sparkleArchive.version}: ${response.status} ${response.statusText}`,
    )
  }

  const contents = Buffer.from(await response.arrayBuffer())
  const actualChecksum = sha256(contents)
  if (actualChecksum !== sparkleArchive.sha256) {
    throw new Error(
      `Sparkle ${sparkleArchive.version} checksum mismatch: expected ${sparkleArchive.sha256}, received ${actualChecksum}`,
    )
  }

  const temporaryFile = join(
    dirname(sparkleArchive.file),
    `.Sparkle-${process.pid}-${Date.now()}.zip`,
  )
  try {
    await writeFile(temporaryFile, contents, { mode: 0o644 })
    await rename(temporaryFile, sparkleArchive.file)
  } finally {
    await rm(temporaryFile, { force: true })
  }

  return sparkleArchive.file
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureSparkleArchive()
  process.stdout.write(`${sparkleArchive.file}\n`)
}
