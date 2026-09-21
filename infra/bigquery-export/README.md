# Firestore → BigQuery export (issues #684, #1403)

Streams every document write in `recipes`, `canonItems`, `productForms`,
`cookSessions`, `batches` and `batches/{batchId}/observations` to an append-only
BigQuery changelog, via six instances of the
[`firebase/firestore-bigquery-export`](https://extensions.dev/extensions/firebase/firestore-bigquery-export)
extension. This is the app's only history: Firestore is delete-means-delete with
full-document LWW, so past states exist nowhere else. `chatSessions` is
deliberately **excluded** — chat volume is measured by content-free PostHog
events, and streaming those docs would persist message content past the
collection's TTL.

Nothing is stripped from what _is_ streamed. An observation's free-text note and
its photo URL go across with its numbers, because the note is the log ("smells
sweet, no mould", "cased today") and a changelog of numbers alone answers "how
fast did it dry" and nothing else. The `chatSessions` reasoning does not carry
over: `batches` has no TTL, so nothing here outlives its source. This is also a
different question from CLAUDE.md's error-reporting scrub, which governs what is
attached to a **PostHog event**, not what is mirrored into the project's own
dataset.

## Why this directory is not in the root `firebase.json`

Both deploy workflows run a bare `firebase deploy` (no `--only`), so an
`extensions` block in the root config would make CI install these on **staging**
at the next merge to `main` — and fail there anyway, because the deployer SA
holds no BigQuery/extensions grants (the same silent-failure shape as the Cloud
Tasks / Cloud Scheduler traps in [docs/releases.md](../../docs/releases.md)).
This is a **production-only, one-off owner install**, so its manifest lives here
where no workflow can see it.

## Why the observation log is a second instance

An instance watches **one** collection path and does not descend into
subcollections — the extension's own pre-install documentation says so. So an
instance on `batches` alone exports no readings at all, which is the half of the
data the log is about. `batches/{batchId}/observations` is therefore its own
install, `bq-export-batch-observations`, carrying two parameters the other five
do not:

- `COLLECTION_PATH=batches/{batchId}/observations` — the extension's
  `{wildcard}` notation, not a Firestore collection-group name. The bare group
  name `observations` matches the same documents as things stand
  (`apps/cloud-functions/src/maintenance/storageSweepTargets.ts` records that
  `batches/{batchId}/observations` is the only collection in the database using
  it), but it asserts no parent, so a later `observations` subcollection under
  something else would widen the export with nothing saying so. The wildcard
  form is the same query with the parent named.
- `WILDCARD_IDS=true` — adds a `path_params` column holding the captured
  `batchId` as a JSON string. Without it an observation row carries its own
  document id and no parent, and a reading cannot be traced to the run it came
  from.

The table is `batchObservations`, not `observations`: the other table ids equal
their collection name because those names are unambiguous at the root, and a
bare `observations` would read as a top-level collection that does not exist.

### Joining an observation to its batch

`path_params` is a JSON string, so the join goes through `JSON_VALUE`:

```sql
SELECT
  JSON_VALUE(b.data, '$.recipeTitle') AS recipe,
  JSON_VALUE(o.data, '$.at') AS observed_at,
  CAST(JSON_VALUE(o.data, '$.weightGrams') AS FLOAT64) AS weight_g,
  CAST(JSON_VALUE(o.data, '$.temperatureC') AS FLOAT64) AS temp_c,
  CAST(JSON_VALUE(o.data, '$.relativeHumidityPercent') AS FLOAT64) AS rh_pct,
  JSON_VALUE(o.data, '$.note') AS note
FROM `s2-prod-e46bd.firestore_export.batchObservations_raw_latest` o
LEFT JOIN `s2-prod-e46bd.firestore_export.batches_raw_latest` b
  ON b.document_id = JSON_VALUE(o.path_params, '$.batchId')
ORDER BY recipe, observed_at
```

It is a `LEFT JOIN`, not an inner one: `batches` is delete-means-delete like
every other collection here, so a run whose document has since been removed
would otherwise silently drop its observation rows too. The changelog is the
point of this export — an inner join would re-impose the deletion the export
exists to survive, leaving `recipe` null for those rows instead.

The numeric fields are each their own value on the document, so "how quickly did
the last three bresaola dry" is an `AVG` over a column rather than a person
re-reading ninety days of prose. A reading that is a note or a photo leaves the
numbers null, so aggregate with `AVG`/`MIN`/`MAX`, which skip nulls, rather than
dividing by `COUNT(*)`.

Scope note on the join, **settled on prod 2026-09-18**: `WILDCARD_IDS=true` puts
`path_params` on `batchObservations_raw_changelog`, and `batchObservations_raw_latest`
selects it through unchanged (`path_params AS path_params` in the view's own SQL).
The query above therefore works as written against the view; no fallback to the
changelog is needed.

Selecting "all the whole muscle cures" needs a recipe kind and a category frozen
onto the run; that is a separate issue and not built here. When those fields
exist on the document they appear in `data` with no change to this export.

## Install (one-off, as an owner)

### First install into an empty project

```bash
cd infra/bigquery-export
npx firebase deploy --only extensions --project s2-prod-e46bd --non-interactive --force
```

The project id is spelled out rather than aliased — deliberate friction for a
prod-only operation. Installing on another environment is possible but pointless
noise; the BigQuery dataset would just mirror that environment's own project.

### Adding an instance later — do NOT re-run the command above

That command reconciles the **whole** manifest, and reconciling is not the same
as installing what is new. `firebase deploy --only extensions` sorts every
instance in `firebase.json` into create / update / configure by instance id and
extension ref **alone** — it never compares parameters
(`isConfigure` in `firebase-tools/lib/deploy/extensions/prepare.js` is literally
`same instanceId && refs.equal(ref)`). So every instance already installed at the
same version lands in "will be configured" on every run, unchanged or not, and
the configure task then issues a real `configureInstance` API call against each
one. Configuring restarts an instance's function, which is exactly the gap in the
changelog this export exists to prevent.

The plan printed by `--dry-run` therefore says "The following extension instances
will be configured" listing all the existing ones **every time**. That line is not
evidence that anything changed and it is not a reason to stop; it is what a
whole-manifest re-run does. Reading the plan does not protect you here, because
the plan is telling the truth.

Deploy a scratch manifest holding **only** the new instances instead:

```bash
D=$(mktemp -d)
mkdir -p "$D/extensions"
cp extensions/<the-new-instance>.env "$D/extensions/"
cat > "$D/firebase.json" <<'EOF'
{ "extensions": { "<the-new-instance>": "firebase/firestore-bigquery-export@0.3.3" } }
EOF
cd "$D"
npx firebase deploy --only extensions --project s2-prod-e46bd --non-interactive
```

**Omit `--force`, and do not add it.** The instances missing from the scratch
manifest are reported as "found in your project but do not exist in
`firebase.json`" and offered for deletion. In non-interactive mode that prompt
returns its default, which is _no_, so they are left strictly alone —
`--force` answers _yes_ and deletes every export you did not list. The flag that
makes the first install unattended is the flag that makes this one destructive.

`infra/bigquery-export/firebase.json` remains the full six-instance record of
what is installed; the scratch copy is a throwaway deploy target and is not
checked in.

All six are pinned at `@0.3.3` so that no run has anything to _upgrade_; the pin
does not stop a whole-manifest run from _configuring_ them, which is the point
above.

### What install does and does not create

Creating an instance does **not** create its BigQuery table or view — verified on
prod 2026-09-18, where the dataset held only the four pre-existing table/view
pairs after `bq-export-batches` and `bq-export-batch-observations` went ACTIVE.
The tables appear when something first writes: the backfill below, or the live
extension on the collection's next document write. Do not read an absent table
straight after install as a failed install.

## Backfill (immediately after install)

The changelog only accrues from install; the import script backfills the
current state of pre-existing docs as `IMPORT` rows. Run it per collection,
immediately after installing that collection's instance. The script creates the
dataset, table and view itself if they are not there yet — the install does not
(see "What install does and does not create" above), so there is nothing to wait
for.

> **Done on prod 2026-08-03** — recipes 46, canonItems 219, productForms 6,
> cookSessions 4. This is a **one-shot**: the script has no idempotency, so a
> second run appends a duplicate set of `IMPORT` rows. Re-run only after a table
> rebuild.
>
> **Done on prod 2026-09-18** — batches 1. `batchObservations` **0 — no backfill
> was possible and none was needed**: the collection group was empty, and the
> import tool refuses an empty source outright (see below). Its tables were
> created by that refused run and are live; every reading logged from
> 2026-09-18 onward streams in through the extension. Nothing pre-dating that
> day exists to recover, so the one-shot for `batchObservations` is **not**
> spent — if the collection is somehow populated out of band before the app
> writes to it, it can still be run once.

`npx` cannot run the tool directly: a fresh install resolves
`@firebase/database-compat` 2.1.5, whose standalone bundle requires an
`@firebase/app` peer that does not get installed, so the CLI dies on
`MODULE_NOT_FOUND` before it does anything. Same breakage that hit Cloud
Functions installs on 2026-07-30. Pin it in a throwaway directory:

```bash
mkdir -p /tmp/bq-import && cd /tmp/bq-import
cat > package.json <<'EOF'
{
  "name": "bq-import-runner",
  "private": true,
  "version": "1.0.0",
  "overrides": { "@firebase/database-compat": "2.1.4" },
  "dependencies": { "@firebaseextensions/fs-bq-import-collection": "latest" }
}
EOF
npm install
```

Then, per collection:

```bash
./node_modules/.bin/fs-bq-import-collection \
  --non-interactive \
  --project s2-prod-e46bd \
  --big-query-project s2-prod-e46bd \
  --source-collection-path recipes \
  --dataset firestore_export \
  --table-name-prefix recipes \
  --dataset-location us \
  --query-collection-group false \
  --multi-threaded false \
  --use-new-snapshot-query-syntax true \
  --firestore-instance-id '(default)'
# repeat for: canonItems, productForms, cookSessions, batches
# (matching --table-name-prefix; all five are root collections, so
#  --query-collection-group stays false)
```

The observation log is the one that differs, because it is a subcollection. Same
command, with the wildcard path quoted so the shell does not touch the braces,
the table prefix matching `TABLE_ID`, and the collection-group flag **true**:

```bash
./node_modules/.bin/fs-bq-import-collection \
  --non-interactive \
  --project s2-prod-e46bd \
  --big-query-project s2-prod-e46bd \
  --source-collection-path 'batches/{batchId}/observations' \
  --dataset firestore_export \
  --table-name-prefix batchObservations \
  --dataset-location us \
  --query-collection-group true \
  --multi-threaded false \
  --use-new-snapshot-query-syntax true \
  --firestore-instance-id '(default)'
```

The last four flags are not optional padding. `--non-interactive` suppresses the
prompts but supplies no defaults, so omitting `--query-collection-group` is a
hard `[ERROR] QueryCollectionGroup is not specified.` — including on all five
root-collection runs, where the answer is simply `false`. And
`--use-new-snapshot-query-syntax true` must mirror the extension's
`USE_NEW_SNAPSHOT_QUERY_SYNTAX=yes` — the flag decides how the import rewrites
the `_raw_latest` view, so a mismatch leaves the view disagreeing with the
changelog the live extension is writing.

Verify the backfill by counting the views against the source of truth:

```sql
SELECT COUNT(*) FROM `s2-prod-e46bd.firestore_export.recipes_raw_latest`
```

For `recipes`, `canonItems` and `productForms` that source is the daily
`volumetrics.snapshot` PostHog event. It does **not** cover the other three:
`apps/cloud-functions/src/maintenance/snapshotVolumetrics.ts` counts those three
collections and no others, so `cookSessions`, `batches` and the observation log
are checked against a Firestore console count instead. Whether they earn a place
in the daily snapshot is a separate question and deliberately not settled here.

### An empty source collection is a hard error, not a zero-row import

`fs-bq-import-collection` calls `verifyCollectionExists` before it reads
anything, and that check throws on an empty source:
`Failed to access collection: No documents found in collection group:
<name>` (or `Collection does not exist or is empty: <path>` for a root
collection). There is no "imported 0 rows" outcome.

This is benign and it is worth knowing before it happens. The check runs _after_
the tool has created the dataset, changelog table and view, so a refused run
still leaves a correctly-shaped, empty, live table behind — which is precisely
the state you want for a collection whose history starts now. It is what
happened to `batchObservations` on 2026-09-18. Treat the error as "there was
nothing to backfill", not as a failure to investigate.

## What you get

Dataset `firestore_export` in the prod project, per collection:

- `<collection>_raw_changelog` — one row per write: `timestamp`, `document_id`,
  `operation` (`CREATE`/`UPDATE`/`DELETE`/`IMPORT`), full doc as JSON in `data`.
  On `batchObservations` only, also `path_params` — see the join above.
- `<collection>_raw_latest` — view of the current collection state.

Table ids are the collection names, except `batchObservations` for
`batches/{batchId}/observations`.

Query in the BigQuery console (`JSON_VALUE(data, '$.kind')` etc.). No standing
dashboards on this — the consolidated PostHog dashboard is the viewing surface;
this is the vault for history and ad-hoc SQL.

## Parameter notes

- `DATABASE_REGION=nam5` / `DATASET_LOCATION=us`: the Firestore database is
  **nam5 (US multi-region)** — verified with
  `gcloud firestore databases describe --project s2-prod-e46bd`, not assumed
  from the europe-west2 functions region. The dataset colocates with the source.
- No partitioning/clustering/materialized views: the data is megabytes; the
  free-tier defaults are the right size. Partitioning cannot be changed on an
  existing table, so revisit only alongside a table rebuild.

## The `.env` files are checked against the pinned schema (`pnpm bqext:check`)

An extension parameter the extension does not recognise is **not** an error at
install time: it is dropped and the declared default takes its place, and the
install goes green. That makes a wrong setting invisible — in review, in CI, and
on the install that reaches production. It happened once: PR #1424 shipped
`WILDCARD_IDS=yes`, where this extension only understands `true` and `false`, so
every batch observation would have streamed with no reference to the run it came
from, permanently, from that day on. A person was the only thing that caught it.

`scripts/check-bigquery-extensions.mjs` runs as a step in CI's **Static checks**
job. It reads three things off disk — `firebase.json`, `extensions/*.env`, and
the extension manifest vendored at `vendor/` — and **contacts nothing**. It
never invokes `firebase`, for the reason the install section above spells out:
a whole-manifest `deploy --only extensions` reconciles and restarts every
instance, and `--force` on a partial manifest deletes the ones it omits.

What it asserts, per `.env`:

- every key present is a parameter the extension declares (so `WILDCRD_IDS` is
  as red as a bad value);
- a `select` parameter's value is one of its declared options, compared as
  strings — `WILDCARD_IDS`'s options are `true`/`false` while
  `USE_NEW_SNAPSHOT_QUERY_SYNTAX`'s adjacent ones are `yes`/`no`, and that
  asymmetry is what made #1424 plausible;
- a `string` parameter's value matches the extension's own `validationRegex`
  (`COLLECTION_PATH`, `DATASET_ID`, `TABLE_ID` and the rest);
- a parameter that is `required` with **no declared default** is present — in
  0.3.3 that is `DATABASE_REGION` alone;
- `firebase.json` and the `.env` files agree in both directions, and every ref
  matches the vendored schema's own `version:`.

**What it cannot see, stated because the boundary is the honest claim:** a
parameter _omitted_ from an `.env` whose extension default is wrong for Salt.
Roughly a dozen parameters are deliberately omitted across the six files —
`BIGQUERY_PROJECT_ID`, `LOG_LEVEL`, `TABLE_PARTITIONING` and the rest all take
sensible declared defaults — so flagging absence wholesale would need an
allowlist of exceptions, and an allowlist is a thing people learn to append to.
Whether a taken default is _right_ is a judgement about intent, and it is
recorded in "Parameter notes" above rather than enforced by the script. The
other known gap: nothing checks the instance ids against what is actually
installed on prod, which would need a live read of the project.

**Re-vendoring is part of a version bump, not a follow-up to one.** Bumping a
ref in `firebase.json` without replacing `vendor/*.extension.yaml` fails the
check, because validating against a schema the install no longer uses is the
same silent wrongness the check exists to stop. The vendored file is byte-for-
byte upstream below its header and is in `.prettierignore` for that reason —
never hand-edit it.
