export default [
  {
    test: {
      include: ['test/**/*.test.ts'],
      name: 'protocol',
      root: 'packages/protocol'
    }
  },
  {
    test: {
      include: ['test/**/*.test.ts'],
      name: 'runtime',
      root: 'packages/runtime'
    }
  },
  {
    test: {
      include: ['test/**/*.test.ts'],
      name: 'store-sqlite',
      root: 'packages/store-sqlite'
    }
  },
  {
    test: {
      include: ['test/**/*.test.ts'],
      name: 'cortex-pi',
      root: 'packages/cortex-pi'
    }
  },
  {
    test: {
      include: ['test/**/*.test.ts'],
      name: 'interface-rpc',
      root: 'packages/interface-rpc'
    }
  },
  {
    test: {
      include: ['test/**/*.test.ts'],
      name: 'audit',
      root: 'apps/audit'
    }
  },
  {
    test: {
      include: ['test/**/*.test.ts'],
      name: 'desktop',
      root: 'apps/desktop'
    }
  },
  {
    test: {
      include: ['tests/**/*.test.ts'],
      name: 'foundation',
      root: '.'
    }
  }
]
