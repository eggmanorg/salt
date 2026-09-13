# Cloud smoke probes — running and triaging (issue #722)

An agent-runnable set of probes that exercises a **real deployed environment**
(`s2-dev-eggman` routinely, `s2-stage-ccb22` as a pre-release gate), asserting at
the **callable + Firestore-document seam**. No DOM, no selectors, no browser.

This is not "e2e in the cloud" and does not replace Playwright. The e2e suite
runs against emulators with `FUNCTIONS_AI_FAKE`, approximated rules and a bundle
that is never the deployed artefact; these probes run real Gemini against the
real ruleset and the real deployed functions. Conversely they cover **no**
rendering, gestures, offline/PWA behaviour or auth UX — that stays with
Playwright (see [docs/e2e.md](../e2e.md)).

You orchestrate and triage. You do not click.

```
pnpm probe all                       # the default sweep, against dev
pnpm probe auth-rules                # one journey
pnpm probe all --target staging      # pre-release gate (see Preconditions)
pnpm probe all --include-opt-in      # including the journeys that cost or notify
pnpm probe --domain planner          # every journey labelled `planner`
pnpm probe                           # usage, and the list of journeys
```

Structured JSON goes to **stdout** (pipe it straight into triage), human-readable
progress to **stderr**, and the exit code is non-zero if any probe failed.

---

## Preconditions

**1. Application Default Credentials.** `gcloud auth application-default login`.
The probes need no service-account key file: they sign through IAM as you.

**2. One IAM grant per project.** `roles/owner` does **not** include
`iam.serviceAccounts.signBlob`, and both the user custom token and the App Check
token are signed through it. Without this grant, nothing runs.

```bash
gcloud iam service-accounts add-iam-policy-binding \
  firebase-adminsdk-fbsvc@<project>.iam.gserviceaccount.com \
  --member="user:<you>@gmail.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project <project>
```

| Project          | Granted?                   |
| ---------------- | -------------------------- |
| `s2-dev-eggman`  | ✅ granted 2026-08-07      |
| `s2-stage-ccb22` | ✅ granted 2026-09-13      |
| `s2-prod-e46bd`  | not a target, deliberately |

The grant is per **principal**, not per person: CI needs its own. The staging
deploy's Workload Identity principal (`vars.WIF_SERVICE_ACCOUNT` on the
`staging` GitHub Environment) needs the same `tokenCreator` role on
`firebase-adminsdk-fbsvc@s2-stage-ccb22.iam.gserviceaccount.com`, with
`--member="serviceAccount:<that account>"`. No key file and no repository
secret: in CI, ADC _is_ the deploy credential.

IAM takes up to ~60 s to propagate. A grant that "did not work" usually just
needs another minute.

**Nothing else needs configuring.** The harness handles two things people
otherwise lose an afternoon to:

- **ADC quota project.** `identitytoolkit` refuses user-ADC without one; the
  harness sets `GOOGLE_CLOUD_QUOTA_PROJECT` itself. Do **not** change your global
  `gcloud` ADC config for this.
- **The referrer-restricted browser key.** The public web API key is restricted
  to the app's own origins, so a headless request sending no `Referer` is
  refused. The harness sends `https://<projectId>.web.app/` — the same origin a
  browser would. Not a bypass: the key ships in the bundle and is public by
  design (see [app-check-preflight.md](app-check-preflight.md)).

### App Check: minted, never a debug token

Every callable enforces App Check (`APP_CHECK_ENFORCEMENT` in
`apps/cloud-functions/src/tracedCallable.ts` — a code constant, no
per-environment override). The probes mint a **real** token via
`getAppCheck().createToken(appId)` on the same service account that signs the
user token.

Do **not** register an App Check debug token to "make this easier". A debug token
is a standing attestation bypass for anyone holding it, revocable only by hunting
down every place its value was pasted. A minted token is revoked with an IAM
change, works uniformly in all three projects, and shows up in App Check metrics
as VALID — so probe traffic takes the path users take.

> `requestEmailOtp` / `verifyEmailOtp` are App Check **exempt** until #718
> Phase 4. The harness sends a token anyway, so nothing silently starts failing
> when that lands.

### Running against emulators

Don't. `APP_CHECK_ENFORCEMENT` is gated on `FUNCTIONS_EMULATOR`, and callable
enforcement lives in the function's own code with no emulator carve-out. These
probes target deployed environments only; `PROBE_TARGETS` is `dev` and `staging`,
and production is deliberately absent.

---

## The three rules the probes obey

Understand these before changing a journey — they are what let this run
repeatedly against a **prod-restored** environment.

1. **Run-scoped isolation.** Every document is named `probe-<runId>-…` and
   deleted in a `finally`. `ctx.track()` _refuses_ any id without the `probe-`
   prefix. Where an id cannot carry it (`mealPlans` and `shoppingDays` are
   date-keyed), the run is scoped by a far-future date instead and the deletion
   goes through `ctx.trackCreated()` with a stated reason, which surfaces in
   `report.adoptedDocs`. No probe asserts on global state.
2. **Derive expectations, never hardcode them.** Ingredient names come from
   canon items the environment already holds (`deriveCanonSeeds`), so the
   expected outcome is "matched" and a run cannot accrete new canon entries.
   Hardcoded expected values rot runbooks the way selectors rot e2e — see
   [product-forms-staging-validation.md](product-forms-staging-validation.md).
3. **Never assert on AI prose.** Structural invariants only. Semantic judgements
   are recorded with `ctx.warn()` and can never fail a run.

---

## What each journey covers

| Journey                 | Domain     | Covers                                                                                                                   | Notes                                                                                   |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `auth-rules`            | `auth`     | Sign-in, App Check attestation, the full allow/deny rules matrix, owner-scoped `chatSessions`                            | Free. No AI, no triggers. **The canary — if it fails, no other result means anything.** |
| `mealplan-shopday`      | `planner`  | `mealPlans/{startDate}` and `shoppingDays/{YYYY-MM-DD}` round-trip; the date-equals-doc-id invariant; `setBy` unpinned   | Free. Writes a far-future week.                                                         |
| `recipe-canon-shopping` | `shopping` | Recipe create → `canonicaliseRecipeIngredients` → `onShoppingListItemWrite` settles the item off `pending`               | Real Gemini (embeddings, sometimes arbitration).                                        |
| `chef-chat`             | `chat`     | `chefChat` + `generateChatTitle`, and owner-scoped session persistence                                                   | Real Gemini, text only.                                                                 |
| `canon-icon`            | `canon`    | `matchOrCreateCanon`; `onCanonItemWritten` writes a thumbnail **and** the companion `canonEmbeddings/{id}`               | **Opt-in** — generates a pictogram with a real image model.                             |
| `cook-timer`            | `cooking`  | `cookSessions` → `onCookTimerWrite` → Cloud Task → `onCookTimerDispatch` → the `timerDeliveries` exactly-once ledger     | **Opt-in** — sends a **real push notification** to the owner's registered devices.      |
| `recipe-import`         | `recipes`  | `extractRecipeFromPhoto` with a real page image → server-side persist into `recipes/{serverId}` → `onRecipeWritten` hero | **Opt-in** — the imported recipe costs one generated hero image.                        |

An opt-in journey is excluded from `all` unless `--include-opt-in`, and always
runs when named explicitly. Naming it _is_ the opt-in.

### Domains are a convenience, not a router

`--domain <x>` runs the journeys carrying that label and nothing else, so
someone working on the planner can exercise the planner without waiting for the
sweep. That is the whole of it. **Nothing selects journeys automatically** — the
full sweep runs every time, because at ~60 s for the lot selection buys nothing,
and a source-path → journey mapping fails in the dangerous direction: it goes
stale, the sweep quietly skips the journey that would have caught the
regression, and nothing reports that it did.

One word per journey; the vocabulary is the `PROBE_DOMAINS` list in
`probes/harness/journey.ts`, and the field is required, so an unlabelled journey
does not compile. `--domain` narrows a sweep, it does not name a journey: it
cannot pull an opt-in journey into a run that did not ask for one.

---

## Triage tree

Work top-down; the first match is almost always the cause.

### The run never starts

| Symptom                                                           | Cause                                                                                   | Do this                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `iam.serviceAccounts.signBlob denied`                             | The tokenCreator grant is missing, or was made under 60 s ago                           | Apply the grant above; wait a minute; re-run                                                               |
| `The identitytoolkit.googleapis.com API requires a quota project` | ADC is not resolving a quota project and the harness override did not apply             | Confirm you are on a current checkout; `GOOGLE_CLOUD_QUOTA_PROJECT=<project>` in the environment forces it |
| `Requests from referer <empty> are blocked`                       | The browser key's referrer allowlist no longer contains `https://<projectId>.web.app/*` | Check the key in GCP → APIs & Services → Credentials. **Do not "fix" this by unrestricting the key**       |
| `<env file> is missing VITE_FIREBASE_…`                           | `apps/web-pwa/.env.<target>` was changed or is absent                                   | Restore the file; every id is derived from it by design                                                    |

### `auth-rules` fails

| Symptom                                                                              | Meaning                                                                                   | Do this                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "an unattested callable request is refused" **fails**                                | App Check enforcement is **off** where it should be on — a real finding, not a probe bug  | Check `APP_CHECK_ENFORCEMENT`; see [app-check-preflight.md](app-check-preflight.md)                                                                                                                                                                                                                                                                                           |
| "a fully attested callable request reaches the handler" fails with `UNAUTHENTICATED` | Attestation is being rejected: minting broke, or the app id no longer matches the project | Verify `VITE_FIREBASE_APP_ID`; confirm App Check registration for that web app                                                                                                                                                                                                                                                                                                |
| Same step fails with a non-JSON body or a bare `403`                                 | Cloud Run `run.invoker` binding missing for that callable                                 | Rare — `firebase deploy` grants `allUsers` invoker itself, verified on dev. Check the **lowercased** service name: `gcloud run services get-iam-policy <lowercase-name> --region europe-west2`. Note `scripts/grant-callable-invokers.sh` is belt-and-braces and its list is stale (9 deployed callables absent), so it is **not** the authoritative record of what is public |
| An allow/deny assertion flips                                                        | `firestore.rules` changed                                                                 | Compare against the rules; if the new behaviour is intended, update the journey                                                                                                                                                                                                                                                                                               |

### A `settle` times out

A settle timeout means **a trigger did not do its job**, not that the probe is
slow. The timeouts already exceed the server-side budgets.

| Settle step                                                       | First check                                                                                                  | Then                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onShoppingListItemWrite settles the item off pending`            | CF logs for `onShoppingListItemWrite`                                                                        | The pipeline makes up to three sequential AI calls (~120 s worst case) and the function's own timeout is 180 s. A Gemini outage or a quota block shows here first                                                              |
| `onCanonItemWritten generates and stores an icon`                 | `devSettings/singleton.canonIconGenerationEnabled` — the kill-switch                                         | If enabled, pull `onCanonItemWritten` logs. Image generation is the slowest thing in the app                                                                                                                                   |
| `the embedding lands in the companion canonEmbeddings collection` | Same trigger, different branch — the embedding branch has **no** kill-switch                                 | Only its own idempotency guards can suppress it                                                                                                                                                                                |
| `the timer dispatches and claims the exactly-once ledger`         | **Does the Cloud Tasks queue exist?** `gcloud tasks queues list --project <project> --location europe-west2` | A known trap: a failed queue-create leaves `onCookTimerDispatch` deployed but permanently "Skipped (No changes detected)" with no queue behind it, so tasks are never delivered. The deployer SA needs Cloud Tasks permissions |

Pull CF logs with the `firebase-dev` / `firebase-staging` MCP servers
(`functions_get_logs`), not the console.

### Warnings, which never fail a run

| Warning                                                      | Meaning                                                                          | Do this                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `… CREATED canon item … instead of matching`                 | Matching thresholds drifted, or the derived name genuinely has no near neighbour | Not a probe bug. Worth a look at [matching-pipeline.md](../matching-pipeline.md) if it recurs. The stray item was removed |
| `… resolved to canon <id>, not the <id> it was derived from` | Several canon entries share a name or synonym                                    | Usually benign                                                                                                            |
| `chefChat's answer … did not contain 1000`                   | AI variance                                                                      | Re-run once. Only investigate if it is persistent                                                                         |
| `generateChatTitle returned N words`                         | Prompt drift                                                                     | Cosmetic; not a failure                                                                                                   |

### Teardown

`WARNING: N probe(s) could not clean up` means documents were left behind. Every
probe-created id carries the `probe-` prefix, so they are easy to find and safe
to delete. Check `teardownErrors` in the JSON for exactly which. The one place a
leftover is not prefixed is the far-future `mealPlans` / `shoppingDays` pair —
`report.adoptedDocs` names those explicitly.

**Never delete anything untagged.** Dev and staging hold prod-restored data.

The other unprefixed case is `recipe-import`: `extractRecipeFromPhoto` persists
under a **server-generated** id, so the recipe and its hero object are removed
via `ctx.trackCreated` / `ctx.trackCreatedStorageObject` and named in
`adoptedDocs`.

### The `recipe-import` fixture

`probes/assets/recipe-page.webp` is a page **we wrote** — an invented recipe in
an invented book — rendered from `probes/assets/recipe-page.html`, which is
committed beside it so the provenance is checkable rather than asserted. It is
not a photograph of a published cookbook, and a replacement must not be either.
Regenerate the image from the HTML at 1240×1754 if the fixture ever needs to
change.

URL import (`extractRecipeFromUrl`) is deliberately **not** covered. It would
need a stable recipe page on a site we do not control — exactly the hardcoded
external expectation that rotted
[product-forms-staging-validation.md](product-forms-staging-validation.md). The
option, if it is ever wanted: serve a fixture page from the environment's own
Hosting origin, which means shipping a fixture into the deployed app — a trade
worth making deliberately rather than in passing.

---

## Cost and side effects

**The automatic spend is a number, not a caution.** One opt-in run generates
**one canon pictogram, one recipe hero, and sends one real push notification**.
That happens **once a week** (Thursday morning) **plus once per published
release** — so roughly one or two such runs a week, bounded and predictable.
The push lands on the registered devices of the probe identity only
(`PROBE_UID` / `PROBE_EMAIL` in `probes/harness/auth.ts`), never on a family
member's phone.

The free sweep — the other four journeys — spends a handful of embedding and
text calls and runs after every staging deploy. It is cheap enough to run on
demand, repeatedly.

- **`recipe-import` cannot be made cheaper without changing product code, and
  must not be.** Every import path lands the recipe with `image: null`, and
  `onRecipeWritten` generates a hero on create with a null image. There is no
  per-document opt-out; the only switch is the per-environment
  `devSettings/singleton.recipeImageGenerationEnabled`, which does not exist in
  staging. Adding a suppression field to product code to make a probe cheaper
  would be the tail wagging the dog.
- `recipe-import` waits for that hero before it finishes, and the wait is not
  decoration: the trigger writes a Storage object and a doc field long after the
  import returns, so tearing down early would leak the object and write to a
  document that no longer exists.
- No journey mutates existing data. A probe that needed to would have to
  read-then-restore, or not ship. (`refreshWeatherForecast` is the standing
  example of one that would, and therefore has no journey.)

## What runs automatically (issue #1356)

| When                                     | Where                                              | What runs                                          |
| ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| Every merge to main that deploys staging | the `probe` job in `deploy-staging.yml`            | `pnpm probe all --target staging`                  |
| Thursday 06:00 UTC, and on demand        | `probe-staging-weekly.yml`                         | the same, plus `--include-opt-in`                  |
| A GitHub Release is published            | the `probe-staging` job in `deploy-production.yml` | the same, plus `--include-opt-in`, before approval |

The probe job `needs: deploy` and skips on the same `should_deploy` guard, so a
docs-only merge shows it **skipped**, not failed — probing an environment
nothing changed in proves nothing. It declares `environment: staging` because
that is where `WIF_PROVIDER` / `WIF_SERVICE_ACCOUNT` live; staging carries no
protection rules, so it never waits for a reviewer. A side effect worth knowing:
the job records a GitHub deployment, so probe runs appear in the staging
Environment's deployment history beside real deploys.

**A red run is a signal, not a rollback.** Nothing is reverted, no workflow is
blocked, and staging stays as deployed. Production is a deliberate promotion —
publishing a GitHub Release, behind the `production` Environment's
required-reviewer rule — so a red staging sweep is what Daniel sees _before_ he
decides to promote. Whether it should ever become a hard block on that promotion
is deliberately undecided, and is not to be introduced quietly as an
implementation detail.

Every one of the three uploads its report JSON as a run artifact
(`probe-staging-report`, `probe-staging-weekly-report`,
`probe-staging-release-report`) on green and red alike, so a failure is triaged
from the run without probing the environment a second time.

### The costly journeys, and the one rule that money depends on

**`--include-opt-in` never appears in a merge-triggered workflow.** Not a
severity or a speed tier: the failure mode being guarded is a sweep that bills
for generated images and buzzes a phone _because someone merged a pull request_
— unbounded, unpredictable, many times a day. A run on a weekly schedule or on
a published release is bounded, predictable and chosen, and it is the only way
those three journeys get exercised at all.

`apps/cloud-functions/tests/optInProbeTriggerGuard.test.ts` makes that
mechanical: it reads every file in `.github/workflows/` and fails if the flag
appears in one whose own triggers include `push`, `pull_request`,
`pull_request_target`, `merge_group` or a `workflow_run` of CI. It has one
stated boundary — it reads a workflow's
own `on:` block, so a reusable `workflow_call` workflow invoked from a
merge-triggered one would slip past. None exists in this repo; the test's header
says what to do if one is ever added.

**Thursday is not a detail to tidy.** Daniel works on this repo Friday to
Sunday; Monday to Thursday is a limited-work window. A Thursday-morning run
surfaces whatever broke during the quiet week while there is still a quiet day
to fix it, and each Friday starts clean. A Monday run would report into the
window where least can be done about it. GitHub cron is UTC, so `0 6 * * 4` is
07:00 BST and 06:00 GMT — it drifts by an hour twice a year, which is accepted,
and GitHub runs scheduled workflows late under load.

**The release-time run is the gate, and it blocks nothing.** The
`probe-staging` job sits inside `deploy-production.yml` so its result lands in
the same Actions run as the production approval prompt, above it: GitHub
requests deployment review when a job becomes ready, so the "Review deployments"
prompt appears after the probe finishes. The `deploy` job takes
`needs: probe-staging` with `if: always()`, so it waits for the answer and is
never blocked by it — a red probe still lets Daniel approve, and nothing is
reverted. The job declares `environment: staging`, not `production`: that is
where the WIF variables live, and staging has no protection rules, so it does
not wait for the very approval it informs.

`workflow_dispatch` on `probe-staging-weekly.yml` runs the same thing on demand,
so the schedule never has to be waited for to test it.

## Out of scope

Emitting probe results to PostHog stays deferred (it was deferred in #722 and
again in #1356). The GitHub run is already the signal, and it is one green/red
per deploy — not the high-volume data that earned the e2e flake telemetry in
#669. **Revisit when:** the gate starts going red in ways nobody can
characterise from the run log — an intermittent journey, a slow drift in settle
times. That is the question telemetry would answer, and it earns its own issue
then.
