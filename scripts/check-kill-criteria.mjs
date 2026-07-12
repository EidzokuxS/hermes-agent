import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entrypoints = [
  'apps/desktop/electron/main.ts',
  'apps/desktop/electron/preload.cts',
  'apps/desktop/src/main.tsx',
  'apps/runtime/src/main.ts',
  'apps/audit/src/main.ts'
]
const scannedRoots = ['apps/*/src/**', 'apps/desktop/electron/**', 'packages/*/src/**']
const declaredExclusions = [
  'packages/testkit/**',
  'tests/**',
  '**/*.test.ts',
  'docs/**',
  'artifacts/**',
  'docs/upstream/** (donor provenance manifests)',
  'scripts/check-kill-criteria.mjs'
]
const workspacePackages = new Map([
  ['@nox/cortex-pi', 'packages/cortex-pi/src/index.ts'],
  ['@nox/interface-rpc', 'packages/interface-rpc/src/index.ts'],
  ['@nox/protocol', 'packages/protocol/src/index.ts'],
  ['@nox/runtime', 'packages/runtime/src/index.ts'],
  ['@nox/store-sqlite', 'packages/store-sqlite/src/index.ts'],
  ['@nox/testkit', 'packages/testkit/src/index.ts']
])

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/')
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function exists(file) {
  return Boolean(await stat(file).catch(() => undefined))
}

function importSpecifiers(source) {
  const specifiers = []
  const staticPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g
  const dynamicPattern = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const pattern of [staticPattern, dynamicPattern, requirePattern]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1])
    }
  }
  return [...new Set(specifiers)]
}

async function resolveInternal(importer, specifier) {
  if (workspacePackages.has(specifier)) return path.join(root, workspacePackages.get(specifier))
  if (!specifier.startsWith('.')) return undefined
  const unresolved = path.resolve(path.dirname(importer), specifier)
  const candidates = [unresolved]
  if (specifier.endsWith('.js')) {
    const stem = unresolved.slice(0, -3)
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.cts`, `${stem}.mts`)
  }
  candidates.push(`${unresolved}.ts`, `${unresolved}.tsx`, `${unresolved}.cts`, path.join(unresolved, 'index.ts'))
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  return null
}

async function traverseProductionGraph() {
  const queue = entrypoints.map(file => path.join(root, file))
  const visited = new Set()
  const sources = new Map()
  const edges = []
  while (queue.length > 0) {
    const file = queue.shift()
    if (!file || visited.has(file)) continue
    if (!(await exists(file))) {
      edges.push({ from: '<entrypoint>', specifier: relative(file), status: 'missing' })
      continue
    }
    visited.add(file)
    const source = await readFile(file, 'utf8')
    sources.set(file, source)
    for (const specifier of importSpecifiers(source)) {
      const resolved = await resolveInternal(file, specifier)
      if (resolved === null) {
        edges.push({ from: relative(file), specifier, status: 'unresolved-relative' })
      } else if (resolved === undefined) {
        edges.push({ from: relative(file), specifier, status: 'external' })
      } else {
        edges.push({ from: relative(file), specifier, status: 'internal', to: relative(resolved) })
        queue.push(resolved)
      }
    }
  }
  return { edges, sources }
}

async function visitFiles(directory, files) {
  if (!(await exists(directory))) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await visitFiles(target, files)
    else if (entry.isFile()) files.push(target)
  }
}

function isDeclaredExcluded(file) {
  return (
    file.startsWith('packages/testkit/') ||
    file.startsWith('tests/') ||
    file.endsWith('.test.ts') ||
    file.startsWith('docs/') ||
    file.startsWith('artifacts/') ||
    file === 'scripts/check-kill-criteria.mjs'
  )
}

async function executableSourceScan(reachableFiles) {
  const candidates = []
  const appsDirectory = path.join(root, 'apps')
  for (const app of await readdir(appsDirectory, { withFileTypes: true })) {
    if (app.isDirectory()) await visitFiles(path.join(appsDirectory, app.name, 'src'), candidates)
  }
  await visitFiles(path.join(root, 'apps/desktop/electron'), candidates)
  const packagesDirectory = path.join(root, 'packages')
  for (const workspacePackage of await readdir(packagesDirectory, { withFileTypes: true })) {
    if (workspacePackage.isDirectory()) {
      await visitFiles(path.join(packagesDirectory, workspacePackage.name, 'src'), candidates)
    }
  }

  const unique = [...new Set(candidates)].sort()
  const excludedFiles = []
  const sources = new Map()
  for (const file of unique) {
    const name = relative(file)
    const excluded = isDeclaredExcluded(name)
    if (excluded && !reachableFiles.has(file)) {
      excludedFiles.push(name)
      continue
    }
    sources.set(file, await readFile(file, 'utf8'))
  }
  for (const file of reachableFiles) {
    if (!sources.has(file)) sources.set(file, await readFile(file, 'utf8'))
  }
  return { excludedFiles, sources }
}

export async function checkKillCriteria() {
  const { edges, sources: reachableSources } = await traverseProductionGraph()
  const { excludedFiles, sources } = await executableSourceScan(new Set(reachableSources.keys()))
  const matches = predicate =>
    [...sources].flatMap(([file, source]) => {
      const result = predicate(source, relative(file))
      return result === undefined || result === false ? [] : [{ evidence: String(result), file: relative(file) }]
    })

  const rules = [
    {
      id: 'production-excludes-testkit',
      matches: matches(source => /@nox\/testkit|packages\/testkit/.test(source) && 'testkit import')
    },
    {
      id: 'desktop-excludes-hermes-domains',
      matches: matches((source, file) =>
        file.startsWith('apps/desktop/') && /from\s+['"][^'"]*(?:agent|gateway|session-store|hermes_cli)/i.test(source)
          ? 'donor domain import'
          : false
      )
    },
    {
      id: 'renderer-has-no-direct-websocket',
      matches: matches((source, file) =>
        file.startsWith('apps/desktop/src/') && /new\s+WebSocket\s*\(/.test(source) ? 'renderer WebSocket' : false
      )
    },
    {
      id: 'desktop-has-no-state-writer',
      matches: matches((source, file) =>
        file.startsWith('apps/desktop/') && /reduceAcceptedEffects|nextSnapshot\s*:|new\s+SqliteStore/.test(source)
          ? 'Desktop State writer primitive'
          : false
      )
    },
    {
      id: 'desktop-has-no-optimistic-delivery',
      matches: matches((source, file) => {
        if (!file.endsWith('apps/desktop/src/store/nox-view.ts')) return false
        const pending = source.match(/function recordPendingRequest[\s\S]*?\n}\n/)?.[0] ?? ''
        return /delivery:\s*'delivered'/.test(pending) ? 'pending request marked delivered' : false
      })
    },
    {
      id: 'single-production-sqlite-writer',
      matches: matches((source, file) =>
        /new\s+DatabaseSync\s*\(/.test(source) &&
        ![
          'apps/audit/src/raw-reader.ts',
          'packages/store-sqlite/src/audit-reader.ts',
          'packages/store-sqlite/src/sqlite-store.ts'
        ].includes(file)
          ? 'additional production DatabaseSync constructor'
          : false
      )
    },
    {
      id: 'pi-core-confined-to-cortex-adapter',
      matches: matches((source, file) =>
        /@earendil-works\/pi-(?:agent-core|ai)/.test(source) && !file.startsWith('packages/cortex-pi/src/')
          ? 'Pi import outside Cortex adapter'
          : false
      )
    },
    {
      id: 'production-entrypoint-graph',
      matches: edges
        .filter(edge => edge.status === 'missing' || edge.status === 'unresolved-relative')
        .map(edge => ({ evidence: `${edge.status}: ${edge.specifier}`, file: edge.from })),
      pass: false
    }
  ].map(rule => ({ ...rule, count: rule.matches.length, pass: rule.matches.length === 0 }))

  return {
    entrypoints,
    exclusions: declaredExclusions,
    productionGraph: {
      edges,
      entrypoints,
      reachableFiles: [...reachableSources.keys()].map(relative).sort()
    },
    roots: entrypoints,
    scannedRoots,
    rules,
    sourceFiles: [...sources]
      .map(([file, source]) => ({ path: relative(file), sha256: digest(source) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    textScan: {
      excludedFiles,
      files: [...sources.keys()].map(relative).sort(),
      scannedRoots
    },
    status: rules.every(rule => rule.pass) ? 'pass' : 'fail'
  }
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await checkKillCriteria()
  const output = argument('output')
  if (output) {
    const target = path.resolve(root, output)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
  if (report.status !== 'pass') process.exitCode = 1
}
