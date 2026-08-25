import { execFileSync } from 'node:child_process'

export interface GitHubArtifactContext {
  repositoryName: string
  repositoryOwner: string
  token: string
  workflowRunId: number
}

type Environment = Readonly<Record<string, string | undefined>>

export function githubArtifactContext(
  environment: Environment = process.env,
  readAuthorizationHeader: () => string = readCheckoutAuthorizationHeader,
): GitHubArtifactContext {
  const repository = environment.GITHUB_REPOSITORY
  const [repositoryOwner, repositoryName, ...extraParts] = repository?.split('/') ?? []
  if (!repositoryOwner || !repositoryName || extraParts.length > 0) {
    throw new Error('GITHUB_REPOSITORY must identify one owner and repository.')
  }

  const runId = environment.GITHUB_RUN_ID
  if (!runId || !/^\d+$/.test(runId)) {
    throw new Error('GITHUB_RUN_ID must be a positive integer.')
  }
  const workflowRunId = Number(runId)
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
    throw new Error('GITHUB_RUN_ID must be a positive integer.')
  }

  const token =
    environment.GITHUB_TOKEN ??
    environment.GH_TOKEN ??
    tokenFromAuthorizationHeader(readAuthorizationHeader())

  return { repositoryName, repositoryOwner, token, workflowRunId }
}

export function tokenFromAuthorizationHeader(header: string): string {
  const encodedCredentials = /^authorization:\s*basic\s+([^\s]+)$/i.exec(header.trim())?.[1]
  if (!encodedCredentials) {
    throw new Error('GitHub checkout did not configure a Basic authorization header.')
  }

  const credentials = Buffer.from(encodedCredentials, 'base64').toString('utf8')
  const separator = credentials.indexOf(':')
  const token = separator >= 0 ? credentials.slice(separator + 1) : ''
  if (!token) {
    throw new Error('GitHub checkout configured an invalid authorization header.')
  }
  return token
}

function readCheckoutAuthorizationHeader(): string {
  try {
    return execFileSync(
      'git',
      ['config', '--local', '--get', 'http.https://github.com/.extraheader'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    throw new Error(
      'No GitHub token is available. Keep checkout credentials enabled or set GITHUB_TOKEN.',
    )
  }
}
