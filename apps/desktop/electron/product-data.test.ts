import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { legacyHermesHomeCandidates, resolveProductHome } from './product-data'

test('new Windows installs use a side-by-side Nox data root', () => {
  assert.equal(
    resolveProductHome({
      env: { HERMES_HOME: 'C:\\Users\\test\\.hermes' },
      homeDir: 'C:\\Users\\test',
      localAppData: 'C:\\Users\\test\\AppData\\Local',
      pathModule: path.win32,
      platform: 'win32'
    }),
    'C:\\Users\\test\\AppData\\Local\\nox'
  )
})

test('new POSIX installs use a side-by-side Nox data root', () => {
  assert.equal(
    resolveProductHome({
      env: { HERMES_HOME: '/Users/test/.hermes' },
      homeDir: '/Users/test',
      pathModule: path.posix,
      platform: 'darwin'
    }),
    '/Users/test/.nox'
  )
})

test('NOX_HOME is the explicit product data override', () => {
  assert.equal(
    resolveProductHome({
      env: { NOX_HOME: 'D:\\Nox Data' },
      homeDir: 'C:\\Users\\test',
      localAppData: 'C:\\Users\\test\\AppData\\Local',
      pathModule: path.win32,
      platform: 'win32'
    }),
    'D:\\Nox Data'
  )
})

test('desktop test sandboxes keep product data below the user-data override', () => {
  assert.equal(
    resolveProductHome({
      env: {},
      homeDir: '/Users/test',
      pathModule: path.posix,
      platform: 'linux',
      userDataOverride: '/tmp/nox-desktop-test'
    }),
    '/tmp/nox-desktop-test/nox-home'
  )
})

test('legacy Hermes roots are discoverable without becoming defaults', () => {
  assert.deepEqual(
    legacyHermesHomeCandidates({
      homeDir: 'C:\\Users\\test',
      localAppData: 'C:\\Users\\test\\AppData\\Local',
      pathModule: path.win32,
      platform: 'win32'
    }),
    ['C:\\Users\\test\\AppData\\Local\\hermes', 'C:\\Users\\test\\.hermes']
  )
})
