import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const verifyReleaseVersion = (tag, packageVersion) => {
  if (tag !== `v${packageVersion}`) {
    throw new Error(`Release tag ${tag} does not match package version ${packageVersion}`)
  }
}

const run = () => {
  const tag = process.argv[2]
  if (tag === undefined) throw new Error('Usage: node scripts/verify-release-version.mjs <tag>')
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  if (typeof packageJson.version !== 'string') throw new Error('package.json version is invalid')
  verifyReleaseVersion(tag, packageJson.version)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) run()
