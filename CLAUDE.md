# Salt 2.0 — Architecture Contract for AI Agents

Authoritative, machine-enforced architecture contract. Violations fail CI. Prose contract: [docs/salt-architecture.md](docs/salt-architecture.md).

**Context budget.** This file is auto-loaded into every session and every subagent, so its size is paid before any code is read — `pnpm context:check` caps it. A fact earns a place here only if an agent needs it **before** knowing which directory it is in, or it spans three or more packages.

| The fact is…                   | It goes…                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| already stated by the code     | a comment at the declaration; link to that                                                    |
| needed only inside one package | a nested `CLAUDE.md` there ([apps/cloud-functions/CLAUDE.md](apps/cloud-functions/CLAUDE.md)) |
| looked up once per task        | a doc under `docs/`, with a row in [docs-map.md](docs-map.md)                                 |

## How to report to Daniel

Daniel is not a coder. Technical explanation is not just unhelpful to him, it is what buries the thing he actually has to do. Every reply obeys this shape:

1. **His decision or next action first, in bold** — before any explanation. If there is nothing for him to do, say so in those words ("Nothing needed from you").
2. **Two or three plain sentences:** what changed, who it affects when they use the app, why it matters. Consequences, never mechanism.
3. **Risk:** one line, only when there is a real one.
4. **Nothing else.** No walkthrough, no restating the request, no listing options you already rejected, no summary of what you just said. State a thing once.

Technical detail is written down, not spoken — PR description, issue or doc, then link it and move on ("detail is in the PR"). Jargon that survives into a reply gets a plain-English gloss in brackets, or gets cut. **Uncertainty is a decision to surface, not detail to bury:** if you need his call, the whole reply is that question and what each answer costs him.

Chat replies only — commit messages, PR bodies and docs stay as technical as they need to be.

## Layer map

```
shared-types               →  (nothing)
domain                     →  shared-types
firebase-sync              →  domain, shared-types          # Firebase SDKs only; Firestore is the live data layer
observability              →  domain, shared-types          # PostHog browser SDK (posthog-js); default subpath, for web-pwa
observability/server       →  domain, shared-types          # posthog-node + native OTel; CF spans/events, plus a span-processor registration hook
ui-components              →  (external only — shadcn/tailwind)
testing-utils              →  shared-types, domain, firebase-sync
web-pwa                    →  shared-types, domain, firebase-sync, observability, ui-components
cloud-functions            →  shared-types, domain, observability/server
storybook                  →  ui-components                 # dev-only; typecheck+check in CI, no build/e2e
```

`@salt/observability` ships two subpaths from one package — the default wraps `posthog-js` for `web-pwa`, `/server` wraps `posthog-node` + native OTel for `cloud-functions` (rules 4, 5, 11). They share a runtime-neutral schema mapper (`src/shared/`) so the `canon.match` wire schema cannot drift between fast-path and CF emissions. `web-pwa` must not import `/server`.

Package names are `@salt/<directory basename>` — `packages/adapters/firebase-sync` is `@salt/firebase-sync`. Each `package.json` is authoritative.

## Hard rules

1. **Domain is pure.** `packages/domain` imports no Firebase, no Node built-ins, no browser APIs, no I/O. No side effects. Any conflict-resolution policy belongs here, never in an adapter — but none is wired in today; document-level LWW is enforced entirely by Firestore.
2. **Firebase SDKs are split by runtime.** The browser `firebase` SDK is imported only in `firebase-sync`. Cloud Functions talk to Firestore directly via `firebase-admin`/`firebase-functions` — **~25 files in `apps/cloud-functions`, and that is not a violation; do not "fix" it.** What the rules forbid is any Firebase SDK in `domain`, `observability` and `ui-components`. `firebase-sync` is browser-only and must never be imported by `cloud-functions`.
3. **No IndexedDB / browser storage.** No `idb`, `idb-keyval`, `window.indexedDB`, `localStorage`, `sessionStorage` or `caches`. Offline reads and writes are Firestore's `persistentLocalCache`. **Exactly three sanctioned keys exist**, all in `apps/web-pwa` (never an adapter), each wrapped so storage being unavailable degrades quietly: the two pre-authentication sign-in keys in [auth.svelte.ts](apps/web-pwa/src/lib/auth.svelte.ts) and the one-shot stale-deploy reload guard in [pwa.ts](apps/web-pwa/src/lib/pwa.ts). The bar for a fourth is "pre-auth or page-load mechanics with no Firestore-backed alternative", and nothing has cleared it since. Read the comment at each declaration before proposing one.
4. **Adapters do not import each other.** `firebase-sync` ↔ `observability`, both directions.
5. **Cloud Functions never import the default `@salt/observability` subpath** — it wraps `posthog-js` and cannot run in Node. Use `@salt/observability/server`. `firebase-functions/logger` continues additively for CF-side match logs.
6. **No importing apps.** Nothing imports `@salt/web-pwa`, `@salt/cloud-functions` or `@salt/storybook`.
7. **UI primitives go through `@salt/ui-components`.** `apps/web-pwa` never imports `shadcn-svelte`, `bits-ui` or `melt-ui` directly.
   - **Every route renders inside `AppShell`, with one sanctioned escape.** A full-viewport route runs without the shell's navigation chrome, and only for a genuinely modal, single-task mode (cook mode is the only one). Declare it in `apps/web-pwa/src/routes/fullViewport.ts` — `App.svelte` turns that into `AppShell`'s `chrome` prop. Never suppress chrome from inside a page, and never merely paint over it with `fixed inset-0`: covered nav stays focusable and stays in the accessibility tree (#641). Obligations and z-index ladder: [ui-spec-v05 §2](docs/design/ui-spec-v05.md), [ui-spec-v02 §4.1](docs/design/ui-spec-v02.md).
8. **No circular dependencies.** Enforced by dependency-cruiser.
9. **`shared-types` imports nothing from `@salt/*`.** External packages or nothing.
10. **Adapters never throw for operational errors.** Failures cross the boundary as `Failure<DomainError>` or `Conflict<T>` ([§7](docs/salt-architecture.md)).
11. **PostHog SDK only in `observability`.** `posthog-js`/`posthog-node` are imported only in `packages/adapters/observability`, which wraps them behind the `ErrorReporting`/`MatchLogging` ports. Everything else depends on the ports. Enforced by `no-restricted-imports` and depcruise's `no-posthog-outside-observability`.
12. **An invariant you state, you make mechanical — or you state its limits.** A safety property asserted in a header comment, a doc, a PR body or a test name and guaranteed by nothing is the one defect class every gate below is blind to — campaign #1064 shipped five, and three would have destroyed production data. Pin the claim with a test that goes red when it breaks, **or** state the claim's real boundary; never the unqualified absolute. Convention, not enforcement, unlike rules 1–11: worked example and why no lint rule is possible in [`.claude/commands/salt-run.md`](.claude/commands/salt-run.md) → _Standing rules_.

## Data model conventions

Mechanics — id schemes, the `firestore.rules` clauses that look redundant and are not, per-collection shapes, the per-boundary Zod failure table — are in [docs/data-model.md](docs/data-model.md). Read it before adding a collection, changing an id scheme, or editing `firestore.rules`. The invariants below are not negotiable:

- **All data is family-shared.** No `userId`, `householdId` or per-user scoping on any collection.
- **Per-user exceptions, only four:** `chatSessions`, `cookSessions`, `pushSubscriptions`, `kitchenTimers`. There is no fifth. A uid stored for **audit** (`shoppingDays.setBy`, `recipes.createdBy`/`lastEditedBy` — snapshots of `Member.name`, displayed and nothing else) is not scoping: never checked on read, never pinned on update, never a gate on capability, availability or ordering. Do not read one as an exception.
- **No soft-delete, no tombstones.** Firestore is master; delete means delete.
- **LWW per document,** enforced entirely by Firestore's full-document `setDoc` — no merge logic at any layer. Note the granularity: **a client `setDoc` rewrites the whole document, so it can clobber a field a CF trigger wrote concurrently (`thumbnail`, `embedding`). That is the contract, not a bug.** See the LWW integration test in `firebase-sync`.
- **Never branch on `recipes.kind` for behaviour outside `packages/domain`.** Capability comes from the pure predicates `takesIngredients` / `isCookable` / `isPlannable` in `domain/src/recipe/queries/capabilities.ts`. Direct comparison is permitted only to pick words, pictures or identity — `recipeKind.ts` copy/icons, list section chips, planner picker badge, and the CF art-direction prompt selectors — never to decide whether something exists or is allowed.
- **Production data back-compat.** Canon, Aisles, Equipment, Shopping List, Meal Planner and Recipes hold real production data — a schema change is backward-compatible on read, or carries a one-off migration.

## AI / Genkit conventions

- **All AI access via Genkit callables.** Every Gemini call goes through a Genkit flow invoked as a Firebase callable. No AI API keys in the client.
- **Wrap every AI call in `withAiTimeout`.** Bare Genkit flow calls have no built-in timeout and hang the function for the full 60 s quota — callables and Firestore triggers alike. Functions calling AI also declare their AI-related secrets. `apps/cloud-functions/tests/aiTimeoutGuard.test.ts` enforces this by scanning `apps/cloud-functions/src` (issue #915).
- **Subsystem detail — the three timeout sub-rules and the whole trace-propagation contract — is in [apps/cloud-functions/CLAUDE.md](apps/cloud-functions/CLAUDE.md)**, which loads automatically when working in that app. Read it before touching an AI call site, a callable entrypoint, trigger trace plumbing, or `@salt/observability/server`.

## Workflow

- **Issue-first for substantial changes** — new packages, new dependencies, layer-map edits, cross-package refactors. **Design Q&A in chat is not a greenlight.**
- **Issues are filed through `/salt-spec`, `/salt-defect` or `/salt-refactor`** — never a free-form `gh issue create`. Only those three shapes are executable by `/salt-run`, and `scripts/check-spec-shape.mjs` decides which body qualifies (it gates the `specced` label). Those commands are user-invoked, so an agent needing an issue mid-flight spawns a subagent pointed at `.claude/commands/salt-<cmd>.md`. Writing the body yourself is the fallback, and then you verify it with that script. Departing from this takes a stated reason.
- **New dependencies pin to the current latest.** Never write a version range from memory — model training data lags the registry by a long way. Check what is published (`npm view <pkg> version`, or `pnpm add <pkg>`). An older major needs a stated reason in the PR (peer-dep ceiling, known-broken release, upstream pin — e.g. the OTel 1.x pin held by `@genkit-ai/google-cloud`). Precedent: `resend` was added as `^4.0.0` in #585 when 6.x had been out for a year, and Dependabot flagged it within days.

### Worktree rules — where am I running?

A few commands seize host-global singletons (fixed ports, the emulator compose projects, `.emulator-data`, the `:5174` Vite) and would kill the dev session Daniel is sitting in or corrupt another agent's e2e run: `dev`, `dev:genkit`, `dev:emulators`, `stop:emulators`, `test:emulator`, and `@salt/web-pwa`'s `e2e` / `e2e:ui` / `e2e:coverage`. **Ask Daniel before running one from a linked worktree**, then re-run with `SALT_TAKE_HOST=1`. You do not have to remember which — [scripts/host-guard.mjs](scripts/host-guard.mjs) refuses them, kills nothing, and prints the override and safe alternatives.

**Everything short of e2e runs freely anywhere, no permission needed:** `lint`, `typecheck`, `check`, `test`, `depcruise`, `boundary:test`, `format`, `format:check`, `pnpm -r build` (there is no root `build` script).

**A cloud session is deliberately AI-key-less.** `apps/cloud-functions/.secret.local` exists only on the Mac. Build, typecheck, check and unit tests need zero configuration; anything needing Gemini goes through the `FUNCTIONS_AI_FAKE` seam or does not run at all. Do not go hunting for keys you will never find.

## Zod schema conventions

- **Shared schemas live in `@salt/domain/schemas`.** Any shape crossing an `@salt` boundary — every Firestore document, every flow/callable wire contract an adapter also names — is defined under `packages/domain/src/schemas/`. Narrowed by #932: a schema wholly internal to one app, crossing no boundary and having no second declaration to drift from, may stay there — third-party response parsers (scraped JSON-LD, Google's model catalog) and admin-only callable inputs are the standing cases, and moving them would put a foreign wire shape in the pure domain with no consumer. If an adapter also names the shape, it is shared, and it moves.
- **Schema-first.** Derive the type with `z.infer`; never maintain a hand-written type alongside a schema for the same shape.
- **Validate at trust boundaries only** — AI/Genkit flow outputs, Firestore reads, callable CF inputs, and type-laundering sites (`as` casts, `unknown` narrowings, `JSON.parse`, string → structured parsers). **Not** domain → domain, adapter internals, or anything the compiler already proves.
- **Always `.safeParse()`.** Adapters return `Failure`; list reads skip the bad doc; callables throw `HttpsError`; triggers log and return. Full table: [docs/data-model.md](docs/data-model.md).

## Observability / error-reporting conventions

Errors reach PostHog only via `ErrorReportingPort`, gated on the `DomainError` **category** — never by which call site happens to have a `catch`/`onError`, so coverage is uniform across write failures, realtime `onError` and server CF. Reporting surfaces what the friendly-message path would hide; it is not a mirror of every `Failure`. Best-effort, never throws (Rule 10). **Not lint-enforceable** — review, the gating helper and unit tests.

- **Report:** `StorageError`, `SyncError`, uncategorised/unknown errors, and server-side unhandled CF exceptions + AI/Genkit flow failures. `AuthError` too — **except** the sign-out / token-refresh `permission-denied` race on in-flight listeners.
- **Do not report:** `NetworkError`/offline, `ValidationError`, `NotFound`, `ConflictError`, and that sign-out race.
- **Scrub raw user input** (e.g. canon match text) from reported context. Data is family-shared, but free-form user content must not be attached.

Policy: [§7.6](docs/salt-architecture.md); calibration: [docs/error-reporting-calibration.md](docs/error-reporting-calibration.md).

## Enforcement

- `pnpm lint` — ESLint with `eslint-plugin-boundaries` over `**/*.{ts,js,svelte}`; `.svelte` `<script>` imports are parsed via `svelte-eslint-parser` and subject to the same rules.
- `pnpm typecheck` — TypeScript project references prevent out-of-graph imports.
- `pnpm check` — `svelte-check` across `@salt/ui-components` and `@salt/web-pwa`.
- `pnpm boundary:test` — lints deliberate violation fixtures (`.ts` and `.svelte`), asserts each errors.
- `pnpm depcruise` — cycles plus the resolved-path subpath rules ESLint can't see. Pre-commit hook and CI.
- Husky + lint-staged block bad commits locally; GitHub Actions blocks bad PRs.

## Docs map — [docs-map.md](docs-map.md)

`docs/` is **not** auto-loaded, and neither is the map. **Before editing anything under `packages/`, `apps/`, `scripts/`, `infra/` or `.github/workflows/`, open [docs-map.md](docs-map.md)** and read the row matching what you are touching. Each doc there holds knowledge **not** recoverable from the code — decisions, gotchas, external setup, contracts. A doc missing from the map is invisible to every agent, so a new doc gets its row in the same commit. Checked by `pnpm docsmap:check`.

A doc earns its place by holding what code cannot say. If a header comment beside the code already explains it, it is not restated in `docs/`.

## Code search (Serena MCP)

Serena is configured **TypeScript-only** (`language_servers: [typescript]` in `.serena/project.yml`), deliberately.

- **Use it for the pure-TS layers** — `domain`, `shared-types`, `firebase-sync`, `observability`, `cloud-functions`, `apps/web-pwa/src/lib/*Service.ts`. There `find_referencing_symbols` is exact.
- **Never use it to answer "what in the UI uses this?"** #1086 tested adding Serena's Svelte language server and found something worse than a gap: a reference query can silently attach unrelated files to real results — e.g. mistaking "renders this component" for "imports that component's export" — a confident, wrong answer, not just an empty one. Use `grep`/`search_for_pattern` over `**/*.svelte`; imports are literal text and always accurate.
- **Serena is not the impact gate.** `depcruise`, `lint` and `typecheck` are authoritative for whether a change is legal — they encode what is _allowed_, not merely what is _connected_.
- `.serena/` is gitignored. If regenerated, re-apply `language_servers: [typescript]` and `ignored_paths: [".claude/**"]`.
