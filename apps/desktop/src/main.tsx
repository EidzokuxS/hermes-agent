import '@vscode/codicons/dist/codicon.css'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { NoxShell } from './app/nox-shell.js'

const root = document.getElementById('root')
if (root === null) {
  throw new Error('Nox Desktop root is missing')
}
createRoot(root).render(
  <StrictMode>
    <NoxShell />
  </StrictMode>
)
