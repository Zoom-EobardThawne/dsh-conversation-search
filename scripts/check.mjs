/**
 * Static checks for the built artifact and the manifest contract, run without a
 * browser: manifest shape, artifact presence and size, module id match, and the
 * absence of accidental top-level ESM syntax in the factory body.
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (manifest.dsh?.client?.platform !== 'web') problems.push('package.json: dsh.client.platform must be "web"')
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('package.json: dsh.bundle.patch must name cordis.patch.yml')
if (manifest.exports?.['./client'] !== './lib/client.js') problems.push("package.json: exports['./client'] must be ./lib/client.js")
if (manifest.peerDependencies?.['@deepseek-ai/dsh'] !== undefined) {
  problems.push('package.json: do not declare a @deepseek-ai/dsh peer (checked against one runtime version)')
}

const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes('name: ' + manifest.name)) problems.push('cordis.patch.yml: insert row must name the package')

const artifactPath = join(root, 'lib', 'client.js')
const artifact = await readFile(artifactPath, 'utf8')
const size = (await stat(artifactPath)).size
if (size < 2000) problems.push(`lib/client.js is suspiciously small (${size} bytes)`)

for (const needle of [
  `window.__ModuleLoader__.load({`,
  `id: ${JSON.stringify(manifest.name)},`,
  'factory: (require)',
  'exports.apply',
]) {
  if (!artifact.includes(needle)) problems.push(`lib/client.js: missing ${JSON.stringify(needle)}`)
}
if (/^export /m.test(artifact)) problems.push('lib/client.js: top-level ESM export found in a lazy-CJS bundle')
if (/^\s*import\s/m.test(artifact)) problems.push('lib/client.js: top-level ESM import found in a lazy-CJS bundle')

new Script(artifact, { filename: 'lib/client.js' })

const host = await readFile(join(root, 'lib', 'index.js'), 'utf8')
if (!host.includes('export function apply')) problems.push('lib/index.js: must export an apply function')

if (problems.length > 0) {
  for (const problem of problems) console.error('FAIL ' + problem)
  process.exit(1)
}
console.log(`ok: ${manifest.name}@${manifest.version} — lib/client.js ${size} bytes`)
