# Releases & Environments

How Salt ships. The release model is **trunk-based**: `main` is always releasable,
merges to `main` auto-deploy to **staging**, and a published **GitHub Release**
promotes that _same commit_ to **production** behind a manual approval gate.
Full plan and phases: GitHub issue #118.

> Environment is a deploy **target**, not a branch. We deliberately do **not**
> keep long-lived `dev`/`staging` branches — see #118 for the rationale and the
> conditions under which we'd revisit.

## Firebase projects (`.firebaserc` aliases)

| Alias        | Project ID       | Plan  | Used for                               |
| ------------ | ---------------- | ----- | -------------------------------------- |
| `default`    | `demo-salt`      | —     | Local emulators only (no real network) |
| `staging`    | `s2-stage-ccb22` | Blaze | Auto-deployed on merge to `main`       |
| `production` | `s2-prod-e46bd`  | Blaze | Promoted from a GitHub Release (gated) |

Deploys always target an alias explicitly: `firebase deploy -P staging` /
`-P production`. Bare `firebase` commands hit `default` (emulators), which is
the safe local default.

## Agent access to live Firestore (MCP)

Claude agents reach each cloud project's **live** Firestore and Cloud Functions
logs through a Firebase MCP server, one per environment. Each is pinned to its
project by its own `.firebaserc` in an isolated directory under
`~/.config/firebase-mcp/`, so none of them can move the repo's active project
away from `demo-salt` (which offline `pnpm dev:emulators` depends on). These are
machine-local registrations in `~/.claude.json`, not repo config — a cloud
session has none of them.

| Server             | Project          | Tool surface                              | Writes             |
| ------------------ | ---------------- | ----------------------------------------- | ------------------ |
| `firebase-dev`     | `s2-dev-eggman`  | `--only core,firestore,functions`         | ungated            |
| `firebase-staging` | `s2-stage-ccb22` | `--only core,firestore,functions`         | ungated            |
| `firebase-prod`    | `s2-prod-e46bd`  | `--tools <explicit allowlist>` (25 tools) | **Daniel prompts** |

Production differs from the other two in two ways, both deliberate:

1. **The tool surface is an allowlist, not a feature set.** `--tools` disables
   auto-detection, so a tool that is not named does not exist on the server —
   there is no permission prompt that can reach it. Permanently absent from prod:
   `firestore_{create,update,delete}_database`, `firestore_{create,delete}_index`,
   `firestore_delete_backup`, the three backup-schedule writers, `firebase_deploy`,
   `firebase_init`, `firebase_update_environment`, `firebase_create_*`, and
   `firebase_{login,logout}`. What remains is 22 read tools plus the three
   document writers.
2. **Those three writers are permission-gated.** `firestore_add_document`,
   `firestore_update_document` and `firestore_delete_document` sit in
   `permissions.ask` and `autoMode.soft_deny` in
   [`.claude/settings.json`](../.claude/settings.json), so every prod write is a
   prompt — approval of one write never carries to the next. Reads are allowed
   outright, as on staging.

**Limits of that gate, stated rather than implied.** It is a prompt, not a
sandbox: an approved write goes straight to family production data, with no
per-collection restriction and no undo. `firestore_update_document` writes the
fields you give it, but the LWW contract still applies — a concurrent CF trigger
write can be lost. Recovery is a restore, not a rollback:
[data-refresh.md](data-refresh.md), `scripts/export-prod-firestore.mjs` and
`scripts/restore-firestore.mjs`. Take an export before any write you would not
want to re-derive by hand.

**The allowlist only binds this route.** `firebase -P production`, a `gcloud
firestore` call or an ad-hoc admin-SDK script bypasses it entirely; those are
hard-denied for agents in `.claude/settings.json` for exactly that reason.

Registering prod (one-time, from the repo root, not a worktree):

```
claude mcp add firebase-prod -- \
  firebase mcp --dir ~/.config/firebase-mcp/salt-prod \
  --tools firebase_get_project,firebase_get_environment,firebase_get_sdk_config,firebase_get_security_rules,firebase_validate_security_rules,firebase_read_resources,firebase_list_apps,firestore_get_document,firestore_list_documents,firestore_list_collections,firestore_query_collection,firestore_run_aggregation_query,firestore_get_database,firestore_list_databases,firestore_get_index,firestore_list_indexes,firestore_get_backup,firestore_list_backups,firestore_get_backup_schedule,firestore_list_backup_schedules,functions_get_logs,functions_list_functions,firestore_add_document,firestore_update_document,firestore_delete_document
```

Auth is the Firebase CLI's logged-in user, so an agent can only ever reach what
Daniel can reach.

## Config & secrets — what lives where

There are two distinct classes. Getting the split right is the whole game:
**client config is public and committed; runtime secrets never touch the repo.**

### 1. Client config — build-time, committed, **not secret**

Lives in `apps/web-pwa/.env.<mode>` (Vite picks the file by `--mode`). These are
**public identifiers** that ship in the browser bundle — committing them is
correct and expected. They are guarded by Firestore/Storage security rules and
API-key restrictions, not by secrecy.

| Variable                            | Notes                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_FIREBASE_API_KEY`             | Public web API key (per project)                                                                                                                                            |
| `VITE_FIREBASE_AUTH_DOMAIN`         | `<project>.firebaseapp.com`                                                                                                                                                 |
| `VITE_FIREBASE_PROJECT_ID`          | Firebase project ID                                                                                                                                                         |
| `VITE_FIREBASE_STORAGE_BUCKET`      | `<project>.firebasestorage.app`                                                                                                                                             |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Sender ID                                                                                                                                                                   |
| `VITE_FIREBASE_APP_ID`              | Web app ID                                                                                                                                                                  |
| `VITE_PUBLIC_POSTHOG_KEY`           | PostHog **browser project** key — public, per **PostHog project** (staging ≠ prod). An empty value gates browser observability off entirely (the e2e build relies on this). |
| `VITE_PUBLIC_POSTHOG_HOST`          | PostHog ingestion host (optional; defaults to the EU region `https://eu.i.posthog.com`)                                                                                     |
| `VITE_USE_EMULATORS`                | `false` for staging/production                                                                                                                                              |

Each environment must use its **own** values; in particular the PostHog browser
project key must point at the matching PostHog project.

Each deploy target maps to its own PostHog project (dev / staging / production),
all in the EU region — the browser project key and server API key are a matched
pair per project.

- `.env.development` — emulators; PostHog project `dev` (typically left empty so
  observability no-ops locally).
- `.env.staging` — fully populated for `s2-stage-ccb22`; PostHog `staging` project.
- `.env.production` — fully populated for `s2-prod-e46bd`; PostHog `production` project.

### 2. Cloud Functions runtime secrets — Secret Manager, per project, **never committed**

These are real secrets. They live in Google Secret Manager, set **per Firebase
project**, and are bound to the functions via `defineSecret()` in
`apps/cloud-functions/src`. They must differ between staging and production
(sharing one would let staging traffic bill/pollute prod).

| Secret                                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Set with                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`                           | Gemini/Genkit API key for the AI flows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `firebase functions:secrets:set GEMINI_API_KEY -P <alias>`                               |
| `POSTHOG_API_KEY`                          | PostHog **server project** key (`posthog-node`) for CF event capture; absent ⇒ server observability no-ops                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `firebase functions:secrets:set POSTHOG_API_KEY -P <alias>`                              |
| `RESEND_API_KEY`                           | Resend API key used by `requestEmailOtp` to deliver the sign-in code (#546). Use a **separate key per environment** so staging sends can't be confused with prod ones in the Resend dashboard.                                                                                                                                                                                                                                                                                                                                                                              | `firebase functions:secrets:set RESEND_API_KEY -P <alias>`                               |
| `OTP_EMAIL_FROM`                           | The OTP sender address, e.g. `Salt <no-reply@salt.pendery.org>`. Not sensitive, but Secret Manager is the only runtime-config channel a deployed function has here (the `dist` deploy source is wiped by every build, so a `.env` can't survive). Must be on a Resend-**verified** domain — `onboarding@resend.dev` only delivers to the Resend account owner and is not a usable default.                                                                                                                                                                                  | `firebase functions:secrets:set OTP_EMAIL_FROM -P <alias>`                               |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`   | Web-push signing keypair for cook-timer notifications (#544). **Distinct per environment** — a subscription minted under one project's public key is undeliverable by another's private key. Generate with `npx web-push generate-vapid-keys`; the public half also goes in `apps/web-pwa/.env.<mode>` as `VITE_VAPID_PUBLIC_KEY` (empty ⇒ the notifications toggle is hidden).                                                                                                                                                                                             | `firebase functions:secrets:set VAPID_PUBLIC_KEY -P <alias>` (and `VAPID_PRIVATE_KEY`)   |
| `PUSHOVER_APP_TOKEN` / `PUSHOVER_USER_KEY` | Pushover credentials for cook-timer delivery (#680) — the sink that actually wakes a dozing Android device. Unlike VAPID these are the **same in every environment**: there is ONE shared family account, the user key _is_ the account, and per-person targeting is the `device` parameter, so no per-user identity data is stored anywhere. The blast radius is handled in code instead — outside production the sender only targets `daniel-*` devices, so a staging timer test cannot wake the family. Absent ⇒ the Pushover sink logs and no-ops; web push still runs. | `firebase functions:secrets:set PUSHOVER_APP_TOKEN -P <alias>` (and `PUSHOVER_USER_KEY`) |

There is **no** OTLP secret or endpoint var: server-side spans export to GCP /
Firebase Monitoring via `enableFirebaseTelemetry()` (Genkit-native), and PostHog
event ingestion uses the EU host baked into `observability/server` (overridable
only via the optional `POSTHOG_HOST`).

> **Gemini billing caveat — dev and staging share one Google AI Studio project.**
> The `dev` and `staging` deploy targets use **different** `GEMINI_API_KEY` values,
> but **both keys belong to the same Google AI Studio project, `s2-stage-ccb22`**.
> Gemini/Genkit usage therefore bills and quotas against that one project regardless
> of which key issued the call. When investigating unexpected AI spend or quota
> exhaustion in staging, you **must** account for local `dev` usage as well — it lands
> on the same bill. (Distinct API keys do **not** imply distinct AI Studio projects —
> verify the project, not just the key, before assuming any environment is isolated.)

### 3. CI / GitHub Environments

CI authenticates to Firebase via **Workload Identity Federation** (no long-lived
key in the repo — see #118 Phase 2). Three GitHub Environments scope what each
deploy job can see:

| Environment  | Protection                                         | Holds                                          |
| ------------ | -------------------------------------------------- | ---------------------------------------------- |
| `dev`        | none (manual dispatch only)                        | dev WIF provider + service-account refs        |
| `staging`    | none (auto-deploy)                                 | staging WIF provider + service-account refs    |
| `production` | required reviewer (maintainer) = the approval gate | production WIF provider + service-account refs |

No PR-triggered jobs run against either Environment (per-PR Hosting previews were
dropped — see Setup status); production secrets are scoped to release-triggered
deploys only.

#### CodeQL, and what gates a merge

Code scanning runs through GitHub's **default setup**, configured in repository
settings with no workflow in `.github/workflows/`, and it gates merges via the
`Main` ruleset's `code_scanning` rule. That, the three required status checks and
the merge queue are all merge gates rather than deploy concerns, so they live in
[ci.md](ci.md) — including the failure mode where a PR is `blocked` with every
visible check green.

#### WIF identifiers (provisioned — Phase 2)

These are **not secret** (resource paths + SA emails). The deploy workflows pass
them to `google-github-actions/auth` as `workload_identity_provider` +
`service_account`, sourced per GitHub Environment.

| Env          | `workload_identity_provider`                                                                   | `service_account`                                               | Impersonation scope                          |
| ------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------- |
| `dev`        | `projects/946977631175/locations/global/workloadIdentityPools/github-actions/providers/github` | `firebase-adminsdk-fbsvc@s2-dev-eggman.iam.gserviceaccount.com` | repo `eggmanorg/salt`                        |
| `staging`    | `projects/946977631175/locations/global/workloadIdentityPools/github-actions/providers/github` | `gha-deployer@s2-stage-ccb22.iam.gserviceaccount.com`           | repo `eggmanorg/salt`                        |
| `production` | `projects/140613398002/locations/global/workloadIdentityPools/github-actions/providers/github` | `gha-deployer@s2-prod-e46bd.iam.gserviceaccount.com`            | **only** the `production` GitHub Environment |

**There are two pools, not three.** `dev` and `staging` share one — the pool in
`s2-stage-ccb22` (`946977631175`). A pool can mint tokens that impersonate a service
account in any project, so `dev` borrows staging's provider and impersonates an SA in
`s2-dev-eggman`. `s2-dev-eggman` has no pool of its own; a `gcloud
workload-identity-pools` command aimed at it returns `NOT_FOUND`, which looks like a
broken setup and is not one. Two consequences worth holding on to:

- In a `principalSet://` member for the dev SA, the project number is **staging's**
  (`946977631175`), not dev's. `--project` names the project the _service account_ lives
  in; the path names the project the _pool_ lives in, and for `dev` those differ.
- Changing staging's provider changes dev's too. There is no way to re-scope one without
  the other.

Both providers are restricted to `assertion.repository == 'eggmanorg/salt'`; no
long-lived key exists anywhere.

`dev` is also the odd one out on identity: it impersonates the **default Firebase Admin
SDK** service account, which Firebase provisions with broad project rights and which
doubles as the app's own admin identity, where `staging` and `production` each use a
purpose-made `gha-deployer`. It works and it is only the dev project, but a CI job
against dev holds a much wider identity than the same job against the other two.

## Deploying

| Target       | Trigger                                | Workflow                |
| ------------ | -------------------------------------- | ----------------------- |
| `staging`    | every push to `main` (after CI passes) | `deploy-staging.yml`    |
| `production` | a **published GitHub Release** (gated) | `deploy-production.yml` |

**Production is a deliberate promotion, never automatic.** Publishing a GitHub
Release deploys that release's exact tagged commit — the same commit already
auto-deployed to and validated on staging. The job runs in the `production`
GitHub Environment, whose required-reviewer rule is the approval gate: the run
sits paused until the maintainer approves it, then deploys.

### Cutting a release (promote staging → production)

1. Confirm the commit you want is live and healthy on staging.
2. Run **`pnpm release`**. It computes the next tag, prints it, asks for
   confirmation, then creates + publishes the GitHub Release.
3. `deploy-production.yml` starts and **waits for approval** in the `production`
   Environment. Approve the run → it deploys that tag's commit to prod.

**Release tags use `YYYYMM.X`** — calendar month + a counter that resets each
month (`202606.1`, `202606.2`, … then `202607.1`). `pnpm release`
(`scripts/cut-release.sh`) finds the highest `X` already used this month across
published Releases and remote tags, increments it, and tags `main`'s HEAD.

```bash
pnpm release          # tag main's HEAD with the next YYYYMM.X
pnpm release <ref>    # tag a specific branch / sha / tag instead of main
pnpm release -y       # skip the confirmation prompt
```

### Rollback / re-deploy

Production has no separate rollback build — you re-deploy a known-good tag:

- **Re-deploy an earlier tag.** Run `deploy-production.yml` via
  **workflow_dispatch** with `ref` set to the previous good tag (or SHA). It
  goes through the same `production` approval gate and redeploys that commit's
  artifacts (hosting + functions + firestore rules/indexes).
- **Instant hosting-only rollback.** For a frontend-only regression, the
  Firebase Hosting console's **one-click rollback** to the prior release is the
  fastest path; it does not revert functions or rules.

Either way, fixing forward (merge a fix → it auto-deploys to staging → cut a new
release) is preferred when the issue isn't an emergency.

## First deploy to a fresh project (one-time bootstrap)

A brand-new Firebase project needs one-time setup that the CI deployer SA
**cannot** do itself (it deliberately lacks project-IAM-admin). Done for staging;
**still required for production before its first deploy.**

1. **Enable the required APIs** (the SA can _use_ APIs but not enable them):
   `firebasestorage`, `cloudfunctions`, `cloudbuild`, `artifactregistry`, `run`,
   `eventarc`, `pubsub`, `firestore`, `firebasehosting`, `storage`,
   `secretmanager`, `cloudbilling`, plus `iamcredentials` + `sts` (WIF).
   `gcloud services enable <api>… --project=<id>`.
2. **Run the first deploy as an owner** (local `firebase deploy -P <alias>`).
   This performs the one-time service-agent IAM setup that gen2 functions need
   (Pub/Sub, Eventarc service agents) — which the SA can't do. Expect to retry:
   the `gcf-admin-robot` and Eventarc service agents provision asynchronously on
   first use, so the first one or two attempts can fail with `404 … Not found`
   or "Eventarc permissions still propagating" — wait a few minutes and retry.
3. **Grant the runtime service account `roles/iam.serviceAccountTokenCreator`
   on itself.** Required by `verifyEmailOtp` (email-OTP sign-in, #585): it mints
   a Firebase custom token via `getAuth().createCustomToken()`, which signs a JWT
   through the IAM Credentials API, so the gen2 runtime SA
   (`<project-number>-compute@developer.gserviceaccount.com`) needs
   `iam.serviceAccounts.signBlob` on **itself**.

   ```
   gcloud iam service-accounts add-iam-policy-binding <project-number>-compute@developer.gserviceaccount.com \
     --member="serviceAccount:<project-number>-compute@developer.gserviceaccount.com" \
     --role="roles/iam.serviceAccountTokenCreator" \
     --project=<project-id>
   ```

   This is a project-level IAM grant, **not** part of `firebase deploy`, so every
   environment needs it separately — it bit dev, then staging (2026-07-26), and
   would bite production the first time a member signs in with a code. No
   redeploy is needed; it propagates in under a minute. Verify with
   `gcloud iam service-accounts get-iam-policy <sa> --project=<id>` — a bare
   `{"etag":"ACAB"}` means **no** bindings and OTP sign-in will fail.

   The failure is quiet and misleading: the code, TTL, attempt and allowlist
   checks all pass and it dies on the very last step, so the user just sees
   "Sign-in failed. Please try again." The `logger.error` line in
   `verifyEmailOtp` exists precisely so this leaves a trace in Cloud Logging;
   grep it for `signBlob`.

4. **Provision Cloud Tasks** — required by the cook-timer push chain
   (`onCookTimerWrite` enqueues, `onCookTimerDispatch` is the `onTaskDispatched`
   handler, #544). **Two different principals** need a grant, and getting it
   wrong fails in a way that then hides itself:

   ```
   gcloud services enable cloudtasks.googleapis.com --project=<project-id>
   # runtime SA — enqueues
   gcloud projects add-iam-policy-binding <project-id> \
     --member="serviceAccount:<project-number>-compute@developer.gserviceaccount.com" \
     --role="roles/cloudtasks.enqueuer"
   # deployer SA — the Firebase CLI calls cloudtasks.queues.get/create at deploy time
   gcloud projects add-iam-policy-binding <project-id> \
     --member="serviceAccount:gha-deployer@<project-id>.iam.gserviceaccount.com" \
     --role="roles/cloudtasks.admin"
   ```

   Granting only the runtime role (the obvious one) still fails the deploy with
   `403 … lacks IAM permission "cloudtasks.queues.get"`. **The trap on recovery:**
   after that failed deploy the function is still _registered_, so every later
   deploy reports `onCookTimerDispatch — Skipped (No changes detected)` and never
   retries the queue creation. The workflow goes green while
   `gcloud tasks queues list` shows zero queues, and timer pushes fail at enqueue
   (logged + reported, never user-visible). It does not self-heal: after granting
   the role, either `firebase functions:delete onCookTimerDispatch -P <alias>` and
   redeploy (keeps the CLI as source of truth for `rateLimits`/`retryConfig`), or
   create the queue by hand to match dev
   (`--max-concurrent-dispatches=6 --max-attempts=5`).

5. **Grant the deployer SA `roles/cloudscheduler.admin`** — required by the
   scheduled functions `sweepOrphanedStorage` (`onSchedule`, #621) and
   `remindShoppingDay` (`onSchedule`, #629). Deploying one
   creates/updates a Cloud Scheduler job, which `roles/firebase.admin` does
   **not** cover:

   ```
   gcloud projects add-iam-policy-binding <project-id> \
     --member="serviceAccount:gha-deployer@<project-id>.iam.gserviceaccount.com" \
     --role="roles/cloudscheduler.admin"
   ```

   Without it the deploy fails with `403 … lacks IAM permission
"cloudscheduler.jobs.update"`. A **local owner deploy hides this** — an owner
   has the permission — so the gap only surfaces on the first CI/SA deploy after
   a scheduled function is added.

   **It then hides itself, exactly like the Cloud Tasks trap.** The function is
   created _before_ the scheduler job is written, so the failed deploy still
   leaves it registered; every later deploy reports
   `sweepOrphanedStorage(europe-west2) — Skipped (No changes detected)`, never
   re-attempts the job, and the workflow goes green. Granting the role and
   re-running is **not** enough. Recovery is the same shape:

   ```
   gcloud functions delete sweepOrphanedStorage \
     --region=europe-west2 --project=<project-id> --gen2
   # then redeploy: `gh workflow run deploy-staging.yml` for staging, or re-run
   # deploy-production.yml via workflow_dispatch (through the approval gate) for prod
   ```

   **Use `gcloud`, not `firebase functions:delete`** — the Firebase CLI tears the
   scheduler job down _before_ the function, so on a job that was never created it
   dies with `HTTP Error: 404, Job not found` and aborts without deleting anything.
   Chicken-and-egg: it can't clean up a resource its own failed deploy never made.
   `gcloud` removes the service (and its Artifact Registry artifacts) without
   touching Cloud Scheduler. Firebase derives deploy state from the live resources,
   so the next deploy creates function _and_ job from scratch.

   For staging, redeploy via `workflow_dispatch` rather than a push — a docs-only
   commit won't clear `deploy-staging.yml`'s deploy-relevant-path guard, and manual
   runs always deploy.

   Verify with
   `gcloud scheduler jobs list --project=<project-id> --location=europe-west2` —
   zero jobs means the function is deployed but **never fires**. A healthy stack reads
   `firebase-schedule-sweepOrphanedStorage-europe-west2  0 3 * * 0  Europe/London  ENABLED`
   and `firebase-schedule-remindShoppingDay-europe-west2  0 17 * * *  Europe/London  ENABLED`.

   **Check this list after every release that adds a scheduled function.** The
   grant is per-project, not per-function, so all three environments already hold
   `roles/cloudscheduler.admin`; but a _new_ `onSchedule` function still creates a
   _new_ job, and any failure to write that job hides itself the same way. One
   `gcloud scheduler jobs list` per environment is the whole check — a job count
   short of the number of `onSchedule` exports means something never fires.

6. After that, **CI/SA deploys work** without any standing IAM-admin grant.

> Note: `firebase deploy` will not change a function's trigger type in place. If
> an interrupted first deploy leaves a Firestore-trigger function as an `https`
> stub, `firebase functions:delete <name> --region <region>` and redeploy.

## Setup status

- [x] Staging Firebase project (`s2-stage-ccb22`, Blaze) + alias + `.env.staging` config
- [x] Production Firebase project (`s2-prod-e46bd`, Blaze) + alias + `.env.production` config
- [x] `VITE_PUBLIC_POSTHOG_KEY` for dev / staging / production (matched PostHog projects)
- [x] WIF setup — staging (repo-scoped) and production (environment-scoped)
- [x] `POSTHOG_API_KEY` secret set in staging + production Secret Manager
- [x] `GEMINI_API_KEY` secret set in staging + production Secret Manager
- [x] GitHub Environments (`staging`, `production`) + production required-reviewer gate
- [x] Staging deploy workflow (`deploy-staging.yml` — on CI success on `main`)
- [x] Staging first-deploy bootstrap (APIs + service agents) done
- [x] **First end-to-end staging deploy verified** (CI/SA → https://s2-stage-ccb22.web.app)
- [x] Production first-deploy bootstrap (owner deploy done — functions + firestore + hosting live at https://s2-prod-e46bd.web.app)
- [x] `roles/iam.serviceAccountTokenCreator` self-binding on the runtime SA (needed by email-OTP sign-in — see bootstrap step 3) — dev `277945741930-compute@`, staging `946977631175-compute@` and production `140613398002-compute@` all **done** (verified 2026-07-28)
- [x] Email-OTP secrets (`RESEND_API_KEY`, `OTP_EMAIL_FROM`) — dev, staging and production (prod set 2026-07-28)
- [x] Web-push VAPID keypair (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` secrets + `VITE_VAPID_PUBLIC_KEY` in `.env.<mode>`) — dev, staging, and production (prod pair generated 2026-07-28)
- [x] Cloud Tasks provisioning (bootstrap step 4) — dev, staging and production all **done**; prod's `onCookTimerDispatch` queue is RUNNING in `europe-west2` (2026-07-28)
- [x] `roles/cloudscheduler.admin` on the deployer SA (bootstrap step 5) — staging and production both **done** (2026-07-28); dev needs no grant, as its CI deploys as `gha-deployer@s2-stage-ccb22`, which holds `roles/owner` on `s2-dev-eggman`. `sweepOrphanedStorage` had been ACTIVE in both since #621 with no Cloud Scheduler job in any region, so the weekly sweep had never once run; release `202607.9` surfaced it as a `cloudscheduler.jobs.update` 403 and `202607.10` then masked it as "Skipped (No changes detected)". Recovered per step 5 — both environments now hold an ENABLED `0 3 * * 0` Europe/London job. Dev never hit the trap (its last deploy predated #621, so the function was never registered); enabling `cloudscheduler.googleapis.com` and redeploying was enough. **All three environments now hold the job.**
- [x] Pushover secrets (`PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`) — dev, staging and production, all set 2026-08-03 (#680). One shared family account, so the SAME pair goes to all three; the non-prod blast radius is handled in code (outside production only `daniel-*` devices are targeted, and the emulator never sends at all) rather than by separate credentials. Absent ⇒ the sink logs "not provisioned" and no-ops, and timers fall back to web push alone — which is the late-delivery problem #680 exists to fix, so an unset secret presents as no fix at all. Same trap for the two one-time licences (Android + iOS, ~$10): a lapsed 30-day trial looks identical to the bug.
- [ ] `remindShoppingDay` Cloud Scheduler job (#629) — a **second** `onSchedule` function (`0 17 * * *`, Europe/London, `europe-west2`). The `roles/cloudscheduler.admin` grant above already covers it in all three environments, so no new IAM work is expected; still verify with `gcloud scheduler jobs list` after the first deploy to each, per bootstrap step 5. Zero-shop days cost one Firestore document read, so an unfired job is silent — the list is the only signal.
- [ ] `snapshotVolumetrics` Cloud Scheduler job (#684) — a **third** `onSchedule` function (`30 2 * * *`, Europe/London, `europe-west2`). Same story as `remindShoppingDay`: the `roles/cloudscheduler.admin` grant already covers it; verify with `gcloud scheduler jobs list` after the first deploy to each environment, per bootstrap step 5. An unfired job is silent — the only symptom is `volumetrics.snapshot` events never appearing in PostHog.
- [ ] Firestore → BigQuery export extensions (#684) — **production-only, one-off owner install**, deliberately outside the CI deploy (see [infra/bigquery-export/README.md](../infra/bigquery-export/README.md) for why and for the install + backfill commands). Not part of any workflow; nothing to verify on ordinary releases.
- [x] Production deploy workflow (`deploy-production.yml` — on GitHub Release, gated) — Phase 4
- [x] ~~PR preview channels~~ — **dropped** (#126 reverted). The whole app sits behind an auth gate and magic-link sign-in can't run on a preview's unauthorized, per-PR origin, so a preview only ever shows the login page. Verify on the staging domain after merge instead.
- [x] End-of-greenfield doc note (`salt-architecture.md` §1.1 + `CLAUDE.md`) — Phase 6
