import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const requireRegularArtifact = (inputPath, extension) => {
  const artifactPath = resolve(inputPath)
  const stats = lstatSync(artifactPath)
  if (stats.isSymbolicLink())
    throw new Error(`Release artifact cannot be a symlink: ${artifactPath}`)
  if (extension === '.app' ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(`Release artifact has an unexpected type: ${artifactPath}`)
  }
  if (extname(artifactPath) !== extension) {
    throw new Error(`Expected a ${extension} artifact: ${artifactPath}`)
  }
  return artifactPath
}

export const verifyMacRelease = (appPathInput, dmgPathInput) => {
  if (process.platform !== 'darwin') throw new Error('macOS release verification requires macOS')
  const appPath = requireRegularArtifact(appPathInput, '.app')
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit',
  })
  execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], {
    stdio: 'inherit',
  })
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' })

  if (dmgPathInput !== undefined) {
    const dmgPath = requireRegularArtifact(dmgPathInput, '.dmg')
    execFileSync('/usr/bin/xcrun', ['stapler', 'validate', dmgPath], { stdio: 'inherit' })
    execFileSync(
      '/usr/sbin/spctl',
      [
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '--verbose=2',
        dmgPath,
      ],
      { stdio: 'inherit' },
    )
  }
}

const run = () => {
  const appPath = process.argv[2]
  if (appPath === undefined) {
    throw new Error('Usage: node scripts/verify-macos-release.mjs <app-path> [dmg-path]')
  }
  verifyMacRelease(appPath, process.argv[3])
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) run()
