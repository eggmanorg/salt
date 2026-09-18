# Runbook — Firestore TTL policies (issue #1008)

**Two collections are swept by Firestore's TTL machinery: `chatSessions` and
`timerDeliveries`. Both are swept on a field called `expiresAt`, and neither
policy is applied by anything in this repository.** A TTL policy is per-project
infrastructure — it lives in no deployed artefact, no CI job applies it, and
nothing notices if it is missing. This file is the procedure.

Run it once per project, in order: **deploy → migrate → count → enable →
verify**. Enabling is the one irreversible act in the whole procedure, so it is
deliberately its own step per project — dev, then staging, then prod — and no
command in this file arms more than one project per invocation.

## State of play — verified 2026-09-03

Read against the three projects on that date. **This is a log, not a plan**:
re-check with `gcloud firestore fields ttls list --project=<P>` before acting on
any row of it.

| Project          | Migrated (Step 2)                                                                                                              | Policies armed (Step 4)             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `s2-dev-eggman`  | **no** — 31 chat sessions still hold ISO strings; 2 ledger docs still hold an epoch-ms `deliveredAt` and no `expiresAt` at all | no                                  |
| `s2-stage-ccb22` | **yes** — every `chatSessions` and `timerDeliveries` document holds `Timestamp`s                                               | no                                  |
| `s2-prod-e46bd`  | **yes**                                                                                                                        | **yes — both collections `ACTIVE`** |

**Production is armed and has already swept, deliberately — Daniel armed it, and
it stays on.** Its ledger holds 9 documents, all with a future expiry, the oldest
delivered 2026-08-23 — exactly the shape the `timerDeliveries` bullet below
predicts. Dev and staging are _behind_ prod, not ahead of it: the dev → staging →
prod order below is the order to follow, not the order this actually happened in,
so do not read an armed prod as evidence that the dev and staging gates were
walked, and do not read an unarmed dev as a reason to disarm prod.

## Why this exists

A TTL policy only expires a document whose TTL field holds a Firestore
**`Timestamp`**. A string, a number, or an absent field is skipped **in
silence** — no error, no log, no metric. Salt wrote both fields as neither:

- `chatSessions.expiresAt` was an ISO-8601 **string** from #206 until #1008. The
  14-day / 18-month retention was documented, tested and completely fictional.
  Measured on `s2-stage-ccb22` on 2026-08-25: **42 of 76** chat sessions sat past
  their own recorded expiry, all still present.
- `timerDeliveries` carried an epoch-ms **integer** `deliveredAt` and no expiry
  field at all. Three producers, no deleter, no sweep: 23 documents and only ever
  growing.

#1008 fixed the **write** paths (every new write produces `Timestamp`s, held
there by unit tests at all four write sites) and shipped
`scripts/migrate-ttl-timestamps.mjs` for the documents already written. What it
deliberately did **not** do is run anything: the moment a policy arms, those 42
chats become deletable, and that happens on your schedule, per project, never as
a side effect of a deploy or a CI run.

## What gets deleted, and what does not

- **The 42 past-expiry staging chats (and their prod equivalents) go.** They are
  general (non-recipe) chats already past the retention the product has
  documented since #206. Firestore deletes an expired document within roughly
  24–72 hours of its expiry — the sweep is a background process with no SLA, so
  a policy enabled today shows its effect over the following days, not
  immediately.
- **The 31 pre-#939 sentinel chats stay**, and that is correct. They carry
  `expiresAt: 9999-12-31T23:59:59.999Z`, written before #939 replaced "never"
  with an 18-month window. The migration converts the type and never the instant,
  so they become a year-9999 `Timestamp` — valid, and effectively unexpiring
  until the next turn of that conversation restamps it to 540 days, exactly as
  #939 designed. A migration that silently shortened a recorded expiry would
  delete data nobody agreed to delete.

  **540 for every one of them, never the general-chat 14.** `chatExpiresAt`
  (`packages/domain/src/chat/queries/chatExpiry.ts`, which every writer of a chat
  document delegates to — #1430 moved it out of the adapter so the `chefChat`
  flow could call it without importing `firebase-sync`)
  picks the fortnight when `recipeId === null`, so an _unattached_ sentinel would
  restamp to 14 days — but no such document can exist. The write that produced the
  sentinel ran only under `recipeId !== null` (#707), and nothing ever clears a
  session's `recipeId` back to null (`attachRecipeToSession` is first-claim-wins
  and there is no un-attach path). Both windows are pinned by the `WINDOWS` table
  in `packages/adapters/firebase-sync/tests/chatSessionRetention.test.ts`.
  Measured on `s2-stage-ccb22` on 2026-09-03: 36 sentinels, **none** with a null
  `recipeId`.

- **`timerDeliveries` docs expire 14 days after delivery. The first sweep takes
  the ones already past that — not the whole ledger.** The migration derives each
  document's `expiresAt` from **its own `deliveredAt`**, never from the day the
  migration runs (`scripts/lib/ttlMigrationPlan.mjs`; the derivation and the
  "an old document gets an expiry already in the past" property are both pinned by
  `scripts/tests/ttlMigrationPlan.test.mjs`). So a delivery from three months ago
  is expired the instant the field is written, and last Tuesday's is not. Expect
  the ledger to fall to _whatever was delivered in the last fortnight_, and to
  keep draining on a rolling basis after that — never to zero while timers are
  still firing. Prod bears this out: armed and swept, it still holds 9 ledger
  documents, all future-dated. The window is `TIMER_DELIVERY_RETENTION_MS` in
  `apps/cloud-functions/src/triggers/timerDeliveryRetention.ts`; the ledger only
  has to outlive a duplicate dispatch, and Cloud Tasks retries span minutes (≤5
  attempts, seconds-to-minutes backoff) while a re-timed timer changes the ledger
  key entirely.

## Order matters

**Deploy before you migrate.** A client running the pre-#1008 bundle writes a
string `expiresAt` on every chat turn. The read path tolerates that for ever by
design (a too-tight read would silently empty a user's chat list — the
subscription skips documents that fail validation), but a stale client writing
strings behind a migration means documents the policy will not sweep. Deploy
first; re-run the migration later if you find stragglers — it is idempotent.

**Migrate before you enable.** Not strictly required — an unconverted document is
skipped rather than mishandled — but enabling first means a policy that appears
to be doing nothing, which is exactly the failure mode this whole issue is about.

**Count before you enable.** The baseline is only meaningful between the two
(Step 3), and once a policy is armed there is no way back to a "before" number.

---

## Step 1 — deploy

Functions and PWA, per the usual route for that project
([docs/releases.md](../releases.md)). The functions carry the new ledger write
shape; the PWA carries the `Timestamp` chat write and the tolerant read.

## Step 2 — migrate the existing documents

Once per collection per project. It needs your `gcloud` account
(`gcloud auth login`) and nothing else.

**It has run on staging and prod, and never on dev** (see _State of play_). The
`--dry-run` on dev below is genuinely its first run there, and the dev `--apply`
is the first `PATCH` that project has seen. Read the dry-run output rather than
skimming it.

```bash
# Preview first — reads only, writes nothing, and prints every document it would touch.
node scripts/migrate-ttl-timestamps.mjs --project dev --collection chatSessions    --dry-run
node scripts/migrate-ttl-timestamps.mjs --project dev --collection timerDeliveries --dry-run

# Then write.
node scripts/migrate-ttl-timestamps.mjs --project dev --collection chatSessions    --apply
node scripts/migrate-ttl-timestamps.mjs --project dev --collection timerDeliveries --apply
```

`--project` takes `dev` | `staging` | `prod` (→ `s2-dev-eggman`,
`s2-stage-ccb22`, `s2-prod-e46bd`). **Production additionally requires
`--confirm production` as a flag** — there is no interactive prompt, deliberately:
a shell without a TTY on stdin hangs on one having already printed a full write
plan, which reads exactly like a crash mid-write.

```bash
node scripts/migrate-ttl-timestamps.mjs --project prod --collection chatSessions \
  --apply --confirm production
```

Each write is a field-level REST `PATCH` (`updateMask.fieldPaths`), so a
concurrent client write to the same document is never clobbered and message
history is neither read nor rewritten. The script is **idempotent**: a document
already holding `Timestamp`s is counted and skipped, so re-running is free and is
how you mop up after a stale client.

## Step 3 — take the baseline count

**After that project's Step 2, and before its Step 4.** This is the number you
will watch drain, and there is exactly one moment it can be taken.

Before Step 2 has run, the count is **0 on every project** — and for the wrong
reason. The filter compares against a `timestampValue`, and a document still
holding a string does not match it at all. A 0 here reads as "nothing to sweep"
while being the very silent skip this whole issue exists to kill. After Step 2 it
means what it says.

Firestore aggregation over the REST API, as the same `gcloud` identity. One
project, one collection per invocation:

```bash
P=s2-dev-eggman     # then s2-stage-ccb22, then s2-prod-e46bd — one at a time
C=chatSessions      # and again with timerDeliveries
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H 'Content-Type: application/json' \
  "https://firestore.googleapis.com/v1/projects/$P/databases/(default)/documents:runAggregationQuery" \
  -d '{"structuredAggregationQuery":{"aggregations":[{"count":{},"alias":"n"}],
       "structuredQuery":{"from":[{"collectionId":"'"$C"'"}],
       "where":{"fieldFilter":{"field":{"fieldPath":"expiresAt"},"op":"LESS_THAN",
       "value":{"timestampValue":"'"$NOW"'"}}}}}}'
```

On `s2-stage-ccb22` expect roughly **42** for `chatSessions` once Step 2 has been
applied there.

For `timerDeliveries`, **expect fewer than the collection holds**. 23 was the
whole ledger when it was counted, not the past-expiry subset; this query returns
only documents delivered more than 14 days ago, because the migration derives
each expiry from its own delivery instant (see _What gets deleted, and what does
not_). A ledger that has seen recent deliveries will show a count well below its
document count, and that is correct, not a sign the migration was skipped.

Write the numbers down — they are the "before" that Step 5 compares against.

## Step 4 — enable the policies, one project at a time

This is the step that arms the sweep, and the only irreversible act in the
procedure: within 24–72 hours Firestore permanently deletes every matching
document, with no trigger, no tombstone and no undo short of a restore from a
backup. Each substep below is its own gate — run one, then stop.

### Step 4a — dev

Gate: dev deployed (Step 1), dev migrated (Step 2), dev baseline recorded
(Step 3).

```bash
P=s2-dev-eggman
gcloud firestore fields ttls update expiresAt \
  --collection-group=chatSessions --enable-ttl --project="$P"
gcloud firestore fields ttls update expiresAt \
  --collection-group=timerDeliveries --enable-ttl --project="$P"
gcloud firestore fields ttls list --project="$P"
```

The policy takes a few minutes to build before it begins expiring documents.

### Step 4b — staging, then soak

Gate: **dev armed and seen to drain**, staging deployed and migrated, staging
baseline recorded. Then the same two commands with `P=s2-stage-ccb22`:

```bash
P=s2-stage-ccb22
gcloud firestore fields ttls update expiresAt \
  --collection-group=chatSessions --enable-ttl --project="$P"
gcloud firestore fields ttls update expiresAt \
  --collection-group=timerDeliveries --enable-ttl --project="$P"
gcloud firestore fields ttls list --project="$P"
```

**Then wait.** Watch staging's count with Step 5 over the next 24–72 hours until
it drains to near zero and stays there, and confirm the 31 sentinels are still
present. That soak is the only evidence the policy sweeps what is expected and
nothing else, and it is what stands between prod and an irreversible delete.

### Step 4c — production

Gate: **staging drained and the sentinels confirmed still present**, prod
deployed and migrated, prod baseline recorded, and a current prod export in hand
(`scripts/export-prod-firestore.mjs`). Only then:

```bash
P=s2-prod-e46bd
gcloud firestore fields ttls update expiresAt \
  --collection-group=chatSessions --enable-ttl --project="$P"
gcloud firestore fields ttls update expiresAt \
  --collection-group=timerDeliveries --enable-ttl --project="$P"
gcloud firestore fields ttls list --project="$P"
```

## Step 5 — verify

Re-run the Step 3 count for the project you just armed, on both collections.
Expect it to fall to (near) zero over the following 24–72 hours, and to stay
there. Note the filter compares against a `timestampValue`: an unconverted string
document does not match it at all, which is a second way to see that the
migration did its job.

## Step 6 — abort: disarm a policy

The reverse of Step 4, one collection and one project per invocation:

```bash
P=s2-stage-ccb22
gcloud firestore fields ttls update expiresAt \
  --collection-group=chatSessions --disable-ttl --project="$P"
gcloud firestore fields ttls update expiresAt \
  --collection-group=timerDeliveries --disable-ttl --project="$P"
gcloud firestore fields ttls list --project="$P"
```

**`--disable-ttl` stops future expiry only. It does not bring back a document
that has already been swept** — that deletion is permanent, fires no trigger, and
the only route back is a restore from a backup. Disarming is how you stop a sweep
that is going wrong, not how you undo one that has already run.

## Gotchas

- **A silently-skipped field is the whole defect.** If a count does not drain,
  the first thing to check is the stored type, not the policy: re-run the
  migration in `--dry-run` and see whether it reports documents still to convert.
- **The policy is not in the repo, and never will be.** Nothing in CI applies,
  verifies or notices it; CI has no business talking to a live project. The
  repository's half of the contract is the field type, and that is what the unit
  tests at the four write sites hold.
- **A new collection with an `expiresAt` gets nothing for free.** It needs its
  own `gcloud firestore fields ttls update`, in every project, or its retention
  is decorative in exactly the way this issue documents.
- **Deleting through TTL fires no trigger.** There is no `onDocumentDeleted`
  hook wired to either collection, and nothing downstream depends on the
  documents' continued existence — that is what makes both safe to sweep.
