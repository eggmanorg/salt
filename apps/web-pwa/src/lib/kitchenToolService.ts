import {
  subscribeKitchenTools,
  upsertKitchenTool,
  deleteKitchenTool as deleteKitchenToolDoc,
} from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter } from '@salt/observability';
import {
  isCanonIconRenderable,
  createKitchenTool,
  updateKitchenTool,
  iconRegenerationFields,
  CANON_ICON_HIDDEN,
} from '@salt/domain';
import type { CreateKitchenToolInput, UpdateKitchenToolInput } from '@salt/domain';
import type { KitchenToolDoc } from '@salt/domain/schemas';
import {
  success,
  failure,
  type DomainError,
  type ReadResult,
  type Result,
} from '@salt/shared-types';
import { writable, get } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';

// The curated kitchen-tool pictogram vocabulary (issue #882).
//
// Every surface but one only ever looks a name up in this list: nothing anywhere
// stores a tool id, so a recipe step and a guided plan card keep the cook's own
// words and the tool is found from those words each time a row is drawn. The one
// exception is the admin page, whose commands live at the bottom of this file —
// and they curate the VOCABULARY, never the content that reads it.

// ─── Reactive stores ────────────────────────────────────────────────────────────

const _kitchenTools = writable<readonly KitchenToolDoc[]>([]);
export const kitchenTools: Readable<readonly KitchenToolDoc[]> = _kitchenTools;

const _isLoadingKitchenTools = writable(false);
export const isLoadingKitchenTools: Readable<boolean> = _isLoadingKitchenTools;

// ─── Error reporting ────────────────────────────────────────────────────────────

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// ─── Init / cleanup ─────────────────────────────────────────────────────────────

export function initKitchenToolSync(): () => void {
  _isLoadingKitchenTools.set(true);
  const errors = getErrorReporter();

  return subscribeKitchenTools(
    (tools) => {
      _kitchenTools.set(tools);
      _isLoadingKitchenTools.set(false);
    },
    (err, rawError) => reportSubscriptionError(errors, err, rawError),
  );
}

// ─── Snapshot ────────────────────────────────────────────────────────────────────

export function getKitchenToolsSnapshot(): readonly KitchenToolDoc[] {
  return get(_kitchenTools);
}

// ─── The one shared fold ─────────────────────────────────────────────────────────
//
// THE POINT OF PUTTING THIS HERE. The `thumbnailFor` / `iconVersionFor` pair was
// already written out by hand several times over, and each copy is a place the
// cache-bust rule (`iconRequestedAt ?? updatedAt`, ui-spec-v04 §14.4) or the
// tri-state render guard can quietly drift. It gets ONE definition, exported, and
// every surface that draws a tool uses it. Do not add a private copy to a page.
//
// The ingredient half of the same story lives in `cookIngredientIcons.ts`
// (`ingredientIcons`), shared by both cook screens since #994. ShoppingListPage
// keeps its own pair, and deliberately: it is keyed by a bare `canonId` off a
// list row and has no product form to prefer.
//
// REACTIVITY BELONGS TO `kitIcons`, NOT HERE. This is a pure function of one
// document, so it has nothing to subscribe to; the tracked dependency that makes a
// tile fill in when the vocabulary lands after first paint is `kitIcons`'s derived
// store over `kitchenTools`.

/**
 * The picture and nonce for a curated tool the caller has ALREADY resolved.
 *
 * ONE DEFINITION, AND THE CALLER OWNS THE RESOLUTION (issue #1465). There used to
 * be a `toolIcons` derived store here that took a free-text label, resolved it
 * with `resolveKitchenTool` and folded the result — and `kitIcons.ts` was its only
 * consumer in the app. It is gone, because `kitIcons` now picks the tool through
 * `kitchenToolForKitLabel`, which applies the accessory-name rule (#1460) this
 * file knows nothing about: handing the label back here to be resolved a second
 * time would have been a second, DISAGREEING answer to "which tool is this?",
 * which is exactly what `docs/canon-icons.md` means by not writing a second
 * ordering. What is left is the part that was never about resolution — the
 * tri-state fold (not drawn yet / hidden / a URL) and the cache-bust rule
 * (`iconRequestedAt ?? updatedAt`, ui-spec-v04 §14.4, load-bearing because a
 * redraw reuses the Storage path and its bytes are written `immutable`).
 */
export function toolPicture(
  tool: KitchenToolDoc,
): { thumbnail: string; version: string | number } | null {
  const thumbnail = tool.thumbnail;
  if (thumbnail === null || !isCanonIconRenderable(thumbnail)) return null;
  return { thumbnail, version: tool.iconRequestedAt ?? tool.updatedAt };
}

// ─── Commands (the admin page, issue #882 Phase 4) ──────────────────────────────
//
// PLAIN CLIENT WRITES, with no callable in front of them — and that is the point
// rather than a shortcut. Canon routes its regenerate through an auth'd Cloud
// Function because `canonItems` needs AI-cost gating at a surface the client
// cannot be trusted with; `kitchenTools` was made client-writable in Phase 1
// precisely so this page would need neither a new function nor a new
// per-environment IAM invoker grant. Adding one now would contradict the reason
// the rules block was written the way it was. (Canon's own `hideCanonIcon` is
// already a plain client write for the same reason: hiding spends nothing.)
//
// None of these touch a recipe or a plan. Adding a tool lights up every piece of
// content that already said the word, because resolution happens at display time —
// there is nothing to backfill and nothing to reprocess.

// The write half of every vocabulary edit (#931), the twin of canonService's
// `commitCanonItemUpdate`: the persistence outcome comes back, so a command that
// produced a valid tool still answers `err` when the document never landed.
async function commitKitchenTool(tool: KitchenToolDoc): Promise<ReadResult<void, DomainError>> {
  return reportIfFailed(getErrorReporter(), await upsertKitchenTool(tool));
}

export async function addKitchenTool(
  input: CreateKitchenToolInput,
): Promise<Result<KitchenToolDoc, DomainError>> {
  // The whole current vocabulary goes in because the id is derived from the
  // label: the command refuses a collision rather than letting a full-document
  // write replace a curated tool with a blank one.
  const result = createKitchenTool(input, getKitchenToolsSnapshot(), new Date().toISOString());
  if (result.kind !== 'ok') return result;
  const written = await commitKitchenTool(result.value);
  return written.kind === 'err' ? written : result;
}

export async function editKitchenTool(
  tool: KitchenToolDoc,
  input: UpdateKitchenToolInput,
): Promise<Result<KitchenToolDoc, DomainError>> {
  const result = updateKitchenTool(tool, input, new Date().toISOString());
  if (result.kind !== 'ok') return result;
  const written = await commitKitchenTool(result.value);
  return written.kind === 'err' ? written : result;
}

/**
 * Add one more phrase a tool answers to — the queue's "alias of an existing tool"
 * action. It draws NO second pictogram, which is the whole reason it exists: a
 * vocabulary that gains "masher" beside "potato masher" is a vocabulary paying for
 * the same drawing twice and slowly filling with near-duplicates.
 */
export async function addKitchenToolMatcher(
  tool: KitchenToolDoc,
  phrase: string,
): Promise<Result<KitchenToolDoc, DomainError>> {
  return editKitchenTool(tool, { label: tool.label, matchers: [...tool.matchers, phrase] });
}

/**
 * Drop one phrase a tool answers to — the twin of `addKitchenToolMatcher`, and
 * here for the same reason it is: both the expanded list row and the editor offer
 * Remove on a name (issue #1489), so the one write has one spelling.
 *
 * Matched on the STORED phrase, not on a normalised form: the list shows what is
 * stored, so the phrase the reader pressed Remove beside is the phrase that goes.
 * A `matchers` array that somehow held two entries normalising the same would lose
 * only the one that was pressed, which is the honest reading of that press.
 */
export async function removeKitchenToolMatcher(
  tool: KitchenToolDoc,
  phrase: string,
): Promise<Result<KitchenToolDoc, DomainError>> {
  return editKitchenTool(tool, {
    label: tool.label,
    matchers: tool.matchers.filter((m) => m !== phrase),
  });
}

export async function removeKitchenTool(id: string): Promise<Result<void, DomainError>> {
  return reportIfFailed(getErrorReporter(), await deleteKitchenToolDoc(id));
}

// ─── Icon (Tier-1 pictogram) escape hatch ───────────────────────────────────────

/**
 * Regenerate a tool's icon.
 *
 * The fields written are `@salt/domain`'s `iconRegenerationFields` — the same
 * ones the canon and product-form callables write, which live in an app this one
 * cannot import. Why each field is load-bearing is documented there.
 *
 * What is THIS side's, and stays here: the write is a whole-document `setDoc`,
 * so dropping the `iconHint` key IS the delete — there is no `FieldValue.delete()`
 * to reach for and no merge to write around. That is what the destructure below
 * is doing, and it is why the shared piece is a field builder rather than a
 * shared write.
 */
export async function regenerateKitchenToolIcon(
  id: string,
  hint?: string,
): Promise<Result<void, DomainError>> {
  const tool = getKitchenToolsSnapshot().find((t) => t.id === id);
  // Not reported: a NotFound here means the vocabulary changed under a page that
  // was already open, which is an expected race and not a defect (§7.6).
  if (!tool) return failure({ kind: 'NotFound', resource: 'kitchenTool', id });
  const { iconHint: _stale, ...rest } = tool;
  return commitKitchenTool({ ...rest, ...iconRegenerationFields(Date.now(), hint) });
}

/** Hide a tool's icon: sets `thumbnail` to the shared "hidden" sentinel so the
 *  trigger skips it forever and every surface renders the words on their own. */
export async function hideKitchenToolIcon(
  tool: KitchenToolDoc,
): Promise<Result<KitchenToolDoc, DomainError>> {
  const hidden: KitchenToolDoc = {
    ...tool,
    thumbnail: CANON_ICON_HIDDEN,
    updatedAt: new Date().toISOString(),
  };
  const written = await commitKitchenTool(hidden);
  return written.kind === 'err' ? written : success(hidden);
}

/** Un-hide a tool's icon. It goes through the regenerate path because clearing
 *  the sentinel back to null is the same write that re-triggers generation —
 *  there is nothing else to do, and no second way to do it. */
export async function unhideKitchenToolIcon(id: string): Promise<Result<void, DomainError>> {
  return regenerateKitchenToolIcon(id);
}

// ─── Test helpers ────────────────────────────────────────────────────────────────

export function __resetKitchenToolServiceForTest(): void {
  _kitchenTools.set([]);
  _isLoadingKitchenTools.set(false);
  _errorReporter = null;
}
