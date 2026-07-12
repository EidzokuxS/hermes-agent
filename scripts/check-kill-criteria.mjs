import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const productionRoots = [
  'apps/desktop/electron',
  'apps/desktop/src',
  'apps/runtime/src',
  'packages/cortex-pi/src',
  'packages/interface-rpc/src',
  'packages/protocol/src',
  'packages/runtime/src',
  'packages/store-sqlite/src'
]
const sourceExtensions = new Set(['.cts', '.js', '.mjs', '.ts', '.tsx'])

async function filesBelow(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot)
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!['dist', 'node_modules', 'test', 'tests'].includes(entry.name)) await visit(absolute)
      } else if (sourceExtensions.has(path.extname(entry.name)) && !entry.name.includes('.test.')) {
        files.push(absolute)
      }
    }
  }
  await visit(absoluteRoot)
  return files
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/')
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function checkKillCriteria() {
  const files = (await Promise.all(productionRoots.map(filesBelow))).flat().sort()
  const sources = new Map()
  for (const file of files) sources.set(file, await readFile(file, 'utf8'))
  const matches = predicate =>
    [...sources].flatMap(([file, source]) => {
      const result = predicate(source, relative(file))
      return result === undefined || result === false ? [] : [{ file: relative(file), evidence: String(result) }]
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
        !['packages/store-sqlite/src/audit-reader.ts', 'packages/store-sqlite/src/sqlite-store.ts'].includes(file)
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
    }
  ].map(rule => ({ ...rule, pass: rule.matches.length === 0 }))

  const requiredEdges = [
    ['apps/desktop/electron/main.ts', './nox-runtime-process.js'],
    ['apps/desktop/electron/nox-runtime-process.ts', '../../../runtime/dist/main.js'],
    ['apps/runtime/src/main.ts', './create-process-host.js'],
    ['apps/runtime/src/main.ts', '@nox/runtime'],
    ['apps/runtime/src/create-process-host.ts', '@nox/interface-rpc']
  ]
  const edges = []
  for (const [file, needle] of requiredEdges) {
    const source = await readFile(path.join(root, file), 'utf8')
    edges.push({ file, needle, present: source.includes(needle) })
  }
  rules.push({
    id: 'production-entrypoint-graph',
    matches: edges.filter(edge => !edge.present).map(edge => ({ file: edge.file, evidence: `missing ${edge.needle}` })),
    pass: edges.every(edge => edge.present)
  })

  return {
    exclusions: ['**/dist/**', '**/test/**', '**/tests/**', 'packages/testkit/**'],
    productionGraph: { edges, entrypoints: ['apps/desktop/electron/main.ts', 'apps/runtime/src/main.ts'] },
    roots: productionRoots,
    rules,
    sourceFiles: files.map(file => ({ path: relative(file), sha256: digest(sources.get(file)) })),
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
