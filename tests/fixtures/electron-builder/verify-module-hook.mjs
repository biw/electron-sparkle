import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resolveFunction } = require('app-builder-lib/out/util/resolve.js')
const { afterPack } = require('electron-sparkle/electron-builder')

const resolvedHook = await resolveFunction(
  'afterPack',
  'electron-sparkle/electron-builder',
  'afterPack',
  import.meta.dirname,
)

assert.strictEqual(resolvedHook, afterPack)
process.stdout.write('electron-builder module hook resolved\n')
