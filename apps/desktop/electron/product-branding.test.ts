import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PRODUCT_APP_ID, PRODUCT_NAME, PRODUCT_PROTOCOL } from './product'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))

test('desktop packaging uses the Nox product identity', () => {
  assert.equal(packageJson.productName, 'Nox')
  assert.equal(packageJson.build.appId, PRODUCT_APP_ID)
  assert.equal(packageJson.build.productName, PRODUCT_NAME)
  assert.equal(packageJson.build.executableName, PRODUCT_NAME)
  assert.equal(packageJson.build.artifactName, 'Nox-${version}-${os}-${arch}.${ext}')
  assert.equal(packageJson.build.icon, 'assets/icon.png')
  assert.deepEqual(packageJson.build.protocols, [{ name: 'Nox Protocol', schemes: [PRODUCT_PROTOCOL] }])
})

test('desktop ships only product-owned brand assets', () => {
  assert.equal(existsSync(path.join(desktopRoot, 'assets', 'icon.png')), true)
  assert.equal(existsSync(path.join(desktopRoot, 'assets', 'icon.ico')), true)
  assert.equal(existsSync(path.join(desktopRoot, 'public', 'nox-mark.svg')), true)
  assert.equal(existsSync(path.join(desktopRoot, 'public', 'apple-touch-icon.png')), true)

  for (const relativePath of [
    'assets/icon.icns',
    'public/hermes-frames',
    'public/hermes-sprite.png',
    'public/hermes.png',
    'public/nous-girl.jpg'
  ]) {
    assert.equal(existsSync(path.join(desktopRoot, relativePath)), false, relativePath)
  }
})
