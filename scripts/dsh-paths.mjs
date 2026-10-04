/**
 * Locate the DSH tooling these scripts drive, without baking machine-specific
 * paths into the repository.
 *
 * Resolution order for every lookup:
 *   1. an explicit environment override
 *      (`DSH_E2E_DSH` / `DSH_E2E_PNPM` / `DSH_E2E_CHROME`);
 *   2. a path derived from the running runtime — these scripts are normally run
 *      by the Node that DSH ships, which sits at a fixed offset inside the install;
 *   3. a bare command name, for a machine where the tool is on PATH.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** An override counts only when it is a non-empty string. */
const override = value => (typeof value === 'string' && value.length > 0 ? value : null)

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return null
}

/**
 * `<DSH>/resources/runtime/primary-runtime`, derived from the Node that is
 * running this script. Returns null when that Node is not part of a DSH install.
 */
function primaryRuntime() {
  const candidate = resolve(dirname(process.execPath), '..', '..', '..')
  return existsSync(join(candidate, 'dependencies')) ? candidate : null
}

function runtimeRoot() {
  const primary = primaryRuntime()
  return primary === null ? null : resolve(primary, '..')
}

/** The `dsh` launcher: override → DSH install → PATH. */
export function dshCli() {
  const root = runtimeRoot()
  return override(process.env.DSH_E2E_DSH)
    ?? (root === null ? null : firstExisting([
      join(root, 'cli', 'bin', 'dsh.cmd'),
      join(root, 'cli', 'bin', 'dsh'),
    ]))
    ?? 'dsh'
}

/** The pnpm that ships with DSH, or null when this is not a DSH runtime. */
export function dshPnpm() {
  const primary = primaryRuntime()
  return override(process.env.DSH_E2E_PNPM)
    ?? (primary === null ? null : firstExisting([join(primary, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')]))
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
