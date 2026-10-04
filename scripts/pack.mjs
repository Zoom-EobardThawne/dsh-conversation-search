/**
 * Package the plugin as a tarball for offline distribution.
 *
 * Runs the build and the manifest checks, then asks an available package manager
 * for a tarball. The result is a plain npm artifact: it installs with
 * `dsh plugin --profile <name> add <file.tgz>`, or by extracting it and pointing
 * `add` at the directory.
 *
 * Usage: node scripts/pack.mjs [outDir]
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshPnpm } from './dsh-paths.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = resolve(process.argv[2] ?? join(root, 'dist'))
const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'

const env = { ...process.env }
// `prepack` shells out to `node`, which is not on PATH on a DSH-only machine.
if (spawnSync('node', ['--version'], { stdio: 'ignore', shell: true }).status !== 0) {
  env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`
}

const run = (command, args, { shell = false } = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell, env })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))))
  })

/** Resolve the package manager used to produce the tarball. */
function resolveManager() {
  const available = command => spawnSync(command, ['--version'], { stdio: 'ignore', shell: true }).status === 0
  if (available('npm')) return { command: 'npm', args: [], shell: true, label: 'npm' }
  if (available('pnpm')) return { command: 'pnpm', args: [], shell: true, label: 'pnpm' }
  const bundled = dshPnpm()
  if (bundled !== null) {
    return { command: process.execPath, args: [bundled], shell: false, label: `pnpm bundled with DSH` }
  }
  throw new Error('no package manager found: install npm or pnpm, or set DSH_E2E_PNPM to a pnpm.cjs path')
}

await run(process.execPath, [join(root, 'scripts', 'build-client.mjs')])
await run(process.execPath, [join(root, 'scripts', 'check.mjs')])

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const manager = resolveManager()

await mkdir(outDir, { recursive: true })
console.log(`packing with ${manager.label}…`)
// Both npm and pnpm accept --pack-destination.
await run(manager.command, [...manager.args, 'pack', '--pack-destination', outDir], { shell: manager.shell })

const produced = (await readdir(outDir)).filter(name => name.endsWith('.tgz'))
if (produced.length === 0) throw new Error('no tarball was produced')
const newest = produced.sort().pop()
const info = await stat(join(outDir, newest))

console.log(`\npackage: ${manifest.name}@${manifest.version}`)
console.log(`tarball: ${join(outDir, newest)} (${Math.round(info.size / 1024)} KiB)`)
console.log(`install: dsh plugin --profile <profile> add "${join(outDir, newest)}"`)
