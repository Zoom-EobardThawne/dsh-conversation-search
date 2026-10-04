/**
 * Release helper: build, verify, test, then publish.
 *
 * Prefers `npm` so a `npm login` session is reused, falls back to `pnpm`, and
 * finally to a pnpm path given by `DSH_E2E_PNPM` (the pnpm that ships with DSH).
 *
 * The wrapper exists because `prepack` shells out to `node`: on a machine where
 * Node is not on PATH — a DSH-only install — that step fails. This script puts
 * the running runtime's directory on PATH first, then delegates.
 *
 * Usage: node scripts/publish.mjs [--dry-run] [--otp <code>] [--tag <tag>] [...]
 *
 * `--dry-run` packs the tarball and prints its contents without contacting the
 * registry for authentication, so it is safe to run before logging in.
 */
import { spawn, spawnSync } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshPnpm } from './dsh-paths.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const passthrough = process.argv.slice(2)
const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'

const env = { ...process.env }
const nodeOnPath = spawnSync('node', ['--version'], { stdio: 'ignore', shell: true }).status === 0
if (!nodeOnPath) {
  env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`
  console.log(`note: node is not on PATH; prepending ${dirname(process.execPath)}`)
}

const run = (command, args, { shell = false } = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell, env })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))))
  })

/** Resolve the package manager to publish with. */
function resolveManager() {
  const available = command => spawnSync(command, ['--version'], { stdio: 'ignore', shell: true }).status === 0
  if (available('npm')) return { command: 'npm', args: [], label: 'npm' }
  if (available('pnpm')) return { command: 'pnpm', args: [], label: 'pnpm' }
  const bundled = dshPnpm()
  if (bundled !== null) {
    return { command: process.execPath, args: [bundled], label: `pnpm bundled with DSH` }
  }
  throw new Error('no package manager found: install npm or pnpm, or set DSH_E2E_PNPM to a pnpm.cjs path')
}

const dryRun = passthrough.includes('--dry-run')
const manager = resolveManager()

if (!dryRun) {
  console.log('publishing needs an authenticated registry session:')
  console.log('  npm login                      # interactive')
  console.log('  or put an automation token in ~/.npmrc:')
  console.log('  //registry.npmjs.org/:_authToken=<token>')
  console.log('')
}

// npm and pnpm both refuse to publish from a dirty working tree, which is a
// useful guard: the published tarball should correspond to a committed state.
const git = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
if (git.status === 0 && git.stdout.trim().length > 0) {
  console.log('warning: the git working tree is not clean, so the publish command may refuse.')
  console.log('         commit the changes first, or pass --no-git-checks to skip that guard.')
  console.log('')
}

await run(process.execPath, [join(root, 'scripts', 'build-client.mjs')])
await run(process.execPath, [join(root, 'scripts', 'check.mjs')])
await run(process.execPath, [join(root, 'tests', 'engine.test.mjs')])

console.log(`\npublishing with ${manager.label}${dryRun ? ' (dry run)' : ''}…\n`)
await run(manager.command, [...manager.args, 'publish', ...passthrough], { shell: manager.args.length === 0 })

console.log(dryRun ? '\ndry run finished: nothing was published.' : '\npublished.')
