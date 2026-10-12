import { getFirestore, doc, setDoc } from 'firebase/firestore';
import { getApp } from 'firebase/app';
import type { FreezerConfig } from '@salt/domain';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure } from '@salt/shared-types';
import {
  FreezerConfigSchema,
  FREEZER_CONFIG_COLLECTION,
  FREEZER_CONFIG_DOC_ID,
} from '@salt/domain/schemas';
import { classifyFirestoreError } from './firestoreErrors.js';
import { subscribeDocument } from './subscribeDocument.js';

// The household's freezers and shelves (issue #1682) — one document, read live
// and written whole, the same shape as the equipment manifest beside it. An
// absent document arrives as `null`: nobody has set up a freezer yet.
export function subscribeFreezerConfig(
  onConfig: (config: FreezerConfig | null) => void,
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeDocument(
    {
      path: [FREEZER_CONFIG_COLLECTION, FREEZER_CONFIG_DOC_ID],
      schema: FreezerConfigSchema,
      label: 'FreezerConfigSchema',
    },
    onConfig,
    onError,
  );
}

// A full-document `setDoc` — document-level LWW, no field transform. The fields
// are listed by hand, so a field added to the schema and missed here is dropped
// on every save; the tests pin each one.
export async function saveFreezerConfig(
  config: FreezerConfig,
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await setDoc(doc(db, FREEZER_CONFIG_COLLECTION, FREEZER_CONFIG_DOC_ID), {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      freezers: [...config.freezers],
      suppliers: [...config.suppliers],
      highestNumber: config.highestNumber,
    });
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}
