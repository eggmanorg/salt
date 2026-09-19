# Runbook — re-inferring the library's recipe kit (#954)

Owner of the mechanism: `scripts/backfill-recipe-kit.mjs`, `scripts/lib/recipeKitRequest.mjs`,
the `identifyRecipeKit` flow, and the kit branch of `onRecipeWritten`. **The reasoning
behind each of those lives beside the code** — this file holds only what the code cannot
say: the order the three environments are done in, the two ways a run silently does
nothing, and the one judgement call the run exists to settle.

## What this is remediating

Before #954 the kit flow was told `no brand names`, and the appliance clause named
`"food processor"` as the _desired_ output form. So a method that says
_"Run the **Magimix Cook Expert** on a slow cook setting"_ was stored as `slow cooker`,
and _"the straight blade on your **OXO Good Grips Chef's Mandoline**"_ as `mandoline` —
in a kitchen holding **two mandolines** and **four-plus things that answer to "food
processor"**. The names were discarded, not unknown: they were in the text the flow was
handed.

Phases 1 and 2 fixed the flow (it is now handed the manifest and told never to
generalise a named appliance) and the display (an equipment-named label draws its own
`equipmentIcons` pictogram, resolved _before_ `kitchenTools`). Nothing re-asks the
recipes already stored. This is that pass.

## Order, and why it is this order

The script does not infer anything. It PATCHes a `kitRequestedAt` nonce — and, under
`--redo`, deletes the `kitInferredAt` stamp — and the deployed `onRecipeWritten` trigger
does the work. So **the functions must be deployed to an environment before the script
is pointed at it.**

That is worse here than it is for the times backfill, and the difference is the reason
this paragraph exists. Pointed at a project whose functions predate #954, a `--redo` run
does not merely change nothing: the _old_ flow answers, spending one AI call per recipe
to write the generalised label back again. Deploy first.

For each of `dev` → `staging` → `prod`, in that order:

1. **Deploy** the functions to that project. Confirm the kit branch carries #954 (the
   `equipment` field reaching `identifyRecipeKitFlow`) before continuing.
2. **Dry run** — lists what would be asked and, under `--redo`, the labels each recipe
   stores today, so you can see what you are about to replace:
   `node scripts/backfill-recipe-kit.mjs --project dev --redo --dry-run`
3. **Apply**: `node scripts/backfill-recipe-kit.mjs --project dev --apply --redo`
   (prod additionally needs `--confirm production`; there is no interactive prompt —
   see the script header for the scar behind that.)
4. **Wait a minute or two.** The script's last line is the request landing, not the
   answer. The kit lists arrive as the trigger works through them.
5. **Verify**: `node scripts/backfill-recipe-kit.mjs --project dev --verify`
   Exit code 0 means every cookable recipe **currently carries** a `kitInferredAt`
   stamp — not that this run is what stamped it, and not that every cookable recipe
   is stampable at all. See "What exit code 0 does and does not prove" below before
   treating it as a completeness signal. It also prints each recipe's stored
   labels — read a sample of those against the method text, because "is this the
   right appliance?" is a judgement no exit code can make.

Do not start `staging` until `dev` verifies clean, and do not start `prod` until
`staging` does. Dev is a copy of staging data and staging a copy of prod
([data-refresh.md](../data-refresh.md)), so each run is a rehearsal of the next on
realistic content. Read the printed per-recipe list before moving on, not just the
exit code — the next section is why.

## What exit code 0 does and does not prove

`--verify`'s exit code answers exactly one question: does every cookable recipe
_currently_ carry a `kitInferredAt` stamp? It does **not** answer either of the two
questions "this environment is done" would actually need, and both are tracked as
follow-ups rather than fixed here:

- **It cannot tell this sweep's stamp from an old one.** The check is presence, not
  provenance. Interrupt `--apply --redo` partway — Ctrl-C, a dropped connection, the
  one `gcloud` token fetched at startup expiring mid-run — and every recipe the
  interrupted run never reached still carries whatever stamp it had before. In the
  pre-remediation state that is the stamp the _pre-#954_ inference left, so
  `--verify` prints `done` for those recipes exactly as it would for one this sweep
  actually re-asked, and exits 0 on a sweep that stopped at recipe 40 of 200. A
  `--since <ms>` run threshold — compare the stamp against the sweep's own start
  time instead of merely checking presence — would close this, and is filed as a
  follow-up rather than implemented here.
- **A step-less cookable recipe can never verify clean.** `maybeInferKit`
  deliberately returns without stamping when `recipe.steps.length === 0` — there is
  no method to infer a kit from. That recipe counts PENDING forever; no re-run
  closes it, so `--verify` can sit at exit 1 for an environment that has otherwise
  fully processed. This is expected residue, not a stalled sweep — but the runbook
  currently gives no way to tell the two apart from the exit code alone. Reporting
  a step-less recipe as its own line, distinct from PENDING, is filed as a
  follow-up rather than implemented here.

Treat exit 0 as necessary, not sufficient: read the per-recipe listing, and know
that a lingering PENDING may be a step-less recipe rather than an incomplete sweep,
before deciding an environment is clean enough to move on from.

## `--redo` is required here, and a bare `--apply` is not enough

A first-time backfill (#882's) skips anything already carrying `kitInferredAt`. Every
recipe this remediation is for carries one — that is what makes it wrong. So the
remediation run is `--apply --redo`, and `--redo` deletes the stamp rather than merely
bumping the nonce past it, because `kitNeedsInference` declines on its first line while
the stamp is present. The mechanism is in `scripts/lib/recipeKitRequest.mjs`; the point
here is only that **omitting `--redo` reports "0 to ask" and remediates nothing**, which
is exactly what a first attempt at this did.

## Reasons to redo, so far

Two, and the procedure below is identical for both — only the deployed change differs.

1. **#954, generalised labels.** The flow named "food processor" where the household owns
   a Magimix, so every label inferred before it needs asking again.
2. **Capitals.** The flow was told "Lowercase, singular" while the manifest framing told
   it to copy an owned item's name capitalisation and all, so a recipe's kit column mixed
   "sharp knife" with "Hand Blender Attachment". Both prompts now ask for ordinary English
   capitals — a proper name keeps its own, everything else is lower case — which is the
   rule the ingredients tab beside it already reads by.

## The two ways a run silently does nothing

1. **Functions not deployed** (above). Worse than a no-op: the old flow answers and
   re-writes the generalised labels. `--verify` shows every recipe `done` with the same
   labels it had — check the labels, not just the exit code.
2. **The recipe-generation kill-switch is off** for that environment
   (`devSettings/singleton.recipeImageGenerationEnabled`). It is the same lever that
   stops hero images and time estimates — deliberately one lever, not three — and the
   kit branch honours it. Symptom is every recipe left `PENDING` after a `--redo` pass,
   because the branch returns before inferring and the stamp stays deleted. Check the
   switch before assuming a deploy problem.

## What a verified run leaves behind

- `kit` rewritten and `kitInferredAt` re-stamped.
- **Nothing else.** The write is a field-level update on `kitRequestedAt` (plus the
  `kitInferredAt` delete under `--redo`), and the trigger's own write-back is a partial
  `.update()` of `kit` and `kitInferredAt`. Recipes are last-write-wins per whole
  document, so a full write from either place would clobber a concurrent save; neither
  makes one. `updatedAt` is deliberately not touched — nothing a human authored changed,
  and moving it would reorder every list.
- A recipe whose inference **fails** keeps `kitInferredAt` deleted and its previous
  `kit` in place, so the strip keeps showing something useful and `--verify` reports it
  `PENDING`. Re-run `--apply --redo`, or use **Redo kit** on that one recipe.

## The judgement call this run exists to settle

#954 left one question open deliberately, to be decided on real output rather than up
front: **may an accessory be named as kit?** The manifest models accessories with an
`owned` flag, and the evidence recipe's method names blades — _"the straight blade"_,
_"4 mm slicing disc"_. Naming them would be genuinely useful and needs no schema change;
it also risks a longer, noisier list.

**Answered by the staging sample of 2026-08-31: yes, and by BARE NAME.** `Rice Spoon`,
`Hand Blender Attachment`, `Oven Sheet Pan` and `Wire Oven Rack` are all live kit labels
with no maker attached — which `resolveEquipmentItem` refuses by design, so the flow
needed no change and got none. The noise this risked is answered at display time
instead: `groupKitByEquipment` (`packages/domain/src/recipe/queries/`, issue #1140)
folds such a label under its appliance.

**Since #1465 it folds on the LINK, not on the words.** The kit flow now records
`kit[].equipment: { itemId, accessoryId }` at the moment it has the manifest in front
of it, and that recorded id is the only thing `groupKitByEquipment` reads: an entry
linked to one of an appliance's parts nests under that appliance when — and only when —
the appliance heads a row in the same recipe's kit, and an entry with no link that still
resolves is a flat row whatever its words say. The two word-based passes that used to
fold `Rice Spoon` under the Cosori are gone (#1465 Phase 4, after the 2026-09-19
production re-run relinked all 66 recipes and no recipe grouped differently without
them). So a recipe whose kit has never been inferred, or was written before that run,
lists its accessories flat until it is re-run or **Redo kit** is pressed — which is what
this runbook's `--redo` pass is for. Nothing about the grouping is stored on the
manifest, so this stays reversible.

If a future sample argues for a different answer, that is a prompt amendment in
`identifyRecipeKit.ts`, deployed, and staging re-run — not a change to this script.
Record the decision on the issue either way.

The second open item is the **ASSUMPTION** in #954: when a method says only "food
processor" and several manifest items qualify, the prompt tells the flow to pick the best
fit for the job rather than stay generic. It is prompt wording only and cheap to reverse.
The staging sample is what confirms or refutes it.

## A single bad result

**Redo kit** on the recipe page re-asks one recipe (`redoRecipeKit`), which is the same
write this script makes under `--redo`. Reach for that rather than a second full pass.
