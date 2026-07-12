import { describe, expect, it } from 'vitest'

import { checkKillCriteria } from '../../scripts/check-kill-criteria.mjs'

describe('kill-criteria executable-source contract', () => {
  it('reports both the five-entrypoint graph and dormant files in the declared text-scan scope', async () => {
    const report = await checkKillCriteria()
    expect(report.entrypoints).toEqual([
      'apps/desktop/electron/main.ts',
      'apps/desktop/electron/preload.cts',
      'apps/desktop/src/main.tsx',
      'apps/runtime/src/main.ts',
      'apps/audit/src/main.ts'
    ])
    expect(report.scannedRoots).toEqual(['apps/*/src/**', 'apps/desktop/electron/**', 'packages/*/src/**'])
    expect(report.productionGraph.reachableFiles).not.toContain('apps/desktop/src/themes/color.ts')
    expect(report.textScan.files).toContain('apps/desktop/src/themes/color.ts')
    expect(report.textScan.excludedFiles).toContain('packages/testkit/src/runtime-child-main.ts')
    expect(report.rules.every(rule => rule.count === rule.matches.length && rule.pass)).toBe(true)
    expect(report.status).toBe('pass')
  })
})
