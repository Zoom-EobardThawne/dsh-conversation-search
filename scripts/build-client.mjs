/**
 * Build script for the Client half.
 *
 * The browser kernel (`@deepseek-ai/dsh-client-modules`) serves this package's
 * `./client` artifact and evaluates it as a script whose only job is to register
 * a lazy-CJS factory:
 *
 *   window.__ModuleLoader__.load({ id: '<package name>', factory: require => exports })
 *
 * `require` resolves against the shell's frozen platform module table (React is
 * a baseline word) and against other boot-graph rows. The authored source in
 * `src/client.js` is therefore written in that factory form already — a
 * CommonJS module body whose exports are declared with `export const` for
 * readability — so this build only rewrites those declarations into `exports.*`
 * assignments, wraps the body in the registration call, and compiles the result
 * to fail loudly on malformed output.
 *
 * No bundler and no dependencies: the artifact is plain JavaScript, and any
 * helper the source needs travels with it.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const sourcePath = join(root, 'src', 'client.js')
const outPath = join(root, 'lib', 'client.js')

const source = await readFile(sourcePath, 'utf8')
const moduleId = packageJson.name

// Prose in the module's own doc comments is not code: strip comments before the
// form checks below, and before rewriting `export const` declarations.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

if (/^\s*import\s/m.test(code)) {
  throw new Error('src/client.js must not use static ESM imports: the factory is a lazy-CJS module body')
}
if (code.includes('__ModuleLoader__')) {
  throw new Error('src/client.js must not contain its own __ModuleLoader__ wrapper')
}

const body = source.replace(
  /^export (?:const|let|var) ([A-Za-z0-9_$]+) /gm,
  (match, name) => `exports.${name} `,
)
const leftover = body.replace(/\/\*[\s\S]*?\*\//g, '').match(/^export\b.*$/m)
if (leftover !== null) {
  throw new Error(`src/client.js: unsupported export form — use \`export const\`: ${leftover[0].trim()}`)
}

const prelude = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(moduleId)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const postlude = `
\t\treturn module.exports;
\t}
});
`
const indented = body
  .split('\n')
  .map(line => (line.length === 0 ? '' : `\t${line}`))
  .join('\n')

const banner = `// ${moduleId}@${packageJson.version} — built client bundle from src/client.js. Do not edit by hand.\n`
const artifact = `${banner}${prelude}${indented}${postlude}`

// Compile (not execute) the registration script: the only free identifier is the
// `window` global the browser supplies.
new Script(artifact, { filename: 'lib/client.js' })

await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, artifact, 'utf8')
console.log(`built lib/client.js (${Buffer.byteLength(artifact, 'utf8')} bytes, id=${moduleId})`)
