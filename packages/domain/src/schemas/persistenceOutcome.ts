import { z } from 'zod';

// What happened to a server-side write a flow made on the caller's behalf, carried
// back across the callable so the browser can say what actually happened (issue
// #1601). ONE vocabulary for every flow that writes its own result:
//
// - `written` — the write committed.
// - `skipped` — there was nothing to write (the document is gone, no row is left
//   to annotate, or the flow ran in a mode that writes nothing). Not a failure.
// - `failed`  — a write was due and did not land. The server has already logged
//   and reported it (`StorageError`); the client must not report it again.
export const PersistenceOutcomeSchema = z.enum(['written', 'skipped', 'failed']);

export type PersistenceOutcome = z.infer<typeof PersistenceOutcomeSchema>;
