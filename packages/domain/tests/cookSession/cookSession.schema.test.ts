import { describe, it, expect } from 'vitest';
import { CookSessionSchema } from '@salt/domain/schemas';
import { CookActiveTimerSchema } from '../../src/schemas/cookSession.js';

// A timer's wire shape (issue #748). `id` is its identity; `stepId` is nullable
// (an ad-hoc timer belongs to no step); `label` and `durationMinutes` record what
// was actually started rather than what the recipe step happens to say now.
//
// The back-compat case is the one that matters most: cookSessions have no TTL and
// a cook can span days, so a session written BEFORE these fields existed must
// still parse — otherwise a live timer disappears across a deploy.

const LEGACY = { stepId: 's1', endsAt: '2026-07-22T18:35:00.000Z', notify: true } as const;

describe('CookActiveTimerSchema', () => {
  it('parses a full modern entry verbatim', () => {
    const entry = {
      id: 's1',
      stepId: 's1',
      label: 'Simmer the sauce',
      durationMinutes: 25,
      endsAt: '2026-07-22T18:35:00.000Z',
      notify: true,
    };
    expect(CookActiveTimerSchema.parse(entry)).toEqual(entry);
  });

  it('parses an ad-hoc entry — minted id, no step', () => {
    const parsed = CookActiveTimerSchema.parse({
      id: 'adhoc-1',
      stepId: null,
      label: 'Rice',
      durationMinutes: 12,
      endsAt: '2026-07-22T18:35:00.000Z',
      notify: false,
    });
    expect(parsed.stepId).toBeNull();
    expect(parsed.id).toBe('adhoc-1');
  });

  it('BACK-COMPAT: a legacy { stepId, endsAt, notify } entry parses, id backfilled from stepId', () => {
    const parsed = CookActiveTimerSchema.parse(LEGACY);
    expect(parsed.id).toBe(LEGACY.stepId);
    expect(parsed.stepId).toBe(LEGACY.stepId);
    expect(parsed.label).toBeNull();
    expect(parsed.durationMinutes).toBeNull();
    expect(parsed.endsAt).toBe(LEGACY.endsAt);
    expect(parsed.notify).toBe(true);
  });

  it('does not overwrite an explicit id with the step id', () => {
    const parsed = CookActiveTimerSchema.parse({ ...LEGACY, id: 'adhoc-9' });
    expect(parsed.id).toBe('adhoc-9');
  });

  it('rejects an entry with neither an id nor a step id to backfill from', () => {
    expect(
      CookActiveTimerSchema.safeParse({ stepId: null, endsAt: LEGACY.endsAt, notify: false })
        .success,
    ).toBe(false);
  });
});

describe('CookSessionSchema.activeTimers', () => {
  const base = {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
    createdAt: '2026-07-22T18:30:00.000Z',
    updatedAt: '2026-07-22T18:30:00.000Z',
  };

  it('BACK-COMPAT: a whole session written before #748 still parses, timer intact', () => {
    const result = CookSessionSchema.safeParse({ ...base, activeTimers: [LEGACY] });
    expect(result.success).toBe(true);
    expect(result.success && result.data.activeTimers[0]).toEqual({
      id: 's1',
      stepId: 's1',
      label: null,
      durationMinutes: null,
      endsAt: LEGACY.endsAt,
      notify: true,
    });
  });

  it('still defaults activeTimers to [] when the field is absent', () => {
    const result = CookSessionSchema.safeParse(base);
    expect(result.success && result.data.activeTimers).toEqual([]);
  });
});

describe('CookSessionSchema.checkedPrepIds', () => {
  // Guided cook (issue #751, Phase 2). Same back-compat obligation as every other
  // array on this document, and for the same reason: cookSessions have no TTL, so
  // every session in Firestore today predates the field.
  const base = {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
    createdAt: '2026-08-08T18:30:00.000Z',
    updatedAt: '2026-08-08T18:30:00.000Z',
  };

  it('BACK-COMPAT: defaults to [] when the field is absent', () => {
    const result = CookSessionSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.success && result.data.checkedPrepIds).toEqual([]);
  });

  it('parses a guided session verbatim, alongside the ingredient tick list', () => {
    const result = CookSessionSchema.safeParse({
      ...base,
      checkedIngredientIds: ['ing-1'],
      checkedPrepIds: ['prep-1', 'ing-9'],
    });
    expect(result.success && result.data.checkedPrepIds).toEqual(['prep-1', 'ing-9']);
    // The two lists are separate facts and neither leaks into the other.
    expect(result.success && result.data.checkedIngredientIds).toEqual(['ing-1']);
  });
});

describe('CookSessionSchema — the removed get-out tick list', () => {
  // `checkedContainerNames` was the THIRD tick list, behind the Get-out stage
  // (issue #761, Phase 3). Issue #767 deleted the stage and the field. cookSessions
  // have no TTL and a cook can span days, so a session mid-cook when that shipped
  // still carries the key — and must still parse, or the deploy kills the cook.
  const base = {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
    createdAt: '2026-08-08T18:30:00.000Z',
    updatedAt: '2026-08-08T18:30:00.000Z',
  };

  it('BACK-COMPAT: a session still carrying the removed key parses, stripped', () => {
    const result = CookSessionSchema.safeParse({
      ...base,
      checkedIngredientIds: ['ing-1'],
      checkedPrepIds: ['prep-1'],
      completedStepIds: ['step-1'],
      checkedContainerNames: ['onion bowl', 'jug'],
    });
    expect(result.success).toBe(true);
    expect(result.success && 'checkedContainerNames' in result.data).toBe(false);
    // Everything the cook actually did survives the field going away.
    expect(result.success && result.data.checkedPrepIds).toEqual(['prep-1']);
    expect(result.success && result.data.checkedIngredientIds).toEqual(['ing-1']);
    expect(result.success && result.data.completedStepIds).toEqual(['step-1']);
  });
});

describe('CookSessionSchema.serveAt', () => {
  // Meals (issue #752, phase 4). The same back-compat obligation as every other
  // field added to this document: cookSessions have no TTL and a cook can span
  // days, so every session already in Firestore predates it.
  const base = {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
    createdAt: '2026-08-15T18:30:00.000Z',
    updatedAt: '2026-08-15T18:30:00.000Z',
  };

  it('BACK-COMPAT: a session written without it parses, and reads back null', () => {
    const result = CookSessionSchema.safeParse(base);
    expect(result.success).toBe(true);
    // `.default(null)`, not `.optional()` — every reader sees a concrete
    // `string | null` and nobody has to tell "absent" from "no serve time".
    expect(result.success && result.data.serveAt).toBeNull();
  });

  it('keeps an absolute instant verbatim — never a wall-clock "HH:mm"', () => {
    const serveAt = '2026-08-16T18:00:00.000Z';
    const result = CookSessionSchema.safeParse({ ...base, serveAt });
    expect(result.success && result.data.serveAt).toBe(serveAt);
  });

  it('accepts an explicit null — the serve time cleared', () => {
    const result = CookSessionSchema.safeParse({ ...base, serveAt: null });
    expect(result.success && result.data.serveAt).toBeNull();
  });
});

describe('CookSessionSchema.servings', () => {
  // Reading a recipe at a different number of servings (issue #1314). The cook
  // session is the ONE place a scale is stored — everywhere else it lives in the
  // URL — because a cook is explicitly resumable across devices. It CAN go stale:
  // cookSessions have no TTL, so an abandoned cook keeps whatever scale it was
  // last opened at.
  //
  // The same back-compat obligation as every other field added to this document:
  // cookSessions have no TTL and a cook can span days, so EVERY session already in
  // Firestore predates this one.
  const base = {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
    createdAt: '2026-09-10T18:30:00.000Z',
    updatedAt: '2026-09-10T18:30:00.000Z',
  };

  it('BACK-COMPAT: a session written without it parses, and reads back null', () => {
    const result = CookSessionSchema.safeParse(base);
    expect(result.success).toBe(true);
    // `.default(null)`, not `.optional()` — no reader has to tell "absent" from
    // "as written", and both mean the recipe's own number.
    expect(result.success && result.data.servings).toBeNull();
  });

  it('keeps a pinned count', () => {
    const result = CookSessionSchema.safeParse({ ...base, servings: 6 });
    expect(result.success && result.data.servings).toBe(6);
  });

  it('accepts an explicit null — cooking as written', () => {
    const result = CookSessionSchema.safeParse({ ...base, servings: null });
    expect(result.success && result.data.servings).toBeNull();
  });

  it('rejects a non-numeric count rather than scaling by a string', () => {
    expect(CookSessionSchema.safeParse({ ...base, servings: '6' }).success).toBe(false);
  });

  // A Firestore read is a trust boundary, and `readServingsParam`
  // (apps/web-pwa/src/routes/recipes/servingsParam.ts) already hardens the URL
  // path against exactly these values — a zero or negative count would have the
  // cook banner claim "scaled for 0" over amounts that are as written.
  it('rejects zero — not a scaling base', () => {
    expect(CookSessionSchema.safeParse({ ...base, servings: 0 }).success).toBe(false);
  });

  it('rejects a negative count', () => {
    expect(CookSessionSchema.safeParse({ ...base, servings: -2 }).success).toBe(false);
  });

  it('rejects a non-integer count', () => {
    expect(CookSessionSchema.safeParse({ ...base, servings: 2.5 }).success).toBe(false);
  });
});
