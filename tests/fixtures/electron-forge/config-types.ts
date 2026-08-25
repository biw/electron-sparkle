import type { ForgeConfig } from '@electron-forge/shared-types'
import { ElectronSparkle } from 'electron-sparkle/electron-forge'

const config = {
  plugins: [
    new ElectronSparkle({
      SUFeedURL: 'https://updates.example.invalid/appcast.xml',
      SUPublicEDKey: 'KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys=',
    }),
  ],
} satisfies ForgeConfig

void config.plugins
