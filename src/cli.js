import { Command } from 'commander'
import {
  addAccountWithOAuth,
  deleteAccount,
  ensureDirs,
  getAllSavedAccountUsageStatuses,
  getActiveAccountName,
  getActiveUsageStatus,
  getConfig,
  listSavedAccountNames,
  saveAccount,
  switchAccount,
  validateAccountName
} from './lib.js'

function fail(error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Error: ${message}`)
  process.exitCode = 1
}

function withAccountAction(action) {
  return async (account) => {
    validateAccountName(account)
    const config = getConfig()
    await ensureDirs(config)
    await action(config, account)
  }
}

function formatWindow(label, window) {
  if (!window) {
    return `${label}: unavailable`
  }

  const formatDateTime = (value) => {
    const date = new Date(value)
    const pad = (part) => String(part).padStart(2, '0')
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  const remaining = typeof window.remaining === 'number'
    ? `${Math.round(window.remaining)}% remaining`
    : 'remaining unknown'

  const resetAt = typeof window.resetAt === 'number'
    ? formatDateTime(window.resetAt)
    : 'unknown reset'

  return `${label}: ${remaining}, resets ${resetAt}`
}

function formatAccountLabel(account, active) {
  return active ? `${account} (active)` : account
}

export async function run(argv = process.argv) {
  const program = new Command()

  program
    .name('ai')
    .description('Switch OpenCode accounts using a shared local store')
    .showHelpAfterError()

  program
    .command('ls')
    .description('Show active OpenCode account')
    .action(async () => {
      const config = getConfig()
      await ensureDirs(config)
      console.log(`Active OpenCode account: ${await getActiveAccountName(config)}`)
    })

  program
    .command('status')
      .description('Show active OpenCode account usage limits')
      .option('-a, --all', 'Show usage limits for all saved accounts')
      .action(async (options) => {
      const config = getConfig()
      await ensureDirs(config)

      if (options.all) {
        const statuses = await getAllSavedAccountUsageStatuses(config)
        if (statuses.length === 0) {
          console.log(`No saved accounts found in ${config.storeDir}.`)
          return
        }

        for (const [index, status] of statuses.entries()) {
          if (index > 0) {
            console.log('')
          }

          console.log(formatAccountLabel(status.account, status.active))
          if (status.refreshed) {
            console.log('Token: refreshed automatically')
          }
          if (status.error) {
            console.log(`Error: ${status.error}`)
            continue
          }
          if (status.planType) {
            console.log(`Plan: ${status.planType}`)
          }
          console.log(formatWindow('5h limit', status.fiveHour))
          console.log(formatWindow('Weekly limit', status.weekly))
        }
        return
      }

      const status = await getActiveUsageStatus(config)

      const activeLabel = status.activeAccount === 'unknown' && status.accountId
        ? `unknown (${status.accountId})`
        : status.activeAccount

      console.log(`Active OpenCode account: ${activeLabel}`)
      if (status.refreshed) {
        console.log('Token: refreshed automatically')
      }
      if (status.planType) {
        console.log(`Plan: ${status.planType}`)
      }
      console.log(formatWindow('5h limit', status.fiveHour))
      console.log(formatWindow('Weekly limit', status.weekly))
    })

  program
    .command('add <account>')
    .alias('login')
    .description('Authenticate via OAuth and save account as <account>')
    .option('--no-open', 'Do not auto-open the local browser')
    .action(
      async (account, options) => {
        validateAccountName(account)
        const config = getConfig()
        await ensureDirs(config)
        const { target } = await addAccountWithOAuth(config, account, {
          autoOpen: options.open
        })
        console.log(`Saved OpenCode account '${account}' to ${target}`)
      }
    )

  program
    .command('list')
    .description('List saved OpenCode accounts')
    .action(async () => {
      const config = getConfig()
      await ensureDirs(config)
      const accounts = await listSavedAccountNames(config)
      if (accounts.length === 0) {
        console.log(`No saved accounts found in ${config.storeDir}.`)
        return
      }

      for (const account of accounts) {
        console.log(account)
      }
    })

  program
    .command('save <account>')
    .description('Save current OpenCode auth as <account>')
    .action(
      withAccountAction(async (config, account) => {
        const target = await saveAccount(config, account)
        console.log(`Saved OpenCode account '${account}' to ${target}`)
      })
    )

  program
    .command('use <account>')
    .description('Switch OpenCode to a saved account')
    .action(
      withAccountAction(async (config, account) => {
        const result = await switchAccount(config, account)
        if (result.alreadyActive) {
          console.log(`Already active on '${account}'; refreshed stored tokens.`)
          return
        }
        if (result.savedActiveAs) {
          console.log(`Saved current OpenCode session as '${result.savedActiveAs}'.`)
        }
        console.log(`Active OpenCode auth switched to account '${account}'`)
      })
    )

  program
    .command('delete <account>')
    .alias('rm')
    .description('Remove a saved account from the store')
    .action(
      withAccountAction(async (config, account) => {
        await deleteAccount(config, account)
        console.log(`Removed saved account '${account}' from the store.`)
      })
    )

  try {
    await program.parseAsync(argv)
  } catch (error) {
    fail(error)
  }
}
