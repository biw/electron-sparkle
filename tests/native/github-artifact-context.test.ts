import assert from 'node:assert/strict'

import { test } from 'vite-plus/test'

import {
  githubArtifactContext,
  tokenFromAuthorizationHeader,
} from '../../scripts/github-artifact-context.ts'

test('builds a cross-job artifact context from GitHub Actions metadata', () => {
  assert.deepEqual(
    githubArtifactContext({
      GITHUB_REPOSITORY: 'biw/electron-sparkle',
      GITHUB_RUN_ID: '32911463651',
      GITHUB_TOKEN: 'explicit-token',
    }),
    {
      repositoryName: 'electron-sparkle',
      repositoryOwner: 'biw',
      token: 'explicit-token',
      workflowRunId: 32_911_463_651,
    },
  )
})

test('falls back to the short-lived credential persisted by actions/checkout', () => {
  const header = `AUTHORIZATION: basic ${Buffer.from('x-access-token:checkout-token').toString('base64')}`
  assert.equal(tokenFromAuthorizationHeader(header), 'checkout-token')
  assert.equal(
    githubArtifactContext(
      {
        GITHUB_REPOSITORY: 'biw/electron-sparkle',
        GITHUB_RUN_ID: '42',
      },
      () => header,
    ).token,
    'checkout-token',
  )
})

test('rejects invalid GitHub Actions artifact metadata', () => {
  assert.throws(
    () => githubArtifactContext({ GITHUB_REPOSITORY: 'electron-sparkle', GITHUB_RUN_ID: '42' }),
    /GITHUB_REPOSITORY/,
  )
  assert.throws(
    () =>
      githubArtifactContext({
        GITHUB_REPOSITORY: 'biw/electron-sparkle',
        GITHUB_RUN_ID: 'not-a-run',
      }),
    /GITHUB_RUN_ID/,
  )
  assert.throws(() => tokenFromAuthorizationHeader('Bearer token'), /Basic authorization header/)
})
