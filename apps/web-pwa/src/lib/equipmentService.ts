import {
  subscribeEquipmentManifest,
  saveEquipmentManifest,
  callIdentifyEquipment,
  callPopulateEquipmentEntry,
  subscribeEquipmentIcons,
  callDrawEquipmentIcon,
  callDescribeEquipmentSubject,
} from '@salt/firebase-sync';
import type { IdentifyEquipmentResult, PopulateEquipmentEntryResult } from '@salt/firebase-sync';
import type {
  EquipmentEnvironmentDoc,
  EquipmentIconDoc,
  EquipmentReferencePhoto,
} from '@salt/domain/schemas';
import {
  addEquipment,
  removeEquipment,
  renameEquipment,
  addAccessory,
  removeAccessory,
  setAccessoryOwned,
  addRule,
  removeRule,
  editRule,
  setEquipmentEnvironment,
} from '@salt/domain';
import type { EquipmentManifest, EquipmentManifestPort } from '@salt/domain';
import { failure, type DomainError, type ReadResult } from '@salt/shared-types';
import { writable, get } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { subscriptionErrorHandler } from './errorReporting.js';

export type { IdentifyEquipmentResult, PopulateEquipmentEntryResult };

// ─── Reactive stores ─────────────────────────────────────────────────────────

const _equipment = writable<EquipmentManifest | null>(null);
export const equipment: Readable<EquipmentManifest | null> = _equipment;

const _isLoadingEquipment = writable(true);
export const isLoadingEquipment: Readable<boolean> = _isLoadingEquipment;

// ─── Equipment pictograms (issue #877) ───────────────────────────────────────
// A SEPARATE store over a SEPARATE collection, keyed by item id, because the
// icons live in `equipmentIcons/{itemId}` rather than on the manifest — see
// `@salt/domain/schemas/equipmentIcon.ts` for why (the manifest is one document
// whole-doc `setDoc`'d on every edit, so a thumbnail on the array element would
// let an unrelated accessory tick wipe every icon in the kit).
//
// It is deliberately NOT merged into the manifest store on read: keeping them
// apart is what means an icon arriving never re-renders the manifest and an
// accessory edit never touches an icon.
const _equipmentIcons = writable<Map<string, EquipmentIconDoc>>(new Map());
export const equipmentIcons: Readable<Map<string, EquipmentIconDoc>> = _equipmentIcons;

// ─── ID generator ─────────────────────────────────────────────────────────────

const ids = {
  newEquipmentId: () => crypto.randomUUID(),
  newAccessoryId: () => crypto.randomUUID(),
};

// ─── Empty manifest ───────────────────────────────────────────────────────────

function emptyManifest(): EquipmentManifest {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), items: [] };
}

// ─── In-memory adapter (test double) ──────────────────────────────────────────

export function memEquipmentManifestStore(seed: EquipmentManifest | null = null) {
  let written: EquipmentManifest | null = seed;
  const store: EquipmentManifestPort = {
    async load() {
      return { kind: 'ok', value: written };
    },
    async save(manifest) {
      written = manifest;
      return { kind: 'ok', value: undefined };
    },
  };
  return { store, getWritten: () => written };
}

// ─── Init / cleanup ───────────────────────────────────────────────────────────

export function initEquipmentSync(): () => void {
  _isLoadingEquipment.set(true);

  const unsub = subscribeEquipmentManifest(
    (manifest) => {
      _equipment.set(manifest);
      _isLoadingEquipment.set(false);
    },
    subscriptionErrorHandler(() => {
      _isLoadingEquipment.set(false);
    }),
  );

  // The icon collection rides along on the same lifecycle. It has no loading
  // flag of its own on purpose: an item with no icon yet renders the pale
  // placeholder tile, which is exactly what it should render while the
  // subscription is still in flight, so there is no third state to spell.
  const unsubIcons = subscribeEquipmentIcons(
    (icons) => _equipmentIcons.set(icons),
    // A failed icon read costs the pictograms and nothing else — the kit list
    // still works — so nothing is surfaced to the user here. It is still
    // REPORTED: the handler sends it to the category gate before doing (in this
    // case) no store work at all.
    subscriptionErrorHandler(),
  );

  return () => {
    unsub();
    unsubIcons();
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns null while the Firestore subscription has not yet delivered its first
// snapshot. Acting on a substituted empty manifest before hydration would
// overwrite a legitimate existing manifest on the next save.
function currentManifest(): EquipmentManifest | null {
  if (get(_isLoadingEquipment)) return null;
  return get(_equipment) ?? emptyManifest();
}

function notHydratedFailure(): ReadResult<EquipmentManifest, DomainError> {
  return failure({ kind: 'NetworkError', reason: 'transient' });
}

async function applyAndSave(
  result: ReadResult<EquipmentManifest, DomainError>,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  if (result.kind !== 'ok') return result;
  _equipment.set(result.value);
  // The store is updated first and deliberately left updated on a refused write:
  // the manifest subscription is the authority and will correct the optimistic
  // value on its next snapshot. What changes with #931 is that the caller now
  // HEARS the refusal instead of catching a raw Firestore rejection.
  const written = await saveEquipmentManifest(result.value);
  return written.kind === 'err' ? written : result;
}

// ─── Equipment commands ───────────────────────────────────────────────────────

export async function addEquipmentItem(
  name: string,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = addEquipment(manifest, { name, now: new Date().toISOString() }, ids);
  return applyAndSave(result);
}

export async function removeEquipmentItem(
  id: string,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = removeEquipment(manifest, { id });
  return applyAndSave(result);
}

export async function removeEquipmentItems(
  ids: string[],
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  let working: EquipmentManifest = manifest;
  for (const id of ids) {
    const result = removeEquipment(working, { id });
    if (result.kind !== 'ok') return result;
    working = result.value;
  }
  _equipment.set(working);
  const written = await saveEquipmentManifest(working);
  return written.kind === 'err' ? written : { kind: 'ok', value: working };
}

export async function renameEquipmentItem(
  id: string,
  name: string,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = renameEquipment(manifest, { id, name, now: new Date().toISOString() });
  return applyAndSave(result);
}

/**
 * Capture an item with its accessories in a single save. Returns the new
 * item's id so the caller can navigate to it without name-based lookup.
 */
export interface CaptureAccessoryInput {
  readonly name: string;
  readonly owned: boolean;
  readonly included: boolean;
}

export interface CaptureResult {
  readonly itemId: string;
  readonly manifest: EquipmentManifest;
}

export async function captureEquipmentItem(
  name: string,
  accessories: readonly CaptureAccessoryInput[],
): Promise<ReadResult<CaptureResult, DomainError>> {
  const base = currentManifest();
  if (!base) return failure({ kind: 'NetworkError', reason: 'transient' });

  const now = new Date().toISOString();
  const addResult = addEquipment(base, { name, now }, ids);
  if (addResult.kind !== 'ok') return addResult;

  // addEquipment appends; the new item is the last entry.
  const newItem = addResult.value.items[addResult.value.items.length - 1];
  if (!newItem) return failure({ kind: 'NetworkError', reason: 'transient' });
  const itemId = newItem.id;

  let working = addResult.value;
  for (const acc of accessories) {
    const accResult = addAccessory(
      working,
      { equipmentId: itemId, name: acc.name, owned: acc.owned, included: acc.included, now },
      ids,
    );
    if (accResult.kind !== 'ok') return accResult;
    working = accResult.value;
  }

  _equipment.set(working);
  const written = await saveEquipmentManifest(working);
  return written.kind === 'err' ? written : { kind: 'ok', value: { itemId, manifest: working } };
}

// ─── Accessory commands ───────────────────────────────────────────────────────

export async function addEquipmentAccessory(
  equipmentId: string,
  name: string,
  owned: boolean,
  included: boolean,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = addAccessory(
    manifest,
    { equipmentId, name, owned, included, now: new Date().toISOString() },
    ids,
  );
  return applyAndSave(result);
}

export async function removeEquipmentAccessory(
  equipmentId: string,
  accessoryId: string,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = removeAccessory(manifest, {
    equipmentId,
    accessoryId,
    now: new Date().toISOString(),
  });
  return applyAndSave(result);
}

export async function toggleEquipmentAccessoryOwned(
  equipmentId: string,
  accessoryId: string,
  owned: boolean,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = setAccessoryOwned(manifest, {
    equipmentId,
    accessoryId,
    owned,
    now: new Date().toISOString(),
  });
  return applyAndSave(result);
}

// ─── Rule commands ────────────────────────────────────────────────────────────

export async function addEquipmentRule(
  equipmentId: string,
  rule: string,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = addRule(manifest, {
    equipmentId,
    rule,
    now: new Date().toISOString(),
  });
  return applyAndSave(result);
}

export async function removeEquipmentRule(
  equipmentId: string,
  ruleIndex: number,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = removeRule(manifest, {
    equipmentId,
    ruleIndex,
    now: new Date().toISOString(),
  });
  return applyAndSave(result);
}

export async function editEquipmentRule(
  equipmentId: string,
  ruleIndex: number,
  rule: string,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = editRule(manifest, {
    equipmentId,
    ruleIndex,
    rule,
    now: new Date().toISOString(),
  });
  return applyAndSave(result);
}

// ─── Place commands (issue #1281) ─────────────────────────────────────────────

/**
 * Describes an equipment item as a place that holds a temperature, or (with
 * `null`) stops it being one. The shared/dedicated invariant is enforced inside
 * `setEquipmentEnvironment`, not here.
 */
export async function setEquipmentEnvironmentFor(
  equipmentId: string,
  environment: EquipmentEnvironmentDoc | null,
): Promise<ReadResult<EquipmentManifest, DomainError>> {
  const manifest = currentManifest();
  if (!manifest) return notHydratedFailure();
  const result = setEquipmentEnvironment(manifest, {
    equipmentId,
    environment,
    now: new Date().toISOString(),
  });
  return applyAndSave(result);
}

// ─── AI capture helpers ───────────────────────────────────────────────────────

export { callIdentifyEquipment, callPopulateEquipmentEntry };

// ─── Equipment pictogram commands (issue #877) ────────────────────────────────
// Both go through ONE authenticated callable because `equipmentIcons` is
// client-write-denied. There is no local optimistic update: the icon and its
// version nonce come back through the collection subscription, which is also
// what makes the cache-bust honest — the `?v=` the browser sees is the one the
// server actually stamped.

/**
 * Draw (or redraw) this item's pictogram from `brief`.
 *
 * `brief` is what the user is looking at — the authored description, or their
 * correction of it. Passing it explicitly rather than letting the server read
 * the stored one is the whole review gate: the edit in the textarea is what gets
 * drawn, and it is persisted only if the draw succeeds.
 */
export async function drawEquipmentIcon(
  itemId: string,
  brief: string,
): Promise<ReadResult<void, DomainError>> {
  return callDrawEquipmentIcon({ action: 'draw', itemId, brief });
}

/**
 * Hide this item's pictogram — the row falls back to the pale placeholder tile.
 *
 * There is no un-hide command: the brief survives a hide, so pressing Draw again
 * IS the un-hide. Canon needs a separate one only because its un-hide has to
 * clear the field back to null and let a trigger notice.
 */
export async function hideEquipmentIcon(itemId: string): Promise<ReadResult<void, DomainError>> {
  return callDrawEquipmentIcon({ action: 'hide', itemId });
}

// ─── Description revision (issue #885) ───────────────────────────────────────
// Both actions call the describeEquipmentSubject callable, which PERSISTS
// NOTHING — the new description lands back in the textarea, still editable, and
// only becomes the item's description if the user then presses Draw. That is the
// point: the words are a fraction of a penny and the picture is not, so you
// iterate the sentence for free and buy exactly one drawing once it is right.
//
// Both take the NAME rather than the item id: the callable reads nothing from
// Firestore, so the caller supplies the whole input. Neither touches
// `equipmentIcons` — `drawEquipmentIcon` remains its only writer.

/**
 * Rewrite this item's description with a correction folded through it.
 *
 * `currentBrief` is what the user is looking at — the stored description or
 * their edit of it — so a revision applies to the words on screen, not to the
 * words on the document.
 */
export async function reviseEquipmentBrief(
  name: string,
  currentBrief: string,
  hint: string,
): Promise<ReadResult<string, DomainError>> {
  return callDescribeEquipmentSubject({
    name: name.trim(),
    currentBrief: currentBrief.trim(),
    hint: hint.trim(),
  });
}

/**
 * Write a fresh description from the item's name, discarding what is in the box.
 *
 * Sends neither the accumulated brief nor a steer, which is exactly what the
 * manifest trigger sends — so "Start over" gets back the description the item
 * was born with, and is the escape hatch for one edited into a corner.
 */
export async function restartEquipmentBrief(
  name: string,
): Promise<ReadResult<string, DomainError>> {
  return callDescribeEquipmentSubject({ name: name.trim() });
}

/**
 * Write a fresh description from a photograph of the actual item, discarding
 * what is in the box (issue #947).
 *
 * "Start over, but with a picture": sends the name and the photo, nothing else
 * — photo mode always authors from scratch, exactly as `restartEquipmentBrief`
 * does with the name alone. The photo is REQUEST-SCOPED (Rule 3): it goes to
 * the callable as base64 and is never written anywhere, on this item or on any
 * document — the durable artefact is the sentence that comes back, same as
 * every other description here.
 */
export async function describeEquipmentFromPhoto(
  name: string,
  photo: EquipmentReferencePhoto,
): Promise<ReadResult<string, DomainError>> {
  return callDescribeEquipmentSubject({ name: name.trim(), photo });
}

/** This item's icon document, or null while none has been authored yet. */
export function equipmentIconFor(
  icons: Map<string, EquipmentIconDoc>,
  itemId: string,
): EquipmentIconDoc | null {
  return icons.get(itemId) ?? null;
}

/**
 * Tri-state thumbnail for a row, in `CanonIcon`'s own contract: `null` (→ the
 * pale placeholder tile), a URL, or the `"hidden"` sentinel.
 */
export function equipmentThumbnailFor(
  icons: Map<string, EquipmentIconDoc>,
  itemId: string,
): string | null {
  return icons.get(itemId)?.thumbnail ?? null;
}

/**
 * Cache-bust nonce for `CanonIcon`'s `version` prop. Load-bearing on redraw: the
 * Storage object path is reused and its bytes are written `immutable`, so
 * without this the browser serves the old picture (ui-spec-v04 §14.4).
 */
export function equipmentIconVersionFor(
  icons: Map<string, EquipmentIconDoc>,
  itemId: string,
): string | number | undefined {
  return icons.get(itemId)?.iconRequestedAt;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

export function __resetEquipmentServiceForTest(): void {
  _equipment.set(null);
  _isLoadingEquipment.set(true);
  _equipmentIcons.set(new Map());
}

// ─── Snapshot (used by e2e bridge) ────────────────────────────────────────────

export function getEquipmentSnapshot(): EquipmentManifest | null {
  return get(_equipment);
}

export async function seedEquipmentManifest(
  manifest: EquipmentManifest,
): Promise<ReadResult<void, DomainError>> {
  _equipment.set(manifest);
  _isLoadingEquipment.set(false);
  return saveEquipmentManifest(manifest);
}
