import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const DEFAULT_USAGE_BASE_URL = 'https://chatgpt.com/backend-api'
const OPENAI_ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${OPENAI_ISSUER}/oauth/authorize`
const TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEFAULT_REDIRECT_PORTS = [1455, 1456, 1457, 1458, 1459]
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const SCOPES = ['openid', 'profile', 'email', 'offline_access']

class UsageApiError extends Error {
  constructor(status, rawText) {
    const parsed = parseApiError(rawText)
    const message = parsed.message ? `: ${parsed.message}` : ''
    const code = parsed.code ? ` (${parsed.code})` : ''
    super(`Usage API returned ${status}${message}${code}`)
    this.name = 'UsageApiError'
    this.status = status
    this.code = parsed.code
    this.rawText = rawText
  }
}

function getRedirectUri(port) {
  return `http://localhost:${port}/auth/callback`
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string' || !token) {
    return null
  }

  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return null
    }

    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function getAccountIdFromClaims(claims) {
  return claims?.['https://api.openai.com/auth']?.chatgpt_account_id
}

function getExpiryFromClaims(claims) {
  return typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined
}

function parseApiError(rawText) {
  const trimmed = typeof rawText === 'string' ? rawText.trim() : ''
  if (!trimmed) {
    return {}
  }

  try {
    const payload = JSON.parse(trimmed)
    return {
      code:
        (typeof payload?.detail?.code === 'string' && payload.detail.code) ||
        (typeof payload?.error?.code === 'string' && payload.error.code) ||
        undefined,
      message:
        (typeof payload?.detail?.message === 'string' && payload.detail.message) ||
        (typeof payload?.detail === 'string' && payload.detail) ||
        (typeof payload?.error?.message === 'string' && payload.error.message) ||
        (typeof payload?.message === 'string' && payload.message) ||
        undefined
    }
  } catch {
    return { message: trimResponseText(trimmed) }
  }
}

function isExpiredTokenError(error) {
  return error instanceof UsageApiError && error.status === 401 && error.code === 'token_expired'
}

function generatePkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function createAuthorizationFlow(port) {
  const pkce = generatePkce()
  const state = randomBytes(16).toString('hex')
  const redirectUri = getRedirectUri(port)
  const authUrl = new URL(AUTHORIZE_URL)

  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPES.join(' '))
  authUrl.searchParams.set('code_challenge', pkce.challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('audience', 'https://api.openai.com/v1')
  authUrl.searchParams.set('id_token_add_organizations', 'true')
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
  authUrl.searchParams.set('originator', 'codex_cli_rs')

  return {
    pkce,
    state,
    redirectUri,
    url: authUrl.toString(),
    port
  }
}

async function openUrlInBrowser(url) {
  const candidates = process.platform === 'darwin'
    ? [['open', [url]]]
    : process.platform === 'win32'
      ? [['cmd', ['/c', 'start', '', url]]]
      : [['xdg-open', [url]]]

  for (const [command, args] of candidates) {
    const opened = await new Promise((resolve) => {
      let settled = false
      const child = spawn(command, args, {
        stdio: 'ignore',
        detached: true
      })
      child.once('spawn', () => {
        if (settled) {
          return
        }
        settled = true
        child.unref()
        resolve(true)
      })
      child.once('error', () => {
        if (settled) {
          return
        }
        settled = true
        resolve(false)
      })
    })

    if (opened) {
      return true
    }
  }

  return false
}

export function parseOAuthCallbackUrl(input, expectedState) {
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (!trimmed) {
    throw new Error('Empty callback URL.')
  }

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Invalid callback URL.')
  }

  if (parsed.pathname !== '/auth/callback') {
    throw new Error('Callback URL must point to /auth/callback.')
  }

  const code = parsed.searchParams.get('code')
  const returnedState = parsed.searchParams.get('state')

  if (!code) {
    throw new Error('Callback URL is missing code.')
  }

  if (!returnedState) {
    throw new Error('Callback URL is missing state.')
  }

  if (expectedState && returnedState !== expectedState) {
    throw new Error('Callback URL state mismatch.')
  }

  return { code, state: returnedState }
}

function tryListenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError)
      reject(error)
    }

    server.on('error', onError)
    server.listen(port, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function findAvailablePort(server, ports = DEFAULT_REDIRECT_PORTS) {
  for (const port of ports) {
    try {
      await tryListenOnPort(server, port)
      return port
    } catch (error) {
      if (error?.code === 'EADDRINUSE') {
        continue
      }
      throw error
    }
  }

  throw new Error(`All ports ${ports.join(', ')} are in use. Stop OpenCode/Codex auth helpers and retry.`)
}

function getUsageBaseUrl(env = process.env) {
  const raw = env.AI_SWITCH_USAGE_BASE_URL?.trim() || DEFAULT_USAGE_BASE_URL
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function trimResponseText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, 280) : ''
}

function hasUsageWindow(window) {
  return Boolean(
    window &&
    (typeof window.remaining === 'number' || typeof window.resetAt === 'number')
  )
}

function mapUsageWindow(window, now) {
  if (!window || typeof window !== 'object') {
    return undefined
  }

  const usedPercent = typeof window.used_percent === 'number' ? window.used_percent : undefined
  const resetAt =
    typeof window.reset_at === 'number'
      ? window.reset_at * 1000
      : typeof window.reset_after_seconds === 'number'
        ? now + window.reset_after_seconds * 1000
        : undefined

  if (usedPercent === undefined && resetAt === undefined) {
    return undefined
  }

  return {
    limit: 100,
    remaining: typeof usedPercent === 'number' ? Math.max(0, 100 - usedPercent) : undefined,
    resetAt,
    updatedAt: now
  }
}

function pickUsageRateLimitDetails(payload) {
  if (payload?.rate_limit && typeof payload.rate_limit === 'object') {
    return payload.rate_limit
  }

  const additional = Array.isArray(payload?.additional_rate_limits)
    ? payload.additional_rate_limits
    : []

  const preferred = additional.find((entry) => {
    const feature = entry?.metered_feature?.trim?.().toLowerCase?.()
    const limitName = entry?.limit_name?.trim?.().toLowerCase?.()
    return feature === 'codex' || limitName === 'codex'
  })

  if (preferred?.rate_limit && typeof preferred.rate_limit === 'object') {
    return preferred.rate_limit
  }

  const fallback = additional.find((entry) => entry?.rate_limit && typeof entry.rate_limit === 'object')
  return fallback?.rate_limit || null
}

export function parseUsageStatusPayload(payload, now = Date.now()) {
  const details = pickUsageRateLimitDetails(payload)
  const fiveHour = mapUsageWindow(details?.primary_window, now)
  const weekly = mapUsageWindow(details?.secondary_window, now)

  if (!hasUsageWindow(fiveHour) && !hasUsageWindow(weekly)) {
    throw new Error('Usage API response contained no usable rate limit windows.')
  }

  return {
    planType: typeof payload?.plan_type === 'string' ? payload.plan_type : undefined,
    fiveHour,
    weekly
  }
}

async function exchangeRefreshToken(normalized, env = process.env, fetchImpl = fetch) {
  if (!normalized?.refresh) {
    throw new Error('Saved account is missing a refresh token.')
  }

  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: normalized.refresh
    })
  })

  const rawText = await response.text().catch(() => '')
  if (!response.ok) {
    const parsed = parseApiError(rawText)
    const message = parsed.message ? `: ${parsed.message}` : ''
    const code = parsed.code ? ` (${parsed.code})` : ''
    throw new Error(`Refresh failed with ${response.status}${message}${code}`)
  }

  let payload
  try {
    payload = JSON.parse(rawText)
  } catch (error) {
    throw new Error(`Refresh returned invalid JSON: ${error}`)
  }

  if (typeof payload?.access_token !== 'string' || !payload.access_token) {
    throw new Error('Refresh response did not include an access token.')
  }

  const accessClaims = decodeJwtPayload(payload.access_token)
  const idClaims = typeof payload?.id_token === 'string' ? decodeJwtPayload(payload.id_token) : null
  const accountId =
    getAccountIdFromClaims(idClaims) ||
    getAccountIdFromClaims(accessClaims) ||
    normalized.accountId

  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('Could not determine accountId from refreshed token.')
  }

  return {
    access: payload.access_token,
    refresh:
      typeof payload?.refresh_token === 'string' && payload.refresh_token
        ? payload.refresh_token
        : normalized.refresh,
    accountId,
    expires:
      getExpiryFromClaims(accessClaims) ||
      getExpiryFromClaims(idClaims) ||
      Date.now() + (typeof payload?.expires_in === 'number' ? payload.expires_in : 0) * 1000,
    type: normalized.type || 'oauth'
  }
}

async function exchangeAuthorizationCode(flow, code, fetchImpl = fetch) {
  const tokenResponse = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: flow.pkce.verifier,
      redirect_uri: flow.redirectUri
    })
  })

  const rawText = await tokenResponse.text().catch(() => '')
  if (!tokenResponse.ok) {
    const parsed = parseApiError(rawText)
    throw new Error(
      `Token exchange failed with ${tokenResponse.status}${parsed.message ? `: ${parsed.message}` : ''}${parsed.code ? ` (${parsed.code})` : ''}`
    )
  }

  let payload
  try {
    payload = JSON.parse(rawText)
  } catch (error) {
    throw new Error(`Token exchange returned invalid JSON: ${error}`)
  }

  if (typeof payload?.refresh_token !== 'string' || !payload.refresh_token) {
    throw new Error('Token exchange did not return a refresh token.')
  }

  const accessClaims = decodeJwtPayload(payload.access_token)
  const idClaims = typeof payload?.id_token === 'string' ? decodeJwtPayload(payload.id_token) : null
  const accountId =
    getAccountIdFromClaims(idClaims) ||
    getAccountIdFromClaims(accessClaims)

  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('Could not determine accountId from OAuth tokens.')
  }

  return {
    access: payload.access_token,
    refresh: payload.refresh_token,
    accountId,
    expires:
      getExpiryFromClaims(accessClaims) ||
      getExpiryFromClaims(idClaims) ||
      Date.now() + (typeof payload?.expires_in === 'number' ? payload.expires_in : 0) * 1000,
    type: 'oauth'
  }
}

async function fetchUsageStatusWithAutoRefresh(normalized, onRefresh, env = process.env, fetchImpl = fetch) {
  try {
    return {
      refreshed: false,
      ...(await fetchUsageStatusForAccount(normalized, env, fetchImpl))
    }
  } catch (error) {
    if (!isExpiredTokenError(error)) {
      throw error
    }

    const refreshedAccount = await exchangeRefreshToken(normalized, env, fetchImpl)
    await onRefresh(refreshedAccount)

    return {
      refreshed: true,
      ...(await fetchUsageStatusForAccount(refreshedAccount, env, fetchImpl))
    }
  }
}

export async function fetchUsageStatusForAccount(normalized, env = process.env, fetchImpl = fetch) {
  const headers = {
    Authorization: `Bearer ${normalized.access}`,
    'User-Agent': 'codex_cli_rs/0.122.0 (linux)',
    originator: 'codex_cli_rs'
  }

  if (normalized.accountId) {
    headers['ChatGPT-Account-Id'] = normalized.accountId
  }

  const url = `${getUsageBaseUrl(env)}/codex/usage`
  const maxAttempts = 3
  let response
  let rawText = ''
  let lastError

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      response = await fetchImpl(url, { method: 'GET', headers })
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts - 1) {
        throw new Error(`Usage API request failed: ${error}`)
      }
      await sleep(500 + attempt * 1500)
      continue
    }

    try {
      rawText = await response.text()
    } catch {
      rawText = ''
    }

    const isCloudflareChallenge =
      response.status === 403 &&
      rawText.trimStart().slice(0, 16).toLowerCase().includes('<html')

    if (!isCloudflareChallenge || attempt === maxAttempts - 1) {
      break
    }

    await sleep(1000 + attempt * 2000)
  }

  if (!response) {
    throw new Error(`Usage API request failed: ${lastError}`)
  }

  if (!response.ok) {
    throw new UsageApiError(response.status, rawText)
  }

  let payload
  try {
    payload = JSON.parse(rawText)
  } catch (error) {
    throw new Error(`Usage API returned invalid JSON: ${error}`)
  }

  return parseUsageStatusPayload(payload)
}

function resolveHomePath(defaultPath, envValue) {
  const raw = envValue?.trim() || defaultPath
  if (raw.startsWith('~/')) {
    return path.join(os.homedir(), raw.slice(2))
  }
  return path.resolve(raw)
}

export function getConfig(env = process.env) {
  const aiSwitchHome = resolveHomePath('~/.local/share/ai-switch', env.AI_SWITCH_HOME)
  const codexHome = resolveHomePath('~/.codex', env.CODEX_HOME)
  const opencodeAuthFile = resolveHomePath(
    '~/.local/share/opencode/auth.json',
    env.OPENCODE_AUTH_FILE
  )

  return {
    aiSwitchHome,
    codexHome,
    opencodeAuthFile,
    storeDir: path.join(aiSwitchHome, 'credentials'),
    legacyStoreDir: path.join(codexHome, 'credentials'),
    legacyOpencodeDir: path.join(codexHome, 'credentials', 'opencode-openai')
  }
}

export function validateAccountName(account) {
  if (!ACCOUNT_NAME_PATTERN.test(account)) {
    throw new Error(
      `Invalid account name '${account}'. Allowed: A-Z a-z 0-9 . _ -`
    )
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonFile(filePath, missingMessage) {
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(missingMessage)
    }
    throw error
  }

  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in ${filePath}.`)
  }
}

async function chmodSafe(filePath, mode) {
  try {
    await fs.chmod(filePath, mode)
  } catch {
    // Best effort only.
  }
}

export async function ensureDirs(config) {
  await fs.mkdir(config.storeDir, { recursive: true, mode: 0o700 })
}

function getSavedAccountPaths(config, account) {
  return [
    path.join(config.storeDir, `${account}.json`),
    path.join(config.legacyStoreDir, `${account}.json`),
    path.join(config.legacyOpencodeDir, `${account}.json`)
  ]
}

async function readAccountNamesFromDir(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function locateSavedAccountFile(config, account) {
  for (const filePath of getSavedAccountPaths(config, account)) {
    if (await fileExists(filePath)) {
      return filePath
    }
  }

  throw new Error(`Account not found: ${account}`)
}

export async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })

  const tmpPath = path.join(
    dir,
    `.ai-switch-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  )

  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmpPath, filePath)
  await chmodSafe(filePath, 0o600)
}

async function writeSavedAccountFile(config, account, normalized) {
  const target = path.join(config.storeDir, `${account}.json`)
  await writeJsonAtomic(target, normalized)
  return target
}

function mergeOpenAiAuth(auth, normalized) {
  const existingOpenAi = auth.openai && typeof auth.openai === 'object' ? auth.openai : {}
  return {
    ...auth,
    openai: {
      ...existingOpenAi,
      ...normalized
    }
  }
}

async function syncActiveAuthIfMatchingAccount(config, normalized) {
  if (!(await fileExists(config.opencodeAuthFile))) {
    return
  }

  const { auth } = await readOpenCodeAuth(config)
  if (auth?.openai?.accountId !== normalized.accountId) {
    return
  }

  await writeJsonAtomic(config.opencodeAuthFile, mergeOpenAiAuth(auth, normalized))
}

export function normalizeAccountPayload(payload) {
  const direct = payload && typeof payload === 'object' ? payload : null

  if (
    direct &&
    typeof direct.access === 'string' &&
    typeof direct.refresh === 'string' &&
    typeof direct.accountId === 'string'
  ) {
    return {
      access: direct.access,
      refresh: direct.refresh,
      accountId: direct.accountId,
      expires: Number.isFinite(direct.expires) ? direct.expires : 0,
      type: typeof direct.type === 'string' && direct.type ? direct.type : 'oauth'
    }
  }

  const openai = direct?.openai
  if (
    openai &&
    typeof openai === 'object' &&
    typeof openai.access === 'string' &&
    typeof openai.refresh === 'string' &&
    typeof openai.accountId === 'string'
  ) {
    return {
      access: openai.access,
      refresh: openai.refresh,
      accountId: openai.accountId,
      expires: Number.isFinite(openai.expires) ? openai.expires : 0,
      type: typeof openai.type === 'string' && openai.type ? openai.type : 'oauth'
    }
  }

  const opencode = direct?.format === 'unified-openai-auth' ? direct?.opencode : null
  const tokens = opencode?.tokens
  if (
    tokens &&
    typeof tokens === 'object' &&
    typeof tokens.access === 'string' &&
    typeof tokens.refresh === 'string' &&
    typeof tokens.accountId === 'string'
  ) {
    return {
      access: tokens.access,
      refresh: tokens.refresh,
      accountId: tokens.accountId,
      expires: Number.isFinite(opencode.expires) ? opencode.expires : 0,
      type: typeof opencode.type === 'string' && opencode.type ? opencode.type : 'oauth'
    }
  }

  throw new Error('Unsupported account format.')
}

export async function readOpenCodeAuth(config) {
  const payload = await readJsonFile(
    config.opencodeAuthFile,
    `OpenCode auth file not found at ${config.opencodeAuthFile}. Run 'opencode auth login' first.`
  )

  if (!payload || typeof payload !== 'object' || !payload.openai || typeof payload.openai !== 'object') {
    throw new Error(`Invalid OpenCode auth JSON in ${config.opencodeAuthFile}.`)
  }

  return {
    auth: payload,
    normalized: normalizeAccountPayload(payload.openai)
  }
}

export async function readSavedAccount(config, account) {
  const filePath = await locateSavedAccountFile(config, account)
  const payload = await readJsonFile(filePath, `Account not found: ${account}`)
  const normalized = normalizeAccountPayload(payload)

  return {
    filePath,
    normalized
  }
}

export async function listSavedAccountNames(config) {
  await ensureDirs(config)
  const uniqueNames = new Set()

  for (const dirPath of [config.storeDir, config.legacyStoreDir, config.legacyOpencodeDir]) {
    const names = await readAccountNamesFromDir(dirPath)
    for (const name of names) {
      uniqueNames.add(name)
    }
  }

  return Array.from(uniqueNames.values()).sort((a, b) => a.localeCompare(b))
}

export async function findAccountNameByAccountId(config, accountId) {
  const names = await listSavedAccountNames(config)
  for (const name of names) {
    try {
      const { normalized } = await readSavedAccount(config, name)
      if (normalized.accountId === accountId) {
        return name
      }
    } catch {
      // Ignore malformed entries during lookup.
    }
  }
  return null
}

export async function getActiveAccountName(config) {
  if (!(await fileExists(config.opencodeAuthFile))) {
    return 'not configured'
  }

  let payload
  try {
    payload = await readJsonFile(config.opencodeAuthFile, '')
  } catch {
    return 'unknown'
  }

  const accountId = payload?.openai?.accountId
  if (typeof accountId !== 'string' || !accountId) {
    return 'unknown'
  }

  return (await findAccountNameByAccountId(config, accountId)) || 'unknown'
}

export async function saveAccount(config, account) {
  const { normalized } = await readOpenCodeAuth(config)
  return writeSavedAccountFile(config, account, normalized)
}

export async function addAccountWithOAuth(config, account, options = {}) {
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_LOGIN_TIMEOUT_MS
  const autoOpen = options.autoOpen !== false
  const enableManualPaste = options.enableManualPaste !== false
  const fetchImpl = options.fetchImpl || fetch
  let server

  return new Promise(async (resolve, reject) => {
    let flow
    let finished = false
    let timeout
    let promptLine
    let promptInterface

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      if (server) {
        server.close()
        server = undefined
      }
      if (promptInterface) {
        promptInterface.close()
        promptInterface = undefined
      }
    }

    const finish = (fn) => {
      if (finished) {
        return
      }
      finished = true
      cleanup()
      fn()
    }

    const completeLogin = async (code, returnedState, response) => {
      if (returnedState !== flow.state) {
        if (response) {
          response.writeHead(400)
          response.end('Invalid state')
        }
        finish(() => reject(new Error('OAuth state mismatch.')))
        return
      }

      try {
        const normalized = await exchangeAuthorizationCode(flow, code, fetchImpl)
        const target = await writeSavedAccountFile(config, account, normalized)

        if (response) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(`
            <html>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>Account \"${account}\" saved</h1>
                <p>You can close this window.</p>
              </body>
            </html>
          `)
        }

        finish(() => resolve({ target, normalized }))
      } catch (error) {
        if (response) {
          response.writeHead(500)
          response.end('Authentication failed')
        }
        finish(() => reject(error))
      }
    }

    server = http.createServer(async (request, response) => {
      const requestUrl = new URL(request.url || '/', 'http://localhost')
      if (requestUrl.pathname !== '/auth/callback') {
        response.writeHead(404)
        response.end('Not found')
        return
      }

      const code = requestUrl.searchParams.get('code')
      const returnedState = requestUrl.searchParams.get('state')

      if (!code) {
        response.writeHead(400)
        response.end('No authorization code received')
        finish(() => reject(new Error('No authorization code received.')))
        return
      }

      await completeLogin(code, returnedState, response)
    })

    try {
      const actualPort = await findAvailablePort(server)
      flow = createAuthorizationFlow(actualPort)
      console.log(`\n[ai-switch] Login for account \"${account}\"`)
      console.log('[ai-switch] Open this URL in your browser:\n')
      console.log(`  ${flow.url}\n`)

      if (autoOpen) {
        if (await openUrlInBrowser(flow.url)) {
          console.log('[ai-switch] Opened the login page in your local browser.')
        } else {
          console.log('[ai-switch] Could not auto-open a browser on this machine.')
        }
      }

      console.log(`[ai-switch] Waiting for callback on port ${actualPort}...`)

      if (enableManualPaste && process.stdin.isTTY && process.stdout.isTTY) {
        console.log('[ai-switch] If you finish login on another device, copy the final localhost callback URL from that device and paste it here.')
        promptInterface = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true
        })
        promptLine = () => {
          if (!promptInterface || finished) {
            return
          }
          promptInterface.setPrompt('Paste callback URL (optional)> ')
          promptInterface.prompt()
        }
        promptInterface.on('line', async (line) => {
          if (finished) {
            return
          }

          const trimmed = line.trim()
          if (!trimmed) {
            promptLine()
            return
          }

          try {
            const parsed = parseOAuthCallbackUrl(trimmed, flow.state)
            await completeLogin(parsed.code, parsed.state)
          } catch (error) {
            if (!finished) {
              console.log(`[ai-switch] ${error instanceof Error ? error.message : String(error)}`)
              promptLine()
            }
          }
        })
        promptLine()
      }
    } catch (error) {
      finish(() => reject(error))
      return
    }

    timeout = setTimeout(() => {
      finish(() => reject(new Error(`Login timeout after ${Math.round(timeoutMs / 1000)}s - no callback received.`)))
    }, timeoutMs)
  })
}

export async function deleteAccount(config, account) {
  let deleted = false

  for (const target of getSavedAccountPaths(config, account)) {
    try {
      await fs.unlink(target)
      deleted = true
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        continue
      }
      throw error
    }
  }

  if (!deleted) {
    throw new Error(`Account not found: ${account}`)
  }
}

async function saveKnownActiveIfTracked(config, activeAuth, targetAccountId, targetAccountName) {
  const activeAccountId = activeAuth?.openai?.accountId
  if (typeof activeAccountId !== 'string' || !activeAccountId) {
    return { alreadyActive: false }
  }

  if (activeAccountId === targetAccountId) {
    await saveAccount(config, targetAccountName)
    return { alreadyActive: true }
  }

  const activeName = await findAccountNameByAccountId(config, activeAccountId)
  if (activeName) {
    await saveAccount(config, activeName)
    return { alreadyActive: false, savedActiveAs: activeName }
  }

  return { alreadyActive: false }
}

export async function switchAccount(config, account) {
  const { auth } = await readOpenCodeAuth(config)
  const { normalized } = await readSavedAccount(config, account)
  const refreshResult = await saveKnownActiveIfTracked(
    config,
    auth,
    normalized.accountId,
    account
  )

  if (refreshResult.alreadyActive) {
    return { alreadyActive: true }
  }

  const existingOpenAi = auth.openai && typeof auth.openai === 'object' ? auth.openai : {}
  const nextOpenAi = { ...existingOpenAi, ...normalized }

  if (
    auth.openai?.accountId === normalized.accountId &&
    (normalized.expires === 0 || normalized.expires === null || normalized.expires === undefined) &&
    Number.isFinite(existingOpenAi.expires)
  ) {
    nextOpenAi.expires = existingOpenAi.expires
  }

  if (
    auth.openai?.accountId === normalized.accountId &&
    (!normalized.type || normalized.type === 'oauth') &&
    typeof existingOpenAi.type === 'string' &&
    existingOpenAi.type
  ) {
    nextOpenAi.type = existingOpenAi.type
  }

  const nextAuth = { ...auth, openai: nextOpenAi }
  await writeJsonAtomic(config.opencodeAuthFile, nextAuth)

  return {
    alreadyActive: false,
    savedActiveAs: refreshResult.savedActiveAs
  }
}

export async function getActiveUsageStatus(config, env = process.env, fetchImpl = fetch) {
  const activeAccount = await getActiveAccountName(config)
  const { auth, normalized } = await readOpenCodeAuth(config)
  const status = await fetchUsageStatusWithAutoRefresh(
    normalized,
    async (refreshedAccount) => {
      await writeJsonAtomic(config.opencodeAuthFile, mergeOpenAiAuth(auth, refreshedAccount))

      if (activeAccount !== 'unknown' && activeAccount !== 'not configured') {
        await writeSavedAccountFile(config, activeAccount, refreshedAccount)
      }
    },
    env,
    fetchImpl
  )

  return {
    activeAccount,
    accountId: normalized.accountId,
    refreshed: status.refreshed,
    planType: status.planType,
    fiveHour: status.fiveHour,
    weekly: status.weekly
  }
}

export async function getAllSavedAccountUsageStatuses(config, env = process.env, fetchImpl = fetch) {
  const accounts = await listSavedAccountNames(config)
  const activeAccount = await getActiveAccountName(config)
  const results = []

  for (const account of accounts) {
    try {
      const { normalized } = await readSavedAccount(config, account)
      const status = await fetchUsageStatusWithAutoRefresh(
        normalized,
        async (refreshedAccount) => {
          await writeSavedAccountFile(config, account, refreshedAccount)
          await syncActiveAuthIfMatchingAccount(config, refreshedAccount)
        },
        env,
        fetchImpl
      )

      results.push({
        account,
        active: activeAccount === account,
        accountId: normalized.accountId,
        refreshed: status.refreshed,
        planType: status.planType,
        fiveHour: status.fiveHour,
        weekly: status.weekly
      })
    } catch (error) {
      results.push({
        account,
        active: activeAccount === account,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return results
}
