import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const SAFE_ENV_SUFFIXES = new Set(['dist', 'example', 'sample', 'template'])
const SENSITIVE_EXTENSIONS = new Set(['.kdbx', '.p12', '.pem', '.pfx'])

type IpcPathError = Error & { code: string }
type StatFs = Pick<typeof fs, 'promises'>

export function resolveTimeoutMs(timeoutMs: unknown, fallbackMs = DEFAULT_FETCH_TIMEOUT_MS): number {
  const fallback = Number.isFinite(fallbackMs) && fallbackMs > 0 ? Math.round(fallbackMs) : DEFAULT_FETCH_TIMEOUT_MS
  const parsed = Number(timeoutMs)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback
}

export function sensitiveFileBlockReason(filePath: unknown): string | null {
  const normalized = String(filePath ?? '')
    .replace(/\\/g, '/')
    .toLowerCase()
  const basename = path.basename(normalized)
  const extension = path.extname(basename)
  if (!basename) {
    return null
  }
  if (normalized.includes('/.ssh/')) {
    return 'SSH key/config files are blocked.'
  }
  if (normalized.includes('/.gnupg/')) {
    return 'GPG key material is blocked.'
  }
  if (normalized.endsWith('/.aws/credentials')) {
    return 'AWS credential files are blocked.'
  }
  if (basename === '.env') {
    return '.env files are blocked because they commonly contain secrets.'
  }
  if (basename.startsWith('.env.') && !SAFE_ENV_SUFFIXES.has(basename.slice('.env.'.length))) {
    return `${basename} is blocked because it appears to contain environment secrets.`
  }
  if (/^id_(rsa|dsa|ecdsa|ed25519)(?:\..+)?$/.test(basename) && !basename.endsWith('.pub')) {
    return 'SSH private key files are blocked.'
  }
  if (SENSITIVE_EXTENSIONS.has(extension)) {
    return `${extension} key/certificate files are blocked.`
  }
  if (basename === '.npmrc' || basename === '.netrc' || basename === '.pypirc') {
    return `${basename} is blocked because it may include auth credentials.`
  }
  return null
}

export function ipcPathError(code: string, message: string): IpcPathError {
  return Object.assign(new Error(message), { code })
}

export function rejectUnsafePathSyntax(filePath: unknown, purpose = 'File read'): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw ipcPathError('invalid-path', `${purpose} failed: file path is required.`)
  }
  const raw = filePath.trim()
  if (raw.includes('\0')) {
    throw ipcPathError('invalid-path', `${purpose} failed: file path is invalid.`)
  }
  const normalized = raw.replace(/\\/g, '/').toLowerCase()
  if (
    normalized.startsWith('//?/') ||
    normalized.startsWith('//./') ||
    normalized.startsWith('globalroot/device/') ||
    normalized.includes('/globalroot/device/')
  ) {
    throw ipcPathError('device-path', `${purpose} blocked: Windows device paths are not allowed.`)
  }
  return raw
}

export interface ResolvePathOptions {
  baseDir?: string
  purpose?: string
}

export function resolveRequestedPathForIpc(filePath: unknown, options: ResolvePathOptions = {}): string {
  const purpose = options.purpose ?? 'File read'
  let raw = rejectUnsafePathSyntax(filePath, purpose)
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(1))
  }
  if (/^file:/i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (parsed.protocol !== 'file:') {
        throw new Error('not a file URL')
      }
      return path.resolve(rejectUnsafePathSyntax(fileURLToPath(parsed), purpose))
    } catch {
      throw ipcPathError('invalid-path', `${purpose} failed: file URL is invalid.`)
    }
  }
  const base = rejectUnsafePathSyntax(options.baseDir ?? process.cwd(), purpose)
  return path.resolve(path.resolve(base), raw)
}

export async function statForIpc(fsImpl: StatFs, resolvedPath: string, purpose: string, typeLabel: string) {
  try {
    return await fsImpl.promises.stat(resolvedPath)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'read-error'
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw ipcPathError(code, `${purpose} failed: ${typeLabel} does not exist.`)
    }
    throw ipcPathError(code, `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function realpathForIpc(fsImpl: StatFs, resolvedPath: string, purpose: string): Promise<string> {
  try {
    const realPath = await fsImpl.promises.realpath(resolvedPath)
    return rejectUnsafePathSyntax(realPath, purpose)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'read-error'
    throw ipcPathError(code, `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function rejectSensitiveFilePath(filePath: string, purpose: string): void {
  const reason = sensitiveFileBlockReason(filePath)
  if (reason) {
    throw ipcPathError('sensitive-file', `${purpose} blocked for sensitive file: ${reason}`)
  }
}

export async function resolveDirectoryForIpc(
  directoryPath: unknown,
  options: ResolvePathOptions & { fs?: StatFs } = {}
) {
  const purpose = options.purpose ?? 'Directory read'
  const fsImpl = options.fs ?? fs
  const resolvedPath = resolveRequestedPathForIpc(directoryPath, options)
  const stat = await statForIpc(fsImpl, resolvedPath, purpose, 'directory')
  if (!stat.isDirectory()) {
    throw ipcPathError('ENOTDIR', `${purpose} failed: path is not a directory.`)
  }
  return { realPath: await realpathForIpc(fsImpl, resolvedPath, purpose), resolvedPath, stat }
}

export async function resolveReadableFileForIpc(
  filePath: unknown,
  options: ResolvePathOptions & { blockSensitive?: boolean; fs?: typeof fs; maxBytes?: number } = {}
) {
  const purpose = options.purpose ?? 'File read'
  const fsImpl = options.fs ?? fs
  const resolvedPath = resolveRequestedPathForIpc(filePath, options)
  if (options.blockSensitive !== false) {
    rejectSensitiveFilePath(resolvedPath, purpose)
  }
  const stat = await statForIpc(fsImpl, resolvedPath, purpose, 'file')
  if (stat.isDirectory()) {
    throw ipcPathError('EISDIR', `${purpose} failed: path points to a directory.`)
  }
  if (!stat.isFile()) {
    throw ipcPathError('EINVAL', `${purpose} failed: only regular files can be read.`)
  }
  const realPath = await realpathForIpc(fsImpl, resolvedPath, purpose)
  if (options.blockSensitive !== false) {
    rejectSensitiveFilePath(realPath, purpose)
  }
  if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
    throw ipcPathError(
      'EFBIG',
      `${purpose} failed: file is too large (${stat.size} bytes; limit ${options.maxBytes} bytes).`
    )
  }
  try {
    await fsImpl.promises.access(resolvedPath, fs.constants.R_OK)
  } catch {
    throw ipcPathError('EACCES', `${purpose} failed: file is not readable.`)
  }
  return { realPath, resolvedPath, stat }
}
