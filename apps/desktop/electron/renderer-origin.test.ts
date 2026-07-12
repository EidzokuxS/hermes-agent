import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isTrustedRendererUrl, resolveDevelopmentUrl } from './renderer-origin.js'

describe('Desktop renderer origin fence', () => {
  it('allows only the expected loopback development origin', () => {
    expect(resolveDevelopmentUrl('http://127.0.0.1:5174/')).toBe('http://127.0.0.1:5174/')
    expect(resolveDevelopmentUrl('http://localhost:5174/nox')).toBe('http://localhost:5174/nox')
    expect(() => resolveDevelopmentUrl('https://127.0.0.1:5174/')).toThrow('expected loopback origin')
    expect(() => resolveDevelopmentUrl('http://example.test:5174/')).toThrow('expected loopback origin')
    expect(() => resolveDevelopmentUrl('http://127.0.0.1:5173/')).toThrow('expected loopback origin')
  })

  it('binds IPC senders to the selected renderer entry', () => {
    const rendererFile = path.resolve('dist/renderer/index.html')
    expect(isTrustedRendererUrl(pathToFileURL(rendererFile).href, undefined, rendererFile)).toBe(true)
    expect(isTrustedRendererUrl(pathToFileURL(path.resolve('other.html')).href, undefined, rendererFile)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5174/nox', 'http://localhost:5174/', rendererFile)).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:5174/nox', 'http://localhost:5174/', rendererFile)).toBe(false)
  })
})
