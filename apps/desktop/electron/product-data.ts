import path from 'node:path'

export interface ProductHomeOptions {
  env?: Record<string, string | undefined>
  homeDir: string
  localAppData?: string
  pathModule?: typeof path.posix | typeof path.win32
  platform?: NodeJS.Platform
  userDataOverride?: string
}

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Resolve the product-owned data root passed to the Nox backend as
 * HERMES_HOME. Nox defaults are side-by-side with Nox and never select a
 * legacy Nox directory merely because it exists.
 */
export function resolveProductHome({
  env = process.env,
  homeDir,
  localAppData,
  pathModule,
  platform = process.platform,
  userDataOverride
}: ProductHomeOptions): string {
  const paths = pathModule ?? platformPath(platform)
  const explicitHome = String(env.NOX_HOME || '').trim()

  if (explicitHome) {
    return paths.resolve(explicitHome)
  }

  if (userDataOverride) {
    return paths.join(paths.resolve(userDataOverride), 'nox-home')
  }

  if (platform === 'win32' && localAppData) {
    return paths.join(localAppData, 'nox')
  }

  return paths.join(homeDir, '.nox')
}

/** Candidate legacy roots are reported for an explicit future import flow. */
export function legacyHermesHomeCandidates({
  homeDir,
  localAppData,
  pathModule,
  platform = process.platform
}: Omit<ProductHomeOptions, 'env' | 'userDataOverride'>): string[] {
  const paths = pathModule ?? platformPath(platform)
  const candidates = [paths.join(homeDir, '.hermes')]

  if (platform === 'win32' && localAppData) {
    candidates.unshift(paths.join(localAppData, 'hermes'))
  }

  return [...new Set(candidates)]
}
