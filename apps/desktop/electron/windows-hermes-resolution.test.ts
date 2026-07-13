// Regression guards for Windows `hermes` resolution in main.ts.
//
// main.ts has no module.exports, so these follow the repo's source-assertion
// test pattern (see windows-child-process.test.ts). They pin the two Windows
// resolution bugs that caused desktop reinstall loops:
//   1. findOnPath() tried the empty extension FIRST, so an extensionless
//      Git-Bash `hermes` shim shadowed the real hermes.cmd/hermes.exe; the
//      shim then failed the --version probe and the desktop fell through to a
//      spurious bootstrap/repair.
//   2. handOffWindowsBootstrapRecovery() chose --update vs the destructive
//      --repair by checking ONLY venv\Scripts\hermes.exe (the console-script
//      shim, written at the END of venv setup and absent in interrupted
//      states), so it escalated to a full venv recreate even on healthy
//      installs.
//   3. unwrapWindowsVenvHermesCommand() returned the venv python with NO
//      runtime probe (bypassing the caller's --version check too), so a venv
//      broken mid-update (e.g. missing python-dotenv) was re-selected forever:
//      Retry / "Repair install" resolved the same dead interpreter instead of
//      falling through to the bootstrap installer.
//   4. Packaged Nox reused an unmanaged Hermes CLI from PATH when its own
//      side-by-side runtime was absent, bypassing the accepted Nox identity.
//   5. A successful bootstrap immediately recursed into another bootstrap
//      when the newly installed runtime still failed its readiness probe.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function readMain() {
  return fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8').replace(/\r\n/g, '\n')
}

test('findOnPath tries PATHEXT extensions before the bare (empty) name on Windows', () => {
  const source = readMain()
  // Fixed order: PATHEXT first, empty string LAST.
  assert.match(
    source,
    /\(process\.env\.PATHEXT \|\| '\.COM;\.EXE;\.BAT;\.CMD'\)\.split\(';'\)\.filter\(Boolean\), ''\]/,
    'extensions array must end with the empty string, not start with it'
  )
  // The buggy empty-first order must not return.
  assert.doesNotMatch(
    source,
    /\['', \.\.\.\(process\.env\.PATHEXT/,
    'empty-extension-first order regressed: an extensionless shim can shadow hermes.cmd/.exe'
  )
})

test('Windows bootstrap recovery chooses --update when any real-install signal is present', () => {
  const source = readMain()
  assert.match(source, /const haveRealInstall =/, 'recovery must compute haveRealInstall')
  assert.match(source, /fileExists\(venvPython\)/, 'recovery must accept the venv interpreter as a real-install signal')
  assert.match(
    source,
    /\.hermes-bootstrap-complete/,
    'recovery must accept the bootstrap-complete marker as a real-install signal'
  )
  assert.match(source, /updaterArgs = haveRealInstall \? \['--update'/, 'updaterArgs must gate on haveRealInstall')
  // The old too-narrow check (only venv\Scripts\hermes.exe) must not return.
  assert.doesNotMatch(
    source,
    /updaterArgs = fileExists\(venvHermes\) \?/,
    'recovery regressed to gating only on the hermes.exe shim, which forces destructive --repair'
  )
})

test('unwrapWindowsVenvHermesCommand smoke-tests the venv python before trusting it', () => {
  const source = readMain()
  const fnStart = source.indexOf('function unwrapWindowsVenvHermesCommand(')
  assert.notEqual(fnStart, -1, 'unwrapWindowsVenvHermesCommand must exist in main.ts')
  // Slice out just the function body (up to the next top-level function decl)
  const fnEnd = source.indexOf('\nfunction ', fnStart + 1)
  const body = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
  assert.match(
    body,
    /canImportHermesCli\(python/,
    'unwrap must probe the venv interpreter; returning it unprobed re-selects a broken venv ' +
      'forever (Retry/Repair loop on a mid-update venv missing e.g. python-dotenv)'
  )
  assert.match(
    body,
    /return null\s*\n\s*\}\s*\n\s*return \{/,
    'a failed probe must fall through (return null) so the resolver reaches the bootstrap rung'
  )
})

test('packaged Nox requires its product-owned runtime and accepted identity', () => {
  const source = readMain()
  const usableStart = source.indexOf('function isActiveRuntimeUsable(')
  const usableEnd = source.indexOf('\nfunction ', usableStart + 1)
  const usableBody = source.slice(usableStart, usableEnd === -1 ? undefined : usableEnd)

  assert.match(
    usableBody,
    /canImportNoxRuntime\(venvPython/,
    'the product-owned runtime probe must validate nox.identity, not only hermes_cli'
  )

  const resolverStart = source.indexOf('function resolveHermesBackend(')
  const resolverEnd = source.indexOf('\nasync function ', resolverStart + 1)
  const resolverBody = source.slice(resolverStart, resolverEnd === -1 ? undefined : resolverEnd)

  assert.match(
    resolverBody,
    /shouldUseUnmanagedRuntime\(\{[\s\S]*?isPackaged: IS_PACKAGED[\s\S]*?\}\)/,
    'the resolver must apply the packaged product boundary before considering PATH or system Python'
  )
  assert.match(
    resolverBody,
    /const python = useUnmanagedRuntime \? findSystemPython\(\) : null/,
    'system Python must be unreachable when packaged Nox owns the runtime'
  )
})

test('a completed bootstrap cannot recurse into another automatic install', () => {
  const source = readMain()
  const ensureStart = source.indexOf('async function ensureRuntime(')
  const ensureEnd = source.indexOf('\nfunction ', ensureStart + 1)
  const ensureBody = source.slice(ensureStart, ensureEnd === -1 ? undefined : ensureEnd)

  assert.match(
    ensureBody,
    /installedBackend\.kind === 'bootstrap-needed'/,
    'bootstrap must detect a runtime that still fails readiness'
  )
  assert.match(
    ensureBody,
    /installation completed, but its runtime did not pass the readiness check/,
    'the failed post-install readiness check must surface a stable recovery error'
  )
  assert.doesNotMatch(
    ensureBody,
    /return ensureRuntime\(resolveHermesBackend\(backend\.args\)\)/,
    'a successful install must not recurse directly into another automatic bootstrap'
  )
})
