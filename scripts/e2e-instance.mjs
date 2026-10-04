/**
 * Provision the isolated verification instance: a throwaway DSH_HOME holding a
 * `web` profile with this plugin installed, so the plugin can be exercised in a
 * real browser without touching the user's own environment.
 *
 * It prints the URL (with its access token) to stderr and stays in the
 * foreground, so it can be run as a managed background job.
 *
 * Usage: node scripts/e2e-instance.mjs [port] [testHome]
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshCli } from './dsh-paths.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const port = process.argv[2] ?? '19488'
const testHome = resolve(process.argv[3] ?? join(dirname(root), '.dsh-test'))
const profile = join(testHome, 'profiles', 'web')
const dsh = dshCli()

if (testHome.includes('.dsh-test') === false) {
  throw new Error(`refusing to use ${testHome}: expected a path containing .dsh-test`)
}

const run = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: true, ...options })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))))
  })

const env = { ...process.env, DSH_HOME: testHome }

await mkdir(profile, { recursive: true })

if (!existsSync(join(profile, 'package.json'))) {
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2), 'utf8')
}
if (!existsSync(join(profile, 'cordis.yml'))) {
  await writeFile(join(profile, 'cordis.yml'), '[]\n', 'utf8')
}
if (!existsSync(join(profile, 'cordis.patch.yml'))) {
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
}

const credentials = join(homedir(), '.dsh', '.credentials.yaml')
if (!existsSync(join(testHome, '.credentials.yaml')) && existsSync(credentials)) {
  await copyFile(credentials, join(testHome, '.credentials.yaml'))
}

const pluginName = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name
const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
if (!manifest.dsh.profile.bundles.includes(pluginName)) {
  await run(dsh, ['plugin', '--profile', 'web', 'add', root], { env })
  console.error(`provisioned ${profile}`)
}

// The server prints its URL (with token) on stdout; mirror it to stderr so it
// survives a job's captured output either way.
const server = spawn(dsh, ['web', '--no-open', '--port', String(port)], { env, shell: true })
server.stdout.on('data', chunk => process.stderr.write(chunk))
server.stderr.on('data', chunk => process.stderr.write(chunk))
server.on('exit', code => {
  console.error(`dsh web exited ${code}`)
  process.exit(code ?? 0)
})
