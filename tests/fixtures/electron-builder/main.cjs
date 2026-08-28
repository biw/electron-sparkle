const { writeFileSync } = require('node:fs')
const { app } = require('electron')
const { updater } = require('electron-sparkle')

async function smokeTest() {
  await app.whenReady()

  let stateEvents = 0
  updater.on('state-changed', () => {
    stateEvents += 1
  })
  updater.setHTTPHeaders({ 'X-Example-Authorization': 'placeholder' })
  updater.setBeforeRelaunchHandler(async () => Promise.resolve())
  await updater.start()
  updater.setHTTPHeaders({})
  updater.setBeforeRelaunchHandler(null)

  const state = updater.getState()
  if (!state.started) {
    throw new Error('Sparkle updater did not start')
  }

  const resultPath = process.env.ELECTRON_SPARKLE_SMOKE_RESULT
  if (!resultPath) {
    throw new Error('ELECTRON_SPARKLE_SMOKE_RESULT is required')
  }

  writeFileSync(resultPath, JSON.stringify({ state, stateEvents }))
  app.quit()
}

void smokeTest().catch((error) => {
  console.error(error)
  app.exit(1)
})
