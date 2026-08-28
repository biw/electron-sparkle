# electron-sparkle

[![CI](https://badgen.net/github/checks/biw/electron-sparkle)](https://github.com/biw/electron-sparkle/actions)
[![npm version](https://badgen.net/npm/v/electron-sparkle)](https://www.npmjs.com/package/electron-sparkle)
[![npm downloads](https://badgen.net/npm/dt/electron-sparkle)](https://www.npmjs.com/package/electron-sparkle)

[Sparkle](https://sparkle-project.org/) updates for Electron apps on macOS, with first-class support for [Electron Builder](https://www.electron.build/) and [Electron Forge](https://www.electronforge.io/).

## Install

```sh
pnpm add electron-sparkle
```

### Electron Builder

```ts
// electron-builder.config.ts
import { electronSparkle } from 'electron-sparkle/electron-builder'

export default {
  // ...
  mac: {
    target: ['dmg', 'zip'],
    hardenedRuntime: true,
    extendInfo: {
      SUFeedURL: 'https://updates.example.com/appcast.xml',
      SUPublicEDKey: 'YOUR_SPARKLE_ED25519_PUBLIC_KEY',
    },
  },
  afterPack: electronSparkle,
  // can also be composed with other afterPack functions
  // afterPack: async (context) => {
  //   await existingAfterPack(context)
  //   await electronSparkle(context)
  // }
}
```

When Sparkle is the only hook, Builder can load the package directly without an import:

```ts
afterPack: 'electron-sparkle/electron-builder'
```

### Electron Forge

```ts
// forge.config.ts
import type { ForgeConfig } from '@electron-forge/shared-types'
import { ElectronSparkle } from 'electron-sparkle/electron-forge'

const config: ForgeConfig = {
  // ...
  plugins: [
    new ElectronSparkle({
      SUFeedURL: 'https://updates.example.com/appcast.xml',
      SUPublicEDKey: 'YOUR_SPARKLE_ED25519_PUBLIC_KEY',
    }),
  ],
}

export default config
```

### Options

Both integrations use Sparkle's Info.plist keys.

| Option                     | Type            | Description                        |
| -------------------------- | --------------- | ---------------------------------- |
| `SUFeedURL`                | URL `string`    | Default appcast URL                |
| `SUPublicEDKey`            | Base64 `string` | Ed25519 verification key           |
| `SUEnableAutomaticChecks`  | `boolean`       | Check for updates automatically    |
| `SUAutomaticallyUpdate`    | `boolean`       | Download and install automatically |
| `SUAllowsAutomaticUpdates` | `boolean`       | Permit automatic installation      |
| `SUScheduledCheckInterval` | `number`        | Check interval; at least 3600s     |
| `SUShowReleaseNotes`       | `boolean`       | Show update release notes          |

Omitted optional values preserve Sparkle's defaults.

## Start the updater

Register listeners in the main process, wait for Electron to become ready, and then call `start()`:

```ts
import { app } from 'electron'
import { updater } from 'electron-sparkle'

updater.on('update-available', ({ update }) => {
  console.log(`Sparkle found ${update.displayVersion}`)
})

updater.on('error', ({ error }) => {
  console.error('Sparkle update error', error)
})

await app.whenReady()
await updater.start() // idempotent & safe to call concurrently

const currentState = updater.getState()
console.log(currentState)

// Connect this to a “Check for Updates…” menu item.
updater.checkForUpdates()
```

Events are `state-changed`, `update-available`, `update-not-available`, `update-downloaded`, `before-install`, `before-relaunch`, `cycle-complete`, and `error`. Update-check, state, and automatic-setting methods throw `UpdaterNotStartedError` until `start()` resolves. `setHTTPHeaders()` and `setBeforeRelaunchHandler()` may be called before startup. Environment and native-loading failures use `SparkleUpdaterError` with a stable error code.

Update objects include versions and, when supplied by the appcast: title, file/info/release-note URLs, content length, and publication date. The `update-not-available` event also reports Sparkle's optional `userInitiated` flag.

### Authenticate update requests

Set custom HTTP headers before `start()` when an appcast requires authentication. Sparkle applies these headers to appcast, release-note, and update-archive requests:

```ts
import { app } from 'electron'
import { updater, type SparkleHTTPHeaders } from 'electron-sparkle'

const getUpdateHeaders = async (): Promise<SparkleHTTPHeaders> => ({
  Authorization: await getUpdateAuthorizationHeader(),
})

updater.setHTTPHeaders(await getUpdateHeaders())

await app.whenReady()
await updater.start()
```

`setHTTPHeaders()` replaces the full custom-header dictionary. Pass `{}` to clear it. The package copies input objects and never includes header values in updater events or validation errors. Applications should not log these values.

Sparkle normally owns its background-check schedule. Applications that use short-lived credentials should disable that schedule, refresh their credentials, and run background checks from an application-owned timer:

```ts
updater.setAutomaticallyChecksForUpdates(false)

const checkForUpdatesInBackground = async (): Promise<void> => {
  updater.setHTTPHeaders(await getUpdateHeaders())
  updater.checkForUpdatesInBackground()
}
```

### Prepare for relaunch

Register one handler when the application must finish asynchronous work before Sparkle relaunches it:

```ts
updater.setBeforeRelaunchHandler(async (update) => {
  await prepareApplicationForRelaunch(update)
})
```

Sparkle remains postponed until the handler settles. A thrown or rejected handler emits an `error` event with code `BEFORE_RELAUNCH_HANDLER_FAILED`, then allows the relaunch to continue. The package does not impose a timeout. Applications that need a deadline must implement it inside the handler. Pass `null` to disable postponement for future relaunch requests.

## How do cross-platform updates work?

`electron-sparkle` is the macOS updater, not a cross-platform abstraction. Keep its Builder hook or Forge plugin in a multi-platform packaging configuration: both integrations skip Windows and Linux builds. At runtime, select exactly one updater for the current platform and never start Sparkle outside macOS.

For an Electron Builder app, Sparkle can handle macOS while [`electron-updater`](https://www.electron.build/docs/features/auto-update/) handles Windows and Linux:

```ts
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { updater as sparkleUpdater } from 'electron-sparkle'

const { autoUpdater } = electronUpdater

export async function startUpdates(): Promise<void> {
  await app.whenReady()

  if (!app.isPackaged) return

  if (process.platform === 'darwin') {
    await sparkleUpdater.start()
    return
  }

  if (process.platform === 'win32' || process.platform === 'linux') {
    await autoUpdater.checkForUpdatesAndNotify()
  }
}

// Call only after startUpdates() has completed.
export function checkForUpdates(): void {
  if (!app.isPackaged) return

  if (process.platform === 'darwin') {
    sparkleUpdater.checkForUpdates()
    return
  }

  if (process.platform === 'win32' || process.platform === 'linux') {
    void autoUpdater.checkForUpdates()
  }
}
```

Each updater consumes its own release metadata:

| Platform | Update engine      | Published files                                      |
| -------- | ------------------ | ---------------------------------------------------- |
| macOS    | `electron-sparkle` | Sparkle appcast, signed archive, and optional deltas |
| Windows  | `electron-updater` | Builder update metadata and a signed NSIS installer  |
| Linux    | `electron-updater` | Builder update metadata and a supported package      |

The files may share one hostname and release version, but a Sparkle appcast cannot replace Builder's `latest*.yml` metadata or vice versa.

Electron Forge users can pair Sparkle on macOS with Forge's [`update-electron-app` workflow](https://www.electronforge.io/advanced/auto-update/) on Windows. Electron's built-in updater does not support Linux, so Linux releases normally use the distribution's package manager or a separately configured updater. If first-class self-updates on all three platforms are required, Electron Builder provides the more integrated release pipeline.

## How do I migrate to electron-sparkle?

### From `electron-updater` or `update-electron-app`

Squirrel and Builder metadata are not Sparkle appcasts, so changing the runtime import is not enough. Existing installations must first receive a Sparkle-enabled bridge release through the updater they already know about:

1. Generate and back up a Sparkle key. Add its public key and a staging `SUFeedURL` to the app; never put the private key in the bundle.
2. Add the Builder hook or Forge plugin, replace the macOS runtime updater with `electron-sparkle`, and leave the Windows/Linux updater unchanged.
3. Exercise a complete update from an older signed build to this bridge build against staging.
4. Publish the bridge build through the existing macOS update feed. Do not run Sparkle and the previous macOS updater in the same launch.
5. Publish the next higher `CFBundleVersion` to the Sparkle appcast and test the bridge build updating through Sparkle.
6. Keep the legacy feed able to deliver at least one Sparkle-enabled build for as long as older installations still need a migration path.

New downloads may start with the bridge build or any later build. Installed copies cannot discover a new feed format until an updater they already contain delivers code configured to use it.

### From another Sparkle integration

Keep the existing appcast, `SUPublicEDKey`, and private signing key unless you deliberately need to rotate them. Add electron-sparkle's packaging integration, replace the previous bridge calls with its runtime API, and publish the transition through the existing appcast. Test from the oldest app version you still support.

Do not generate a new key merely because the Node bridge changed. If the old application uses DSA signatures or an obsolete Sparkle release, complete Sparkle's [EdDSA migration](https://sparkle-project.org/documentation/eddsa-migration/) before removing the old key or signatures.

## What kind of update server do I need?

For most applications, no update-server application, API, or database is necessary. Use public-read, tightly controlled-write static HTTPS hosting such as object storage behind a CDN or a conventional web server. Sparkle fetches an XML appcast, then downloads the archive and optional delta referenced by that feed.

A cross-platform release host might look like this:

```text
updates/
  mac/stable/appcast.xml
  mac/stable/My-App-2.4.0.zip
  mac/stable/My-App-2.3.0-to-2.4.0.delta
  windows/stable/latest.yml
  windows/stable/My-App-Setup-2.4.0.exe
  linux/stable/latest-linux.yml
  linux/stable/My-App-2.4.0.AppImage
```

For the Sparkle portion:

- Serve the appcast and every referenced URL over HTTPS. macOS App Transport Security blocks ordinary HTTP update URLs.
- Upload archives, deltas, and release notes before publishing the appcast that references them. Treat versioned artifacts as immutable.
- Give archives long immutable cache lifetimes, but keep the appcast cache short or invalidate it when publishing.
- Keep staging and production feeds separate, and retain every artifact still referenced by either feed.
- Protect server and CI write credentials. EdDSA verifies update archives, but it is not a substitute for securing publication access.
- CORS headers are unnecessary because Sparkle fetches updates from the native main process, not a browser renderer.

Private appcasts may require request credentials configured through `setHTTPHeaders()`. The configured headers also apply when Sparkle downloads release notes and update archives. A dynamic endpoint remains optional when the appcast must be generated per request. See Sparkle's [publishing guide](https://sparkle-project.org/documentation/publishing/) for the appcast format, channels, phased rollouts, and signing behavior.

## Publish an update

The CLI runs the official tools from the pinned Sparkle distribution with inherited stdio. Arguments and exit status are passed through; electron-sparkle does not read or store private-key material.

Generate a Sparkle signing key once and put only its public key in the packaging configuration:

```sh
pnpm exec electron-sparkle generate-keys
```

For each release:

1. Build an app with a higher `CFBundleVersion` (build version). Sign and notarize it with Developer ID, or have the packager sign it ad hoc as described above.
2. Place its update archive in a releases directory.
3. Generate or update the appcast with Sparkle's official tool:

   ```sh
   pnpm exec electron-sparkle generate-appcast path/to/releases
   ```

4. Publish the appcast and its referenced archives over HTTPS.

`generate-appcast` signs eligible archives as it builds the feed. For a custom feed workflow, sign an individual archive with:

```sh
pnpm exec electron-sparkle sign-update path/to/My-App.zip
```

Add the command's `sparkle:edSignature` value to that archive's appcast `<enclosure>`. Keep the private key out of the application and CI logs.

## Ad-hoc distributions

Sparkle can update an app without a paid Apple Developer ID certificate. Two independent signatures make this work:

- The macOS ad-hoc code signature makes the completed app bundle structurally valid. It does not identify or establish trust in the developer.
- Sparkle's Ed25519 signature authenticates each update archive against the `SUPublicEDKey` embedded in the app. This signature is required for an ad-hoc distribution.

Configure ad-hoc signing through the packager so it signs every nested executable after electron-sparkle has installed its native assets. With Electron Builder, add these values to the existing `mac` configuration:

```ts
mac: {
  // ...the Sparkle Info.plist values from above
  identity: '-',
  hardenedRuntime: false,
}
```

With Electron Forge, add the corresponding native `@electron/osx-sign` configuration:

```ts
packagerConfig: {
  osxSign: {
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      hardenedRuntime: false,
      timestamp: 'none',
    }),
  },
},
```

`identityValidation: false` only tells Forge that `-` is codesign's ad-hoc identity rather than a certificate it should find in Keychain. It does not disable Sparkle's Ed25519 validation.

Do not repair the finished app with `codesign --deep --sign -`. Let Builder or Forge own the inside-out signing order; a blanket recursive signing pass can overwrite component-specific entitlements and is incompatible with the sandbox/XPC path. Also do not modify the app, `Sparkle.framework`, or `electron_sparkle.node` after the packager signs them.

An ad-hoc app cannot be notarized and will not pass a normal Gatekeeper assessment. Users generally need to right-click the first downloaded build and choose **Open**, and managed Macs may reject it entirely. Developer ID signing and notarization remain the recommended mode for a general consumer release; ad-hoc signing is useful for open-source projects, internal distribution, nightly builds, and teams that deliberately accept the first-launch tradeoff.

The initial download still needs a trustworthy distribution channel, and the Sparkle private key becomes the update trust root. Keep that key offline or in protected CI secrets, retain a secure backup, and test an update between two ad-hoc builds before publishing. These examples cover the current non-sandboxed distribution mode; App Sandbox requires separate Sparkle XPC entitlements and signing validation.

## Validate and test

Check the installed package artifacts or a packaged application:

```sh
pnpm exec electron-sparkle doctor
pnpm exec electron-sparkle doctor --app 'release/mac/My App.app'

codesign --verify --deep --strict 'release/mac/My App.app'
spctl --assess --type execute --verbose 'release/mac/My App.app'
```

Without `--app`, `doctor` verifies the installed universal framework, the addon for the current architecture, its Sparkle linkage, and its rpath. With `--app`, it checks the staged framework and addon, required plist values, deep code signature, and whether the signing identity is ad hoc or certificate-backed. It does not contact the feed or install an update.

`codesign --verify` must pass in either signing mode. `spctl --assess` should pass for a properly Developer ID-signed and notarized release; rejection is expected for an ad-hoc build because it has no Apple-trusted developer identity.

The packaging integrations install native assets before the packager signs the app. Use Builder or Forge for Developer ID or ad-hoc signing, notarize Developer ID releases, and do not modify `Sparkle.framework` or `electron_sparkle.node` after signing.

A complete end-to-end test still requires two real app versions:

1. Point an older signed build at a staging appcast.
2. Publish a newer build signed in the same distribution mode to that feed, notarizing it when using Developer ID.
3. Launch the older build, trigger `updater.checkForUpdates()`—for example, from your own **Check for Updates…** menu item—and install the update.
4. Confirm that the app relaunches as the newer version and that subsequent checks find no update.
5. For a private feed, verify that the appcast and archive reject missing credentials, then repeat with configured headers.
6. When using a relaunch handler, verify that its durable work finishes before the newer process starts.

Do this before every production rollout. It covers feed hosting, version comparison, archive signatures, code signing, installation, and relaunch—areas that package-level tests cannot fully simulate.

## License

MIT
