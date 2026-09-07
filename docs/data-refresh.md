# Refreshing an environment with another's data

To test a migration or bug fix against real data, you can replace **staging's**
Firestore with a faithful copy of **prod**. This is a two-step, two-click flow in
the **Task Pilot** sidebar:

1. **Export Prod Firestore** — read-only managed export of prod to a GCS bucket.
2. **Restore Staging from Prod** — wipes staging, then imports the newest export.

Both are one-shot tasks ([.vscode/tasks.json](../.vscode/tasks.json)); the
scripts live in [scripts/](../scripts/).

## Why managed export/import (and not a copy script)

Managed import **does not fire Cloud Functions triggers**. A hand-rolled
Admin-SDK copy would re-fire `onShoppingListItemWrite` (Gemini) and
`onCanonItemWritten` (icon generation) in the target project — burning cost and
mutating the very data you just copied. Managed export/import also doesn't bill
document reads, handles subcollections, and runs on your local CLI credentials.
It's also why this is **developer tooling, not an in-app admin button**: Cloud
Functions deploy from one codebase to both envs, so a wipe-and-restore callable
would also exist in prod.

## One-time setup

The export bucket must exist, and staging's Firestore service agent must be able
to read it. The scripts print these commands if something's missing.

```bash
# Create the export bucket co-located with prod's database. Firestore reports a
# multi-region database as nam5 / eur3, but `buckets create --location` wants the
# GCS multi-region name instead: nam5 -> US, eur3 -> EU. A regional database
# (e.g. europe-west2) uses that region directly. Prod (and staging) are nam5 -> US.
gcloud storage buckets create gs://s2-prod-e46bd-firestore-exports \
  --project=s2-prod-e46bd --location=US

# Let staging read the bucket (needed by the import step). Cross-project import
# requires BOTH storage.buckets.get and storage.objects.get on the bucket, so the
# staging service agent needs objectViewer AND legacyBucketReader — objectViewer
# alone is NOT enough (it omits storage.buckets.get, which import checks against
# the bucket root and fails with PERMISSION_DENIED on the bucket path).
NUM=$(gcloud projects describe s2-stage-ccb22 --format='value(projectNumber)')
for ROLE in roles/storage.objectViewer roles/storage.legacyBucketReader; do
  gcloud storage buckets add-iam-policy-binding gs://s2-prod-e46bd-firestore-exports \
    --member="serviceAccount:service-$NUM@gcp-sa-firestore.iam.gserviceaccount.com" \
    --role="$ROLE"
done

# (optional) auto-delete old exports after 7 days
gcloud storage buckets update gs://s2-prod-e46bd-firestore-exports \
  --lifecycle-file=/dev/stdin <<'JSON'
{ "rule": [ { "action": {"type": "Delete"}, "condition": {"age": 7} } ] }
JSON
```

You authenticate with your own `gcloud auth login` and `firebase login`; both
already grant you access to prod and staging via the deploy roles.

## Usage

1. Click **Export Prod Firestore**. It blocks until the export completes and
   prints the GCS path on success.
2. Click **Restore Staging from Prod**. It selects the newest export, prints the
   plan, and asks you to type `STAGING` before it wipes and restores.

## Safety

- The restore **hard-refuses** any target that isn't staging (it bails if the
  project equals prod or matches `/prod/i`).
- It requires typing `STAGING` to confirm before the destructive wipe.
- The export is read-only on prod.

## After a restore — re-apply staging-only config

A restore is a **full mirror**, so these come across from prod and may need
attention:

- **`appSettings` / `devSettings`** — env-specific config (Gemini model per role,
  kill-switches like canon-icon generation). Staging now holds prod's values;
  re-apply any staging overrides.
- **`chatSessions`** — real users' chat history (per-user, TTL'd) is now in
  staging. Fine for most testing, but be aware of it.
- **`members`** — staging's login allowlist is now prod's, so your real account
  can sign in. Note the export carries the `members` allowlist docs only —
  Firebase **Auth** accounts are separate, so you just re-authenticate and the
  `beforeMemberCreated` blocking function admits you.

## Refreshing dev-cloud with staging data

The same two-step flow refreshes the **dev-cloud** project (`s2-dev-eggman`) — the
ungated, deploy-from-any-branch, agent-reachable environment — from **staging**:

1. **Export Staging Firestore** — read-only managed export of staging to a GCS
   bucket ([scripts/export-staging-firestore.mjs](../scripts/export-staging-firestore.mjs)).
2. **Restore Dev from Staging** — wipes dev, then imports the newest export
   ([scripts/restore-firestore.mjs](../scripts/restore-firestore.mjs));
   asks you to type `DEV` and hard-refuses any target matching `/prod/i` or
   `/stag/i` (it only ever hits a `/dev/i` project).

### Or skip the hop: prod → dev-cloud directly

**Restore Dev from Prod** imports a **prod** export straight into dev-cloud. The
staging hop is pure latency when all you want is real-shaped data on dev: staging's
copy _is_ prod's copy, so round-tripping it through a second export/import changes
nothing but the wait. Run **Export Prod Firestore** first, then this.

It needs the same one-time grant as prod→staging, but for dev's service agent.
**This was applied on 2026-07-30** — dev (`277945741930`) now holds the same
`objectViewer` + `legacyBucketReader` pair on the prod exports bucket that staging
(`946977631175`) has always had. Recorded here in case the bucket is ever recreated:

```bash
NUM=$(gcloud projects describe s2-dev-eggman --format='value(projectNumber)')
for ROLE in roles/storage.objectViewer roles/storage.legacyBucketReader; do
  gcloud storage buckets add-iam-policy-binding gs://s2-prod-e46bd-firestore-exports \
    --member="serviceAccount:service-$NUM@gcp-sa-firestore.iam.gserviceaccount.com" \
    --role="$ROLE"
done
```

Note this is the **exports** bucket only. Neither dev nor staging has any IAM on
prod's _app_ bucket (`gs://s2-prod-e46bd.firebasestorage.app`) — see below.

## One script, three routes

All three restores are the same script — [scripts/restore-firestore.mjs](../scripts/restore-firestore.mjs),
invoked with a source/target pair:

```bash
node scripts/restore-firestore.mjs --from prod    --to staging
node scripts/restore-firestore.mjs --from staging --to dev
node scripts/restore-firestore.mjs --from prod    --to dev
```

Adding a route is a line in its `ROUTES` set. **`prod` is deliberately absent as a
target** — this script wipes what it touches, so "restore prod" must not be one
keystroke away. Beyond the route table, it re-checks the _resolved_ project ids
(which `SALT_*_PROJECT` env vars can change): it refuses a target matching
`/prod/i`, a target that doesn't look like the environment you named, and a
source and target that collapse to the same project.

One-time setup mirrors the prod→staging case, sourced from staging (both staging
and dev are `nam5` → GCS `US`):

```bash
# Export bucket in the staging project.
gcloud storage buckets create gs://s2-stage-ccb22-firestore-exports \
  --project=s2-stage-ccb22 --location=US

# Let DEV's Firestore service agent read it (needed by the import step).
NUM=$(gcloud projects describe s2-dev-eggman --format='value(projectNumber)')
for ROLE in roles/storage.objectViewer roles/storage.legacyBucketReader; do
  gcloud storage buckets add-iam-policy-binding gs://s2-stage-ccb22-firestore-exports \
    --member="serviceAccount:service-$NUM@gcp-sa-firestore.iam.gserviceaccount.com" \
    --role="$ROLE"
done
```

After a restore, dev's `appSettings`/`devSettings`/`chatSessions`/`members` hold
**staging's** values — same caveats as the prod→staging section above.

## Scope

Three routes: **prod → staging**, **staging → dev-cloud**, and **prod → dev-cloud**.
Local **dev** (the Firestore emulator with its own export-on-exit data,
[pnpm dev:emulators](../package.json)) is intentionally not a target of any of
them — "dev-cloud" above means the online `s2-dev-eggman` project, not the
emulator.

### Firestore only — imported images are read from the source project (deliberate)

None of these flows copy **Cloud Storage**, and that is a feature, not a gap.

Server-generated images — canon icons, product-form icons, equipment and
kitchen-tool pictograms, recipe hero images, and batch observation photos — are
served from URLs that embed the bucket name of the project that wrote them
([storageDownloadUrl.ts](../apps/cloud-functions/src/imaging/storageDownloadUrl.ts)),
so after a restore the target's _imported_ docs point at the **source** project's
bucket. The upshot is that staging and dev-cloud get a fully-populated UI —
hundreds of canon icons and recipe heroes, plus whatever batches came across —
**for free, with zero AI spend and no blob copying**.

Crucially this does not compromise creation testing. Both image writers call
`getStorage().bucket()`, which resolves to _the running project's own_ default
bucket, so anything created in dev or staging after an import writes to that
environment's own bucket and gets its own URL. Imported assets are borrowed;
new assets are local.

**This access is read-only, enforced twice over:**

1. **`storage.rules`** grants `allow read: if true` but **`allow write: if false`**
   on every image prefix Salt writes — today `canon-icons/`,
   `product-form-icons/`, `recipe-images/`, `batch-images/`, `equipment-icons/`
   and `kit-icons/`, and any later subject family joins them on the same terms;
   [storage.rules](../storage.rules) is the list that cannot go stale, and
   everything not named there is denied outright. The cross-project reads go through the Firebase Storage
   download endpoint, which _is_ governed by these rules. A non-prod client can read prod's images
   and structurally cannot write them. A dev-project auth token is not valid
   against prod's bucket either, so even a future `allow write: if request.auth != null`
   would evaluate `request.auth` as null and deny.
2. **IAM**: neither dev nor staging holds any binding on
   `gs://s2-prod-e46bd.firebasestorage.app`. The Admin SDK bypasses storage rules,
   but non-prod functions have no grant on prod's app bucket and never request one.

`sweepOrphanedStorage` is likewise contained: it calls `getStorage().bucket()` and
matches objects against doc ids **in its own project**, so a non-prod sweeper can
only ever delete non-prod objects.

The one accepted consequence: if prod deletes a recipe, prod's sweeper removes that
hero image, and any environment still holding the imported doc shows a broken image
until its next refresh. Self-healing and cheap. See issue #645.
