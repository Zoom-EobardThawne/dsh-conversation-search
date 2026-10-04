/**
 * Stop the isolated verification instance: kill the process whose DSH_HOME is
 * the given test home, remove the test home directory, and clear scratch files.
 *
 * Usage: node scripts/clean-e2e.mjs [testHome]
 */
import { execFileSync } from 'node:child_process'
import { rm, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Defaults sit next to the repository, matching `e2e-instance.mjs`, so no
// machine-specific path is baked into the script.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const testHome = resolve(process.argv[2] ?? join(dirname(root), '.dsh-test'))
const workspace = resolve(process.argv[3] ?? dirname(root))

if (basename(testHome) !== '.dsh-test') {
  throw new Error(`refusing to remove ${testHome}: expected a directory named .dsh-test`)
}

/* Kill only processes that claim this test home, never the user's instance. */
let tasks = ''
try {
  tasks = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | " +
    'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
  ], { encoding: 'utf8' })
} catch (error) {
  tasks = ''
}

let victims = []
try {
  const parsed = JSON.parse(tasks.trim() || '[]')
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  victims = rows.filter(row => typeof row?.CommandLine === 'string' && row.CommandLine.includes(testHome))
} catch (error) {
  victims = []
}

for (const victim of victims) {
  try {
    execFileSync('taskkill', ['/PID', String(victim.ProcessId), '/T', '/F'], { stdio: 'ignore' })
    console.log(`stopped pid ${victim.ProcessId} (owned ${testHome})`)
  } catch (error) {
    console.log(`could not stop pid ${victim.ProcessId}: ${error.message}`)
  }
}
if (victims.length === 0) console.log('no running process claimed the test home')

// The instance is started by a wrapper this script may itself be running under, so
// the kill above can take this process down with it. Removing the throwaway home is
// idempotent, so attempt it before and after the wait.
await rm(testHome, { recursive: true, force: true }).catch(error => {
  console.log(`first removal attempt failed (${error.code ?? error.message}); retrying`)
})
await new Promise(resolve_ => setTimeout(resolve_, 1500))
await rm(testHome, { recursive: true, force: true }).catch(error => {
  console.log(`removal failed: ${error.code ?? error.message}`)
})
console.log(`removed ${testHome}`)

for (const name of ['.probe.json', '.overlay.json']) {
  const target = join(workspace, name)
  try {
    await stat(target)
    await rm(target, { force: true })
    console.log(`removed ${target}`)
  } catch (error) {
    /* not present */
  }
}

const remaining = await readdir(testHome).catch(() => null)
console.log(remaining === null ? 'test home is gone' : `still present: ${remaining.join(', ')}`)
