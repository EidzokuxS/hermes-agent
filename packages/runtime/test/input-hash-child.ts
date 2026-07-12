import { buildCortexInput } from '../src/index.js'

import { createInputOptions } from './support/fixtures.js'

process.stdout.write(buildCortexInput(createInputOptions()).inputHash)
