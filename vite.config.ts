import { readFile } from 'node:fs/promises'

import swiftNodeNativeAssets from 'swift-node-unplugin/rolldown'
import { defineConfig } from 'vite-plus'

import { sparkleArchive, sparkleLicense } from './scripts/acquire-sparkle.ts'

export default defineConfig({
  fmt: {
    semi: false,
    singleQuote: true,
    trailingComma: 'all',
  },
  lint: {
    categories: {
      correctness: 'error',
      perf: 'warn',
      suspicious: 'warn',
    },
    ignorePatterns: ['dist/**', 'dist_swift-node/**', 'tests/fixtures/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      // Runtime boundary validation and fault-injection tests make these assertions intentional.
      'typescript/no-unnecessary-type-assertion': 'off',
      'typescript/no-unnecessary-type-parameters': 'off',
      'typescript/no-unsafe-type-assertion': 'off',
    },
  },
  pack: {
    clean: true,
    dts: true,
    entry: ['src/index.ts', 'src/electron-builder.ts', 'src/electron-forge.ts', 'src/cli.ts'],
    fixedExtension: false,
    format: ['esm', 'cjs'],
    platform: 'node',
    plugins:
      process.platform === 'darwin'
        ? [
            {
              name: 'sparkle-release-archive',
              async buildStart() {
                const [archive, license] = await Promise.all([
                  readFile(sparkleArchive.file),
                  readFile(sparkleLicense.file),
                ])
                this.emitFile({
                  type: 'asset',
                  fileName: `Sparkle-${sparkleArchive.version}.zip`,
                  source: archive,
                })
                this.emitFile({
                  type: 'asset',
                  fileName: sparkleLicense.outputFilename,
                  source: license,
                })
              },
            },
            swiftNodeNativeAssets({ cwd: import.meta.dirname }),
          ]
        : [],
    sourcemap: true,
    target: 'node24',
    tsconfig: './tsconfig.json',
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
