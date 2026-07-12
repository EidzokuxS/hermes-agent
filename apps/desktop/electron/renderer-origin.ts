import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveDevelopmentUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined
  }
  const url = new URL(raw)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'http:' || !loopback || url.port !== '5174' || url.username || url.password) {
    throw new Error('NOX_DESKTOP_DEV_URL must use the expected loopback origin on port 5174')
  }
  return url.href
}

export function isTrustedRendererUrl(
  sender: string,
  developmentUrl: string | undefined,
  rendererFile: string
): boolean {
  try {
    const senderUrl = new URL(sender)
    if (developmentUrl !== undefined) {
      return senderUrl.origin === new URL(developmentUrl).origin
    }
    return senderUrl.protocol === 'file:' && path.resolve(fileURLToPath(senderUrl)) === path.resolve(rendererFile)
  } catch {
    return false
  }
}
