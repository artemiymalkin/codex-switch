import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addAccountWithOAuth,
  fetchUsageStatusForAccount,
  getAllSavedAccountUsageStatuses,
  getActiveAccountName,
  getActiveUsageStatus,
  getConfig,
  listSavedAccountNames,
  normalizeAccountPayload,
  parseOAuthCallbackUrl,
  parseUsageStatusPayload,
  readSavedAccount,
  writeJsonAtomic
} from '../src/lib.js'

test('normalizeAccountPayload accepts direct OpenCode account format', () => {
  const normalized = normalizeAccountPayload({
    access: 'a',
    refresh: 'r',
    accountId: 'acc',
    expires: 123,
    type: 'oauth'
  })

  assert.deepEqual(normalized, {
    access: 'a',
    refresh: 'r',
    accountId: 'acc',
    expires: 123,
    type: 'oauth'
  })
})

test('normalizeAccountPayload accepts wrapped auth.json format', () => {
  const normalized = normalizeAccountPayload({
    openai: {
      access: 'a',
      refresh: 'r',
      accountId: 'acc'
    }
  })

  assert.deepEqual(normalized, {
    access: 'a',
    refresh: 'r',
    accountId: 'acc',
    expires: 0,
    type: 'oauth'
  })
})

test('normalizeAccountPayload accepts unified-openai-auth format', () => {
  const normalized = normalizeAccountPayload({
    format: 'unified-openai-auth',
    opencode: {
      tokens: {
        access: 'a',
        refresh: 'r',
        accountId: 'acc'
      },
      expires: 456,
      type: 'oauth'
    }
  })

  assert.deepEqual(normalized, {
    access: 'a',
    refresh: 'r',
    accountId: 'acc',
    expires: 456,
    type: 'oauth'
  })
})

test('parseUsageStatusPayload maps primary and secondary usage windows', () => {
  const status = parseUsageStatusPayload(
    {
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 24,
          reset_after_seconds: 60
        },
        secondary_window: {
          used_percent: 70,
          reset_at: 1_700_000_000
        }
      }
    },
    1_000
  )

  assert.equal(status.planType, 'plus')
  assert.deepEqual(status.fiveHour, {
    limit: 100,
    remaining: 76,
    resetAt: 61_000,
    updatedAt: 1_000
  })
  assert.deepEqual(status.weekly, {
    limit: 100,
    remaining: 30,
    resetAt: 1_700_000_000_000,
    updatedAt: 1_000
  })
})

test('parseUsageStatusPayload falls back to codex entry in additional rate limits', () => {
  const status = parseUsageStatusPayload(
    {
      additional_rate_limits: [
        {
          metered_feature: 'codex',
          rate_limit: {
            primary_window: {
              used_percent: 10
            }
          }
        }
      ]
    },
    5_000
  )

  assert.deepEqual(status.fiveHour, {
    limit: 100,
    remaining: 90,
    resetAt: undefined,
    updatedAt: 5_000
  })
  assert.equal(status.weekly, undefined)
})

test('parseUsageStatusPayload rejects responses without usable windows', () => {
  assert.throws(() => parseUsageStatusPayload({ rate_limit: {} }), {
    message: 'Usage API response contained no usable rate limit windows.'
  })
})

test('fetchUsageStatusForAccount queries usage API and parses response', async () => {
  const calls = []
  const status = await fetchUsageStatusForAccount(
    { access: 'token-1', accountId: 'acc-1' },
    {},
    async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            plan_type: 'pro',
            rate_limit: {
              primary_window: { used_percent: 5, reset_after_seconds: 10 },
              secondary_window: { used_percent: 20, reset_after_seconds: 20 }
            }
          })
        }
      }
    }
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/usage')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-1')
  assert.equal(calls[0].options.headers['ChatGPT-Account-Id'], 'acc-1')
  assert.equal(status.planType, 'pro')
  assert.equal(status.fiveHour.remaining, 95)
  assert.equal(status.weekly.remaining, 80)
})

test('parseOAuthCallbackUrl extracts code and validates state', () => {
  const parsed = parseOAuthCallbackUrl(
    'http://localhost:1455/auth/callback?code=test-code&state=test-state',
    'test-state'
  )

  assert.deepEqual(parsed, {
    code: 'test-code',
    state: 'test-state'
  })
})

test('parseOAuthCallbackUrl rejects invalid callback URL', () => {
  assert.throws(
    () => parseOAuthCallbackUrl('http://localhost:1455/other?code=x&state=y', 'y'),
    /Callback URL must point to \/auth\/callback/
  )
  assert.throws(
    () => parseOAuthCallbackUrl('http://localhost:1455/auth/callback?code=x&state=nope', 'y'),
    /Callback URL state mismatch/
  )
})

test('listSavedAccountNames includes legacy store entries and active lookup can resolve them', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-switch-test-'))
  const config = getConfig({
    AI_SWITCH_HOME: path.join(tmpRoot, 'store'),
    CODEX_HOME: path.join(tmpRoot, 'codex'),
    OPENCODE_AUTH_FILE: path.join(tmpRoot, 'opencode', 'auth.json')
  })

  await fs.mkdir(path.dirname(config.opencodeAuthFile), { recursive: true })
  await writeJsonAtomic(config.opencodeAuthFile, {
    openai: {
      access: 'active-token',
      refresh: 'active-refresh',
      accountId: 'legacy-id'
    }
  })

  await writeJsonAtomic(path.join(config.legacyStoreDir, 'legacy.json'), {
    access: 'legacy-access',
    refresh: 'legacy-refresh',
    accountId: 'legacy-id'
  })
  await writeJsonAtomic(path.join(config.legacyOpencodeDir, 'secondary.json'), {
    access: 'secondary-access',
    refresh: 'secondary-refresh',
    accountId: 'secondary-id'
  })

  const names = await listSavedAccountNames(config)
  assert.deepEqual(names, ['legacy', 'secondary'])
  assert.equal(await getActiveAccountName(config), 'legacy')
})

test('readSavedAccount does not rewrite unified-openai-auth files on read', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-switch-test-'))
  const config = getConfig({
    AI_SWITCH_HOME: path.join(tmpRoot, 'store')
  })

  const unifiedPath = path.join(config.storeDir, 'demo.json')
  const unifiedPayload = {
    format: 'unified-openai-auth',
    codex: {
      tokens: {
        access_token: 'codex-access',
        refresh_token: 'codex-refresh',
        account_id: 'codex-id'
      }
    },
    opencode: {
      tokens: {
        access: 'open-access',
        refresh: 'open-refresh',
        accountId: 'open-id'
      },
      expires: 123,
      type: 'oauth'
    }
  }

  await writeJsonAtomic(unifiedPath, unifiedPayload)
  const before = await fs.readFile(unifiedPath, 'utf8')

  const saved = await readSavedAccount(config, 'demo')
  assert.equal(saved.normalized.accountId, 'open-id')

  const after = await fs.readFile(unifiedPath, 'utf8')
  assert.equal(after, before)
})

test('getAllSavedAccountUsageStatuses returns status for each saved account', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-switch-test-'))
  const config = getConfig({
    AI_SWITCH_HOME: path.join(tmpRoot, 'store'),
    OPENCODE_AUTH_FILE: path.join(tmpRoot, 'opencode', 'auth.json')
  })

  await fs.mkdir(path.dirname(config.opencodeAuthFile), { recursive: true })
  await writeJsonAtomic(config.opencodeAuthFile, {
    openai: {
      access: 'active-token',
      refresh: 'active-refresh',
      accountId: 'work-id'
    }
  })
  await writeJsonAtomic(path.join(config.storeDir, 'work.json'), {
    access: 'work-token',
    refresh: 'work-refresh',
    accountId: 'work-id'
  })
  await writeJsonAtomic(path.join(config.storeDir, 'personal.json'), {
    access: 'personal-token',
    refresh: 'personal-refresh',
    accountId: 'personal-id'
  })

  const statuses = await getAllSavedAccountUsageStatuses(
    config,
    {},
    async (_url, options) => {
      const accountId = options.headers['ChatGPT-Account-Id']
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            plan_type: accountId === 'work-id' ? 'plus' : 'pro',
            rate_limit: {
              primary_window: {
                used_percent: accountId === 'work-id' ? 30 : 60,
                reset_after_seconds: 10
              }
            }
          })
        }
      }
    }
  )

  assert.equal(statuses.length, 2)
  assert.deepEqual(
    statuses.map((status) => ({ account: status.account, active: status.active, planType: status.planType })),
    [
      { account: 'personal', active: false, planType: 'pro' },
      { account: 'work', active: true, planType: 'plus' }
    ]
  )
  assert.equal(statuses[0].fiveHour.remaining, 40)
  assert.equal(statuses[1].fiveHour.remaining, 70)
})

test('getAllSavedAccountUsageStatuses refreshes expired tokens and persists them', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-switch-test-'))
  const config = getConfig({
    AI_SWITCH_HOME: path.join(tmpRoot, 'store'),
    OPENCODE_AUTH_FILE: path.join(tmpRoot, 'opencode', 'auth.json')
  })

  await fs.mkdir(path.dirname(config.opencodeAuthFile), { recursive: true })
  await writeJsonAtomic(config.opencodeAuthFile, {
    openai: {
      access: 'active-token',
      refresh: 'active-refresh',
      accountId: 'old-id'
    }
  })

  const expiredFile = path.join(config.storeDir, 'expired.json')
  await writeJsonAtomic(expiredFile, {
    access: 'expired-access',
    refresh: 'expired-refresh',
    accountId: 'old-id'
  })

  const calls = []
  const refreshedAccess = [
    'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJvbGQtaWQifX0.signature'
  ][0]

  const statuses = await getAllSavedAccountUsageStatuses(
    config,
    {},
    async (url, options) => {
      calls.push({ url, options })

      if (url.endsWith('/codex/usage')) {
        const token = options.headers.Authorization
        if (token === 'Bearer expired-access') {
          return {
            ok: false,
            status: 401,
            async text() {
              return JSON.stringify({
                error: {
                  message: 'Provided authentication token is expired. Please try signing in again.',
                  code: 'token_expired'
                }
              })
            }
          }
        }

        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              plan_type: 'plus',
              rate_limit: {
                primary_window: { used_percent: 25, reset_after_seconds: 10 }
              }
            })
          }
        }
      }

      assert.equal(url, 'https://auth.openai.com/oauth/token')
      assert.equal(options.method, 'POST')
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            access_token: refreshedAccess,
            refresh_token: 'new-refresh',
            expires_in: 3600,
            token_type: 'Bearer'
          })
        }
      }
    }
  )

  assert.equal(statuses.length, 1)
  assert.equal(statuses[0].refreshed, true)
  assert.equal(statuses[0].fiveHour.remaining, 75)

  const saved = JSON.parse(await fs.readFile(expiredFile, 'utf8'))
  assert.equal(saved.access, refreshedAccess)
  assert.equal(saved.refresh, 'new-refresh')

  const active = JSON.parse(await fs.readFile(config.opencodeAuthFile, 'utf8'))
  assert.equal(active.openai.access, refreshedAccess)
  assert.equal(active.openai.refresh, 'new-refresh')
})

test('getActiveUsageStatus refreshes expired active token and updates saved alias', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-switch-test-'))
  const config = getConfig({
    AI_SWITCH_HOME: path.join(tmpRoot, 'store'),
    OPENCODE_AUTH_FILE: path.join(tmpRoot, 'opencode', 'auth.json')
  })

  await fs.mkdir(path.dirname(config.opencodeAuthFile), { recursive: true })
  await writeJsonAtomic(config.opencodeAuthFile, {
    openai: {
      access: 'expired-active',
      refresh: 'refresh-active',
      accountId: 'active-id'
    }
  })
  await writeJsonAtomic(path.join(config.storeDir, 'work.json'), {
    access: 'old-saved',
    refresh: 'old-refresh',
    accountId: 'active-id'
  })

  const refreshedAccess = [
    'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY3RpdmUtaWQifX0.signature'
  ][0]

  const status = await getActiveUsageStatus(
    config,
    {},
    async (url, options) => {
      if (url.endsWith('/codex/usage')) {
        if (options.headers.Authorization === 'Bearer expired-active') {
          return {
            ok: false,
            status: 401,
            async text() {
              return JSON.stringify({ error: { message: 'expired', code: 'token_expired' } })
            }
          }
        }

        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              plan_type: 'pro',
              rate_limit: {
                primary_window: { used_percent: 10, reset_after_seconds: 10 },
                secondary_window: { used_percent: 20, reset_after_seconds: 20 }
              }
            })
          }
        }
      }

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            access_token: refreshedAccess,
            refresh_token: 'fresh-refresh',
            expires_in: 3600,
            token_type: 'Bearer'
          })
        }
      }
    }
  )

  assert.equal(status.refreshed, true)
  assert.equal(status.activeAccount, 'work')
  assert.equal(status.fiveHour.remaining, 90)

  const saved = JSON.parse(await fs.readFile(path.join(config.storeDir, 'work.json'), 'utf8'))
  assert.equal(saved.access, refreshedAccess)
  assert.equal(saved.refresh, 'fresh-refresh')
})

test('addAccountWithOAuth prints authorization URL and waits for callback', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-switch-test-'))
  const config = getConfig({
    AI_SWITCH_HOME: path.join(tmpRoot, 'store'),
    OPENCODE_AUTH_FILE: path.join(tmpRoot, 'opencode', 'auth.json')
  })

  const logs = []
  const originalLog = console.log
  console.log = (...args) => logs.push(args.join(' '))

  try {
    const pending = addAccountWithOAuth(config, 'demo', {
      timeoutMs: 100,
      autoOpen: false,
      enableManualPaste: false
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const urlLine = logs.find((line) => line.includes('https://auth.openai.com/oauth/authorize?'))
    assert.ok(urlLine)
    assert.match(urlLine, /client_id=app_EMoamEEZ73f0CkXaXp7hrann/)
    assert.match(urlLine, /code_challenge=/)
    assert.match(urlLine, /redirect_uri=http%3A%2F%2Flocalhost%3A14\d\d%2Fauth%2Fcallback/)

    await assert.rejects(pending, /Login timeout after/) 
  } finally {
    console.log = originalLog
  }
})
