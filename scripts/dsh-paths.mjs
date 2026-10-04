/**
 * Locate the DSH tooling these scripts drive, without baking a single
 * machine-specific path into the repository.
 *
 * Resolution order for every lookup:
 *   1. an explicit environment override
 *      (`DSH_E2E_DSH` / `DSH_E2E_PNPM` / `DSH_E2E_CHROME`);
 *   2. the layout derived from the running Node, when that Node is the one DSH
 *      ships — it sits at a fixed offset inside the install;
 *   3. a short list of common install roots;
 *   4. a bare command name, for a machine where the tool is on PATH.
 *
 * Step 2 only applies while the scripts run under DSH's own Node. Once a system
 * Node is installed, these scripts are normally run with it, so step 3 is what
 * makes them work out of the box.
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** An override counts only when it is a non-empty string. */
const override = value => (typeof value === 'string' && value.length > 0 ? value : null)

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return null
}

/**
 * `<DSH>/resources/runtime/primary-runtime` when this process runs under the
 * Node that DSH ships, otherwise null. The name is checked as well as the
 * contents so an unrelated three-levels-up directory is never mistaken for it.
 */
function primaryRuntime() {
  const candidate = resolve(dirname(process.execPath), '..', '..', '..')
  if (basename(candidate) !== 'primary-runtime') return null
  return existsSync(join(candidate, 'dependencies')) ? candidate : null
}

/** Install roots to probe: the directory that contains `resources/`. */
function installRoots() {
  const roots = []
  const primary = primaryRuntime()
  if (primary !== null) roots.push(resolve(primary, '..', '..', '..'))
  roots.push(
    override(process.env.DSH_INSTALL),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH'),
    join(process.env.LOCALAPPDATA ?? '', 'DSH'),
    'C:\\Program Files\\DSH',
    'C:\\Program Files (x86)\\DSH',
    'D:\\Tools\\DSH',
  )
  return roots.filter(root => typeof root === 'string' && root.length > 0)
}

/** The `dsh` launcher: override → DSH layout → common installs → PATH. */
export function dshCli() {
  const explicit = override(process.env.DSH_CLI) ?? override(process.env.DSH_E2E_DSH)
  if (explicit !== null) return explicit

  const primary = primaryRuntime()
  if (primary !== null) {
    const runtime = resolve(primary, '..')
    const found = firstExisting([join(runtime, 'cli', 'bin', 'dsh.cmd'), join(runtime, 'cli', 'bin', 'dsh')])
    if (found !== null) return found
  }

  return firstExisting(installRoots().flatMap(root => [
    join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh'),
  ])) ?? 'dsh'
}

/** The pnpm that ships with DSH, or null when it cannot be located. */
export function dshPnpm() {
  const explicit = override(process.env.DSH_PNPM) ?? override(process.env.DSH_E2E_PNPM)
  if (explicit !== null) return explicit

  const primary = primaryRuntime()
  if (primary !== null) {
    const found = firstExisting([join(primary, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')])
    if (found !== null) return found
  }

  return firstExisting(installRoots().map(root =>
    join(root, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')))
}

/** A Chromium browser for the CDP-driven checks: override → common installs → PATH. */
export function chromeBinary() {
  return override(process.env.DSH_E2E_CHROME)
    ?? firstExisting([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.CHROME_PATH,
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ])
    ?? 'chrome'
}
