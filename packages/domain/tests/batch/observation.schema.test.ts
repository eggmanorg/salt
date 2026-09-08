import { describe, it, expect } from 'vitest';
import { BatchObservationSchema } from '../../src/schemas/index.js';

// The observation log's shape (issue #812, phase 4). What is worth pinning is the
// set of entries a real log actually contains — a weight on Tuesday, a sentence on
// Thursday, a photo on Sunday — and the two bounds that catch a typo rather than a
// measurement.
//
// There is no producer to test: an observation is a document in a subcollection, so
// "append this entry" is `[...log, entry]` and appending to an array is not a
// decision (docs/domain-implementation.md). The one decision — the log's ORDER — is
// made where the log is read, by `subscribeBatchObservations`' `orderBy('at')`.

function observation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'obs-3c19',
    schemaVersion: 1,
    at: '2026-08-14T08:10:00.000Z',
    weightGrams: 1240,
    ph: null,
    temperatureC: 12,
    note: 'Bloom even, smells sweet.',
    image: null,
    ...overrides,
  };
}

describe('BatchObservationSchema', () => {
  it('accepts a full reading', () => {
    expect(BatchObservationSchema.safeParse(observation()).success).toBe(true);
  });

  // The common case, and the reason every measurement is independently nullable: a
  // real entry is usually one of the five.
  it('accepts a note with no measurements at all', () => {
    const result = BatchObservationSchema.safeParse(
      observation({ weightGrams: null, ph: null, temperatureC: null, note: 'Cased today.' }),
    );
    expect(result.success).toBe(true);
  });

  // A photo or a note is usually the point; an entry carrying neither is still a
  // valid record of "I looked at it on Sunday and it was fine". Nothing here judges.
  it('accepts an entirely empty entry', () => {
    const result = BatchObservationSchema.safeParse(
      observation({ weightGrams: null, ph: null, temperatureC: null, note: '' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts an attached photo', () => {
    const result = BatchObservationSchema.safeParse(
      observation({
        image: {
          url: 'https://firebasestorage.example/o/batch-images%2Fb1%2Fobs-3c19.webp',
          source: 'upload',
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  // Below freezing is a real place a batch sits — a garage in January, a freezer —
  // so the temperature is deliberately unbounded downwards.
  it('accepts a sub-zero temperature', () => {
    expect(BatchObservationSchema.safeParse(observation({ temperatureC: -4 })).success).toBe(true);
  });

  // A strip or a probe cannot read outside 0–14, so a value beyond it is a typo.
  it('rejects a pH outside the scale that exists', () => {
    expect(BatchObservationSchema.safeParse(observation({ ph: 15 })).success).toBe(false);
    expect(BatchObservationSchema.safeParse(observation({ ph: -1 })).success).toBe(false);
    expect(BatchObservationSchema.safeParse(observation({ ph: 4.2 })).success).toBe(true);
  });

  it('rejects a negative weight', () => {
    expect(BatchObservationSchema.safeParse(observation({ weightGrams: -1 })).success).toBe(false);
  });

  // Nothing generates an observation photo — a person took it — so the only source
  // is an upload, and the literal is what says so.
  it('rejects an image claiming a source nothing writes', () => {
    const result = BatchObservationSchema.safeParse(
      observation({ image: { url: 'https://example/x.webp', source: 'ai' } }),
    );
    expect(result.success).toBe(false);
  });

  // A missing `at` would leave the entry unorderable, which is the one thing the log
  // cannot survive: `subscribeBatchObservations` orders on it, and a Firestore
  // `orderBy` drops documents that lack the field entirely.
  it('requires the instant it was observed', () => {
    const { at: _at, ...withoutAt } = observation();
    expect(BatchObservationSchema.safeParse(withoutAt).success).toBe(false);
  });
});

// ─── Which stage the reading is about (issue #1276) ─────────────────────────────
//
// The back-compat half is the one worth pinning: every observation in production was
// written before this field existed, and a READ DEFAULT is the whole of why no
// migration is needed. The fixture above deliberately carries no `stageId`, so every
// case in the suite already parses a pre-#1276 document — these say so out loud.

describe('BatchObservationSchema — the stage a reading is about', () => {
  it('defaults a document written before the field existed to no stage', () => {
    const before = observation();
    expect('stageId' in before).toBe(false);

    const result = BatchObservationSchema.safeParse(before);
    expect(result.success).toBe(true);
    expect(result.success && result.data.stageId).toBeNull();
  });

  it('keeps the stage id it was given, unexamined', () => {
    // A plain FK into the parent's frozen `stages`, resolved at render. Nothing here
    // knows which run this hangs under, so nothing here can check that it resolves.
    const result = BatchObservationSchema.safeParse(observation({ stageId: 'stage-bulk' }));
    expect(result.success && result.data.stageId).toBe('stage-bulk');
  });

  it('accepts an explicit null — a reading about the run as a whole', () => {
    // The ordinary end-of-run entry belongs to no single stage, so "no stage" is a
    // real answer and not a missing one.
    const result = BatchObservationSchema.safeParse(observation({ stageId: null }));
    expect(result.success && result.data.stageId).toBeNull();
  });

  it('rejects anything that is not an id', () => {
    expect(BatchObservationSchema.safeParse(observation({ stageId: 3 })).success).toBe(false);
  });
});

describe('BatchObservationSchema — the humidity beside the temperature (issue #1286)', () => {
  it("accepts a cure's weekly reading — a weight, a temperature and a humidity", () => {
    const result = BatchObservationSchema.safeParse(
      observation({ weightGrams: 1240, temperatureC: 12, relativeHumidityPercent: 75 }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.relativeHumidityPercent).toBe(75);
  });

  it('bounds the humidity to the scale that exists, at both ends', () => {
    // 0 and 100 are readings; 101 and -1 are typos, not measurements — the same
    // argument `ph`'s 0–14 bound makes.
    expect(
      BatchObservationSchema.safeParse(observation({ relativeHumidityPercent: 0 })).success,
    ).toBe(true);
    expect(
      BatchObservationSchema.safeParse(observation({ relativeHumidityPercent: 100 })).success,
    ).toBe(true);
    expect(
      BatchObservationSchema.safeParse(observation({ relativeHumidityPercent: 101 })).success,
    ).toBe(false);
    expect(
      BatchObservationSchema.safeParse(observation({ relativeHumidityPercent: -1 })).success,
    ).toBe(false);
  });

  it('reads an observation written before this field as one that recorded no humidity', () => {
    // The whole of the back-compat story: additive, with a read default, so every
    // entry already in the log parses unchanged and there is no migration.
    const before: Record<string, unknown> = observation({ relativeHumidityPercent: 75 });
    delete before.relativeHumidityPercent;
    const result = BatchObservationSchema.safeParse(before);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.relativeHumidityPercent).toBeNull();
    // And nothing else about the entry moved.
    expect(result.data.weightGrams).toBe(1240);
    expect(result.data.temperatureC).toBe(12);
  });
});
