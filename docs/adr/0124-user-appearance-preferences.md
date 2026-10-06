# ADR 0124: User appearance preferences

Status: Accepted (2026-10-06)

## Context

Appearance settings currently use one local-storage key per browser origin. The
key has no user identity. Two accounts in one browser share colors and fonts,
and a second device cannot read the saved settings. The orchestrator already
owns account data through Better Auth and Postgres (ADR 0051).

## Decision

Store one versioned preference document per authenticated user in the
orchestrator database. The first document contains appearance settings only:
theme mode, selected scheme, custom schemes, and font IDs. Store the system
theme mode itself; each device resolves its current light or dark theme.

Use a separate `user_preferences` table with a cascading foreign key to the
auth user, a JSONB document, a revision, and a save timestamp. Add a new Drizzle
migration. The deployment migration job applies it through `drizzle-orm`.

Expose authenticated GET and PATCH `/api/v1/me/preferences` routes. The session
supplies the user ID. GET returns defaults at revision zero for a missing row.
PATCH replaces the appearance group and requires the expected revision. An
atomic insert or conditional update advances the revision. A stale write
returns HTTP 409 with the current document. GET does not create a row.

Put types, defaults, and validation in `@engrams/user-preferences`, a shared
TypeScript package. Limit request bodies to 64 KiB and custom schemes to 50.
Keep DOM, color-token generation, and font loading in the web app.

Resolve identity before reading a user cache. Cache confirmed preferences and
pending edits under a user-specific key. Apply edits immediately and use one
save queue per mounted account. Retain failed edits and show a retry action.
Refresh on startup, window focus, and reconnect. Never replace pending edits
with a remote update without an explicit user choice. On account change, reset
appearance, cancel requests, and ignore responses from the previous account.

The existing global browser value has no owner. Offer an explicit import only
when the server has no saved document. Remove that value after a successful
import or an explicit dismissal. Do not assign it to an account automatically.

## Consequences

Settings survive browser-data removal and follow the user to other devices.
Local storage remains optional: failure to access it does not prevent server
saves. Revision checks prevent silent lost updates between tabs and devices.
Unsaved edits can require a conflict choice after another device changes the
server document. Anonymous pages use default appearance without account data.

Both web and orchestrator images must include the shared package. Changes to
it must select both test lanes and both image builds. Tests must cover real
Postgres concurrency, account isolation, retry, migration, and browser reloads.

## Implementation record

The commit chain starts with `bed755c7` (Proposed decision), followed by
`b55d235f95f9` (shared contract, migration, API, web controls, and tests). This
record accepts the decision after those checks.

Migration `0095_user_preferences` follows the current migration journal. It
adds the account document and revision constraint without changing applied
migrations. Both Docker images include the shared package, and path detection
selects both consumers.

The initial implementation needed two corrections during review. A clean tab
could clear another tab's cached draft. Cache writes now preserve foreign
pending edits and their base revision. Terminal selection text now has an
explicit foreground color with at least 4.5:1 contrast; reference ANSI colors
remain unchanged.

The appearance controls include custom color schemes, independent fonts, and
Dracula, Catppuccin, Nord, Solarized, and Gruvbox presets. Optional Inter and
Fira Code fonts use local Fontsource assets with their complete license notices.

Validation passed: 1,046 web tests in 151 files; 20 shared-contract, API,
real-Postgres, and migration-journal tests; both browser suites under the
production CSP; web formatting, lint, and build; and orchestrator type checking.
A fresh Postgres 18 database accepted all migrations. A repeat migration made
no changes. Workflow YAML parses, the shared-package path selects both test
lanes and images, and actionlint has no findings beyond those on the base branch.

Rust checks were not needed for this web and orchestrator change. The
current-head CI Gate supplies the final repository result before merge.
