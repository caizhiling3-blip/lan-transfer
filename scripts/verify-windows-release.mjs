import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const POWERSHELL_SIGNATURE_COMMAND = `
$signature = Get-AuthenticodeSignature -LiteralPath $args[0]
[PSCustomObject]@{
  Status = [string]$signature.Status
  Subject = if ($null -eq $signature.SignerCertificate) { '' } else { [string]$signature.SignerCertificate.Subject }
} | ConvertTo-Json -Compress
`

const requireExecutable = (inputPath) => {
  const artifactPath = resolve(inputPath)
  const stats = lstatSync(artifactPath)
  if (stats.isSymbolicLink() || !stats.isFile() || extname(artifactPath).toLowerCase() !== '.exe') {
    throw new Error(`Expected a regular .exe release artifact: ${artifactPath}`)
  }
  return artifactPath
}

export const verifyWindowsRelease = (artifactInputs, expectedPublisher) => {
  if (process.platform !== 'win32') {
    throw new Error('Windows release verification requires Windows')
  }
  if (expectedPublisher.trim() === '') throw new Error('WIN_CSC_NAME is required')
  return artifactInputs.map((inputPath) => {
    const artifactPath = requireExecutable(inputPath)
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SIGNATURE_COMMAND, artifactPath],
      { encoding: 'utf8' },
    )
    const signature = JSON.parse(output)
    if (
      typeof signature !== 'object' ||
      signature === null ||
      signature.Status !== 'Valid' ||
      typeof signature.Subject !== 'string' ||
      !signature.Subject.includes(expectedPublisher)
    ) {
      throw new Error(`Authenticode verification failed for ${artifactPath}`)
    }
    const sha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
    return { artifactPath, sha256, subject: signature.Subject }
  })
}

const run = () => {
  const artifactPaths = process.argv.slice(2)
  const expectedPublisher = process.env.WIN_CSC_NAME
  if (artifactPaths.length === 0 || expectedPublisher === undefined) {
    throw new Error(
      'Usage: WIN_CSC_NAME=<publisher> node scripts/verify-windows-release.mjs <exe>...',
    )
  }
  for (const result of verifyWindowsRelease(artifactPaths, expectedPublisher)) {
    process.stdout.write(`${result.sha256}  ${result.artifactPath}\n`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) run()
