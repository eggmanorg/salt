import {
  DEFAULT_FREEZER_CONTAINERS,
  type FreezerConfigDoc,
  type FreezerDoc,
} from '../../schemas/freezerConfig.js';

// Wire shape of the freezerConfig/current Firestore document (issue #1682).
// `updatedAt` is stamped by each command from the `now` it is given, and again
// client-side by saveFreezerConfig (firebase-sync). Schema-first (issue #932).
export type FreezerConfig = FreezerConfigDoc;
export type Freezer = FreezerDoc;

/**
 * The config a household has before anyone has set up a freezer — what an
 * ABSENT document means. A caller substitutes it only once the document is known
 * to be absent, never while it is still loading: writing it then would replace a
 * real setup with an empty one.
 */
export function emptyFreezerConfig(now: string): FreezerConfig {
  return {
    schemaVersion: 1,
    updatedAt: now,
    freezers: [],
    suppliers: [],
    containers: [...DEFAULT_FREEZER_CONTAINERS],
    highestNumber: 0,
  };
}
