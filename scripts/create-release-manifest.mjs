import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ALLOWED_EXTENSIONS = new Set(['.dmg', '.exe', '.yml', '.yaml', '.blockmap'])

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Release input cannot contain symlinks: ${path}`)
    if (entry.isDirectory()) return walk(path)
    if (!entry.isFile()) throw new Error(`Unsupported release input: ${path}`)
    return [path]
  })

export const createReleaseManifest = (inputDirectory, outputDirectory, metadata) => {
  const input = resolve(inputDirectory)
  const output = resolve(outputDirectory)
  const files = walk(input)
    .filter((path) => {
      const name = basename(path)
      return [...ALLOWED_EXTENSIONS].some((extension) => name.endsWith(extension))
    })
    .sort((left, right) => left.localeCompare(right))
  if (files.length === 0) throw new Error('No release artifacts found')
  const artifacts = files.map((path) => {
    const stats = lstatSync(path)
    return {
      name: relative(input, path).replaceAll('\\', '/'),
      size: stats.size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    }
  })
  const manifest = {
    schemaVersion: 1,
    version: metadata.version,
    gitCommit: metadata.gitCommit,
    createdAt: metadata.createdAt,
    artifacts,
  }
  writeFileSync(join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  writeFileSync(
    join(output, 'SHA256SUMS'),
    `${artifacts.map(({ sha256, name }) => `${sha256}  ${name}`).join('\n')}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
  return manifest
}

const run = () => {
  const inputDirectory = process.argv[2]
  const outputDirectory = process.argv[3]
  const version = process.env.RELEASE_VERSION
  const gitCommit = process.env.GITHUB_SHA
  if (
    inputDirectory === undefined ||
    outputDirectory === undefined ||
    version === undefined ||
    gitCommit === undefined
  ) {
    throw new Error(
      'Usage: RELEASE_VERSION=<version> GITHUB_SHA=<commit> node scripts/create-release-manifest.mjs <input> <output>',
    )
  }
  createReleaseManifest(inputDirectory, outputDirectory, {
    version,
    gitCommit,
    createdAt: new Date().toISOString(),
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) run()
