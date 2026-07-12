import { defineConfig } from 'vitest/config'

import projects from './vitest.workspace'

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects
  }
})
