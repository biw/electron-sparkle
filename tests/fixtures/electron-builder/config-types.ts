import type { Configuration } from 'electron-builder'
import { electronSparkle } from 'electron-sparkle/electron-builder'

const composedConfig = {
  afterPack: async (context) => {
    await Promise.resolve(context.appOutDir)
    await electronSparkle(context)
  },
} satisfies Configuration

const moduleHookConfig = {
  afterPack: 'electron-sparkle/electron-builder',
} satisfies Configuration

void composedConfig.afterPack
void moduleHookConfig.afterPack
