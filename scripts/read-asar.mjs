/**
 * Read a file out of an Electron asar archive with the bundled Node runtime.
 * Used only to inspect shipped package sources while developing a plugin.
 *
 * Usage: node scripts/read-asar.mjs <asar> <entry-substring> [outFile]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [, , archive, needle, outFile] = process.argv
if (!archive || !needle) {
  console.error('usage: node scripts/read-asar.mjs <asar> <entry-substring> [outFile]')
  process.exit(2)
}

const buffer = readFileSync(archive)
// Chromium Pickle: u32 pickleSize@0, u32 jsonSize@4, u32 headerSize@8, u32 jsonSize@12.
const jsonSize = buffer.readUInt32LE(12)
const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'))
const dataStart = 16 + jsonSize

function* walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix.length === 0 ? name : `${prefix}/${name}`
    if (entry.files) yield* walk(entry, path)
    else yield { path, size: entry.size, offset: Number(entry.offset), unpacked: entry.unpacked === true }
  }
}

let found = 0
for (const entry of walk(header, '')) {
  if (!entry.path.includes(needle) || entry.unpacked) continue
  const bytes = buffer.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size)
  if (outFile) {
    writeFileSync(outFile, bytes)
    console.log(`wrote ${entry.path} (${entry.size} bytes) -> ${outFile}`)
  } else {
    process.stdout.write(bytes)
  }
  found += 1
}
if (found === 0) {
  console.error(`no entry matched ${JSON.stringify(needle)}`)
  process.exit(1)
}
