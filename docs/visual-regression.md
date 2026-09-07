# Visual regression (Chromatic)

Chromatic renders every [Storybook](../apps/storybook/README.md) story in a
cloud browser and diffs each snapshot against an accepted baseline. It is the
visual safety net for the `@salt/ui-components` design system: the stories in
[`apps/storybook/`](../apps/storybook/) exercise every primitive, layout and
template the package ships, so a single Chromatic run tells us whether a change
altered how any of them _look_ — the class of regression that `pnpm typecheck` /
`svelte-check` / unit tests structurally cannot catch. (No counts here on
purpose: the design system grows every few weeks and a number written down is a
number that goes stale — count the directories under
[`packages/ui-components/src/`](../packages/ui-components/src/) and the
`*.stories.*` files under [`apps/storybook/src/`](../apps/storybook/src/) if you
need today's figure.)

**Headline use case: the Tailwind v3 → v4 migration.** v4 re-expresses the
whole token layer (the preset, the `@theme` scales, the colour variables), so
it re-renders every component at once. Chromatic turns that otherwise-unreviewable
blast radius into a per-story diff you can walk through and sign off. This net
is _why_ the Storybook app exists.

## This is selective and non-blocking — on purpose

Chromatic snapshots **every** story on **every** run, and the plan's snapshot
budget is finite. So visual review is spent deliberately, never automatically:

| Trigger     | How                                                | When to use                              |
| ----------- | -------------------------------------------------- | ---------------------------------------- |
| Manual      | `workflow_dispatch` from the **Actions** tab       | Ad-hoc check of a UI branch              |
| Labelled PR | Add the **`visual-review`** label to a PR          | You want a diff on _this_ PR             |
| Release     | Publishing a GitHub Release (`release: published`) | Capture a fresh baseline at each release |

It does **not** run on `push`, and it does **not** run on ordinary (unlabelled)
PRs. It is **never a required status check** — the workflow reports diffs with
`--exit-zero-on-changes` and skips gracefully (staying green) when the token is
absent, so it can never block a merge. If you want it enforced on a specific
change, add the label; remove it to stop re-snapshotting.

The workflow is [`.github/workflows/chromatic.yml`](../.github/workflows/chromatic.yml).
It mirrors the `ci.yml` setup (checkout@v7 / pnpm 10.33.0 / Node 22 / frozen
install) with two Chromatic-specific choices, both deliberate:

- **`fetch-depth: 0`** — Chromatic walks git history to locate each story's
  baseline commit. A shallow clone breaks baseline detection and makes every run
  look like a 100% change.
- **TurboSnap OFF** (no `--only-changed`) — TurboSnap skips stories it believes
  the diff can't affect. A token/preset change (exactly the v4 migration) touches
  every story transitively, so TurboSnap would wrongly skip real diffs. We always
  do a full re-snapshot.

## One-time maintainer setup

Chromatic needs a project token that only a maintainer can mint. Until it is
set, the workflow is inert (it skips and passes).

1. **Create the Chromatic project.** Sign in at [chromatic.com](https://www.chromatic.com/)
   with GitHub and add this repository as a project. Chromatic issues a
   **project token**.
2. **Add the repo secret.** In GitHub → _Settings → Secrets and variables →
   Actions_, add `CHROMATIC_PROJECT_TOKEN` with that value. The CLI and the
   `chromaui/action` both read it from the environment — the token is **never**
   hardcoded in the workflow or `package.json`.
3. **Capture the first (v3) baselines.** Run Chromatic once against `main` while
   it still renders the current Tailwind **v3** UI, so the accepted baselines are
   the pre-migration look. Either trigger the workflow from the Actions tab, or
   run it locally:
   ```sh
   CHROMATIC_PROJECT_TOKEN=<token> pnpm --filter @salt/storybook chromatic
   ```
   On the very first build Chromatic auto-accepts everything as the baseline.

> Baseline capture requires the maintainer's real `CHROMATIC_PROJECT_TOKEN`.
> It is a human step — no CI wiring, agent, or fork can do it, because the token
> is a secret.

## Reviewing and accepting diffs

Each run posts a link to the Chromatic build. For every changed story:

- **Intended change** → **Accept** the snapshot. That new image becomes the
  baseline for future runs.
- **Unintended change** → it's a regression; fix the code and re-run. Don't
  accept it.

Accepting is what advances the baseline, so an accepted diff won't re-flag on the
next run. Because the workflow uses `--exit-zero-on-changes`, a run with pending
diffs still completes green in CI — the review happens in Chromatic's UI, not by
a red check.

## Tailwind v4 migration runbook

1. Land the v4 migration on a branch and add the **`visual-review`** label to its
   PR (or run the workflow against the branch).
2. Chromatic re-snapshots **every** story — expect a large diff. That's normal:
   v4 rewrites tokens and the preset, so nearly everything re-renders. This is
   also why TurboSnap stays off (see above).
3. Walk each diff and decide _intended or not_:
   - Intended re-tokenisation (same layout, refreshed colours/spacing) → **Accept**.
   - A component that broke (misaligned, wrong colour, clipped) → fix in code,
     push, re-run.
4. When the diff is clean, the accepted snapshots become the new **v4 baselines**.
   Subsequent PRs diff against those.

## Snapshot-framing quirks (Phase 2)

Some stories are framed specifically so Chromatic captures the right pixels.
Keep these in mind when reading diffs or adding stories:

- **Overlays render inline via `portal={false}`.** Dialog, Sheet, Popover,
  Tooltip, Combobox, Select, etc. are rendered inside the story canvas rather
  than portalled to `document.body`, so Chromatic actually captures the open
  overlay instead of an empty trigger.
- **`ListPage` selection mode shows a fixed bottom bar.** In selection mode the
  action bar is position-fixed at the bottom of the viewport, so its snapshot
  position depends on the canvas height, not the list length.
- **`AppShell` nav visibility is viewport-width dependent.** The shell swaps
  between the side nav and the bottom nav at the responsive breakpoint, so which
  navigation appears in a snapshot depends on the Chromatic viewport width — a
  width change (not a code change) can move the nav.
- **`Toast` close button is `opacity-0` until hover.** The dismiss control is
  invisible in a default (non-hover) snapshot by design; don't read its absence
  as a regression.
