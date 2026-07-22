import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const UNUSED_PRIVACY_KEYS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
]

/**
 * Keep the packaged macOS privacy surface aligned with features that 邻渡 actually uses.
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appBundles = readdirSync(context.appOutDir).filter((name) => name.endsWith('.app'))

  if (appBundles.length !== 1) {
    throw new Error(`Expected one macOS app bundle, found ${appBundles.length}`)
  }

  const appBundle = appBundles[0]
  if (appBundle === undefined) {
    throw new Error('macOS app bundle is missing')
  }

  const infoPlist = join(context.appOutDir, appBundle, 'Contents', 'Info.plist')

  execFileSync(
    '/usr/bin/plutil',
    ['-replace', 'NSAppTransportSecurity.NSAllowsArbitraryLoads', '-bool', 'NO', infoPlist],
    { stdio: 'inherit' },
  )

  removeOptionalPlistKey(infoPlist, 'NSAppTransportSecurity.NSExceptionDomains')

  for (const key of UNUSED_PRIVACY_KEYS) {
    removeOptionalPlistKey(infoPlist, key)
  }
}

function removeOptionalPlistKey(infoPlist, key) {
  const result = spawnSync('/usr/bin/plutil', ['-remove', key, infoPlist], {
    encoding: 'utf8',
  })

  if (result.error !== undefined) {
    throw result.error
  }
}
