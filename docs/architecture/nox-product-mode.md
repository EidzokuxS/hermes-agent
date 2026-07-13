# Nox Product Mode

## Product boundary

Nox is the product and the continuing system presented to the user. Hermes Agent is the donor foundation and remains visible only where it is an external proper noun, such as Hermes Cloud, or where an internal module and protocol name does not affect product identity.

The desktop product contract is:

- product name and executable: `Nox`
- application ID: `dev.eidzokux.nox`
- deep-link scheme: `nox://`
- product data override: `NOX_HOME`
- Windows data home: `%LOCALAPPDATA%\nox`
- macOS and Linux data home: `~/.nox`

Internal `hermes` package names, RPC method names, backend environment variables, and Python module paths remain stable. Renaming them would add migration risk without changing what the user operates.

## Existing Hermes profiles

Nox uses a side-by-side profile policy. It never selects, moves, deletes, or mutates an existing Hermes profile because that profile exists. `HERMES_HOME` is not treated as a Nox data override.

Legacy roots may be reported as candidates for a future explicit import flow. Import must remain a separate user-confirmed operation with a preview and a destination under the Nox data home. Until that flow exists, Hermes and Nox profiles remain independent.

## Identity boundary

The gateway exposes one canonical Nox identity. The old personality selector is not a product surface and cannot rewrite a live session, conversation history, or ephemeral system prompt. `SOUL.md` may add profile-specific context without redefining Nox as a different persona.

The model is the active cortex used by Nox, not a separate product identity. Model and provider labels remain operational facts in settings and session metadata.

## Brand assets and copy

The desktop uses the product-owned Nox vector mark and derived platform icons. Legacy Hermes mascot and icon assets are not packaged. Provider names and external service names retain their original attribution.

All user-visible Nox copy belongs in the desktop localization catalog. Internal compatibility names may remain in code, logs, storage keys, and wire contracts when changing them would not improve the user experience.
