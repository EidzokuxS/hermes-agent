import { readFileSync } from 'node:fs'

import { canonicalHash } from '../src/index.js'

const fixturePath = process.argv[2]
if (fixturePath === undefined) {
  throw new Error('Fixture path is required')
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown
process.stdout.write(canonicalHash(fixture))
