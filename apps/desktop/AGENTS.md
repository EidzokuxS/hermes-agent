# Hermes Desktop Boundary

- This directory is the only production Electron Desktop for Nox on Hermes.
- Electron main may launch the Hermes backend through `hermes serve` or its documented `hermes_cli.main` / legacy headless compatibility form only.
- Do not import, invoke, or spawn `apps/runtime`, any `@nox/*` runtime package, or `packages/testkit` from Electron, preload, renderer, build, or packaging entrypoints.
- Preserve Hermes session, tool, gateway, update, install, profile, provider, and UX behavior unless an accepted Nox invariant documents a bounded change.
- Keep the stable identity tier out of renderer state. Identity belongs in the backend prompt assembly seam and remains closed until its revision hash is separately accepted.
- Keep Desktop stores and transcripts as projections of Hermes operational state; do not create another operational database here.
- Use temporary `HERMES_HOME` and user-data directories for Desktop tests. Do not reinstall or mutate the user's normal Hermes profile during validation.
