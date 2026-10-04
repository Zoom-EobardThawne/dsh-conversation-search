/**
 * Manual end-to-end test of the distributable: install the packed tarball into a
 * throwaway profile inside a throwaway DSH home, then check the profile's own
 * bookkeeping (package.json, cordis.patch.yml, node_modules link).
 *
 * Usage: node scripts/verify-pack.mjs [tarball]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshCli } from './dsh-paths.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tarball = resolve(process.argv[2] ?? join(root, 'dist', 'dsh-conversation-search-0.1.0.tgz'))
if (!existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`)

const home = resolve(process.argv[3] ?? join(dirname(root), '.dsh-pack-test'))
if (!home.includes('.dsh-pack-test')) throw new Error(`refusing to use ${home}`)
const profileName = 'web'
const profile = join(home, 'profiles', profileName)
const dsh = dshCli()

const run = args =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(dsh, args, {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, DSH_HOME: home },
    })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolvePromise() : reject(new Error(`dsh ${args.join(' ')} exited ${code}`))))
  })

await rm(home, { recursive: true, force: true })
await mkdir(profile, { recursive: true })
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, null, 2), 'utf8')
await writeFile(join(profile, 'cordis.yml'), '[]\n', 'utf8')
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')

console.log(`installing ${tarball} into ${profile}`)
await run(['plugin', '--profile', profileName, 'add', tarball])

const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
const patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
const linked = existsSync(join(profile, 'node_modules', 'dsh-conversation-search', 'lib', 'client.js'))
const installed = manifest.dependencies?.['dsh-conversation-search']
const bundled = manifest.dsh?.profile?.bundles?.includes('dsh-conversation-search') === true

console.log(JSON.stringify({
  dependency: installed,
  bundleSelected: bundled,
  patchMentionsPlugin: patch.includes('dsh-conversation-search'),
  installedArtifact: linked,
}, null, 2))

const problems = []
if (typeof installed !== 'string' || !installed.includes('dsh-conversation-search')) problems.push('dependency missing from the profile manifest')
if (bundled !== true) problems.push('bundle not selected in dsh.profile.bundles')
if (linked !== true) problems.push('lib/client.js is not present under the profile node_modules')
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`)
  process.exit(1)
}
console.log('ok: the packed tarball installs and wires itself into a fresh profile')
console.log(`home used: ${home}`)
