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
- `WILDCARD_IDS=yes` — adds a `path_params` column holding the captured
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
JOIN `s2-prod-e46bd.firestore_export.batches_raw_latest` b
  ON b.document_id = JSON_VALUE(o.path_params, '$.batchId')
ORDER BY recipe, observed_at
```

The numeric fields are each their own value on the document, so "how quickly did
the last three bresaola dry" is an `AVG` over a column rather than a person
re-reading ninety days of prose. A reading that is a note or a photo leaves the
numbers null, so aggregate with `AVG`/`MIN`/`MAX`, which skip nulls, rather than
dividing by `COUNT(*)`.

Scope note on the join: `path_params` is written to the raw changelog by
`WILDCARD_IDS=yes`, and the query above reads it from the `_raw_latest` view.
That the view carries the column through is the extension's behaviour and not
something this repo can assert — confirm it once against the real tables when
the instances are installed, and fall back to `batchObservations_raw_changelog`
if it does not.

Selecting "all the whole muscle cures" needs a recipe kind and a category frozen
onto the run; that is a separate issue and not built here. When those fields
exist on the document they appear in `data` with no change to this export.

## Install (one-off, as an owner)

```bash
cd infra/bigquery-export
npx firebase deploy --only extensions --project s2-prod-e46bd --non-interactive --force
```

The project id is spelled out rather than aliased — deliberate friction for a
prod-only operation. Installing on another environment is possible but pointless
noise; the BigQuery dataset would just mirror that environment's own project.

Adding an instance means re-running that same command: it reconciles the whole
manifest, installing what is new. Read the plan it prints before confirming, and
expect it to touch only the instances you added — an **update** to an
already-installed instance restarts its function and can leave a gap in the
changelog, so an unexpected update in that plan is a reason to stop rather than
to press on. All six are pinned at `@0.3.3` precisely so a re-run has nothing to
upgrade.

## Backfill (immediately after install)

The changelog only accrues from install; the import script backfills the
current state of pre-existing docs as `IMPORT` rows. Run it per collection,
**after** the extension has created the tables.

> **Done on prod 2026-08-03** — recipes 46, canonItems 219, productForms 6,
> cookSessions 4. This is a **one-shot**: the script has no idempotency, so a
> second run appends a duplicate set of `IMPORT` rows. Re-run only after a table
> rebuild.
>
> **`batches` and `batchObservations`: not yet run.** Record the date and the
> row counts here when they are, in the same form as the line above, so the next
> reader knows the one-shot has been spent.

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
hard `[ERROR] QueryCollectionGroup is not specified.` — including on the two
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
