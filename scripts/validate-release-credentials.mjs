import { pathToFileURL } from 'node:url'

const hasValue = (environment, name) => {
  const value = environment[name]
  return typeof value === 'string' && value.trim() !== ''
}

export const validateMacReleaseEnvironment = (environment) => {
  const missing = []
  if (!hasValue(environment, 'CSC_LINK')) missing.push('CSC_LINK')
  if (!hasValue(environment, 'CSC_KEY_PASSWORD')) missing.push('CSC_KEY_PASSWORD')

  const hasApiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every((name) =>
    hasValue(environment, name),
  )
  const hasAppleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every((name) =>
    hasValue(environment, name),
  )
  if (!hasApiKey && !hasAppleId) {
    missing.push(
      'APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID',
    )
  }
  return missing
}

export const validateWindowsReleaseEnvironment = (environment) => {
  const missing = []
  if (!hasValue(environment, 'CSC_LINK') && !hasValue(environment, 'WIN_CSC_LINK')) {
    missing.push('WIN_CSC_LINK or CSC_LINK')
  }
  if (
    !hasValue(environment, 'CSC_KEY_PASSWORD') &&
    !hasValue(environment, 'WIN_CSC_KEY_PASSWORD')
  ) {
    missing.push('WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD')
  }
  if (!hasValue(environment, 'WIN_CSC_NAME')) missing.push('WIN_CSC_NAME')
  return missing
}

const run = () => {
  const platform = process.argv[2]
  const missing =
    platform === 'mac'
      ? validateMacReleaseEnvironment(process.env)
      : platform === 'windows'
        ? validateWindowsReleaseEnvironment(process.env)
        : null
  if (missing === null) {
    throw new Error('Usage: node scripts/validate-release-credentials.mjs <mac|windows>')
  }
  if (missing.length > 0) {
    throw new Error(`Missing release credentials: ${missing.join(', ')}`)
  }
  process.stdout.write(`${platform} release credential names are present.\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) run()
