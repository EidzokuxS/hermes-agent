# Nox product mode evidence

Captured on 2026-07-13 for Task 5 of the accepted Hermes Foundation migration.

## Product contract

- The visible application, executable, protocol, package artifacts and Windows version resources are named `Nox`.
- New Windows installs use `%LOCALAPPDATA%\nox`; new POSIX installs use `~/.nox`. `NOX_HOME` is the only explicit product-home override.
- Existing `.hermes` and platform Hermes roots are import candidates only. Nox never selects, moves or deletes them implicitly.
- The operational backend still receives its established internal `HERMES_HOME` contract with the resolved Nox home. Internal Hermes RPC and TypeScript names remain unchanged where a rename would add no user value.
- User-facing identity is Nox. `Hermes Cloud` remains unchanged because it names an external service, and Hermes Agent remains in package attribution.
- Desktop personality selection is absent. The gateway returns one immutable Nox identity status for legacy personality calls, and session compatibility fields remain empty.

The full side-by-side and rollback policy is in `docs/architecture/nox-product-mode.md`.

## Data-path matrix

| Case | Before | After | Mutation | Rollback |
| --- | --- | --- | --- | --- |
| Fresh Windows install | no product home | `%LOCALAPPDATA%\nox` | create Nox-owned files only | remove the Nox installation; Hermes data is untouched |
| Fresh POSIX install | no product home | `~/.nox` | create Nox-owned files only | remove the Nox installation; Hermes data is untouched |
| Explicit product home | caller-owned path | `NOX_HOME` | use only the explicit path | unset `NOX_HOME` |
| Desktop test sandbox | isolated Electron user-data directory | `<userData>/nox-home` | write below the sandbox only | remove the sandbox |
| Existing Hermes profile | `.hermes` or platform Hermes root | unchanged and not selected | none | not required |
| Future explicit import | Hermes source plus Nox destination | not implemented in Task 5 | no silent copy, move or delete | source remains authoritative until a separately accepted import exists |

Five unit cases exercise Windows, POSIX, explicit override, sandbox and legacy-candidate discovery.

## Branding and package provenance

The product-owned mark is `apps/desktop/public/nox-mark.svg`. Windows PNG/ICO and the touch icon are derived from that mark. The packaged ASAR contains `nox-mark.svg` and `apple-touch-icon.png` and contains none of the removed donor assets:

- `assets/icon.icns`
- `public/hermes-frames/**`
- `public/hermes-sprite.png`
- `public/hermes.png`
- `public/nous-girl.jpg`

The unpacked Windows package is `apps/desktop/release-qa/win-unpacked/Nox.exe`. Its PE resources report `FileDescription=Nox`, `ProductName=Nox`, `CompanyName=Nox contributors`, `InternalName=Nox`, and `OriginalFilename=Nox.exe`.

Package hashes:

- `Nox.exe`: `ccc85da7ee2bf88a1cdf035853248f5332ebaf8bad52196c1daa6800442f20c0`
- `app.asar`: `1589b192f66e87573b927acdbcf9eb3f71e3cfddcfdb5016cef6f1c574995d40`

## Visual QA

The packaged application captured its own renderer through Electron `capturePage` while the BrowserWindow remained hidden. This avoids taking focus or keyboard input from the user. The same packaged ASAR was rendered at all three accepted sizes:

| Viewport | Result | SHA-256 |
| --- | --- | --- |
| 1440×900 | pass: full sidebar, centered identity, composer and status bar fit without clipping | `c8c8f4e897a965dad6dbc8c0e7455350cf8ea26a589c2377323b7972b102cb71` |
| 900×700 | pass: full sidebar and composer remain legible; no overlap or horizontal clipping | `bf42a37b77642d9a4e2821f544d55410f0173ef352566ee4d9dfb8167d5de1f0` |
| 400×620 | pass: sidebar collapses, title controls fit, identity copy wraps and composer remains usable | `04d2bba3966ae0abcba71cf37250b5b7087d8eb4c40578cf701c3c8af6dca755` |

Screenshots live under `artifacts/evidence/hermes-foundation/task5-product/screenshots/`. Inspection found no donor mascot, mystical operational copy, nested card shell, clipped control or broken responsive transition. The narrow composer intentionally grows to two rows at the supported minimum width.

Keyboard submission, IME composition, focus restoration, pane resizing, transcript scrolling, streaming status, attachments and reduced-motion behavior are covered by the retained Hermes UI suite. The full renderer suite passed 148 files / 1,197 tests. The packaged capture additionally proves the actual production renderer, assets and Electron sizing path rather than a test fixture.

## Validation

- `npm run typecheck`: pass.
- `npm run lint`: pass with 121 retained warnings and zero errors.
- `npm run test:ui -- --reporter=dot`: 148 files / 1,197 tests pass.
- `npm run test:desktop:platforms`: 333 tests, 330 pass, 3 host skips, 0 fail.
- `npm run build`: pass.
- Electron builder unpacked Windows package: pass in `release-qa/win-unpacked`.
- Packaged hidden capture: pass, exit 0, three screenshots.
- ASAR brand-asset inspection: pass.
- Windows PE identity inspection: pass.

The normal `release/win-unpacked` directory was locked by the already running user-visible Nox process. The same build was packaged to the isolated `release-qa` output instead; the running process was not terminated or focused.
