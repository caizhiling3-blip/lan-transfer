export interface ReleaseManifestMetadata {
  readonly version: string
  readonly gitCommit: string
  readonly createdAt: string
}

export interface ReleaseManifest {
  readonly schemaVersion: 1
  readonly version: string
  readonly gitCommit: string
  readonly createdAt: string
  readonly artifacts: readonly {
    readonly name: string
    readonly size: number
    readonly sha256: string
  }[]
}

export function createReleaseManifest(
  inputDirectory: string,
  outputDirectory: string,
  metadata: ReleaseManifestMetadata,
): ReleaseManifest
