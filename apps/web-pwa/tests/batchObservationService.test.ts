import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { get } from 'svelte/store';
import type { BatchObservationDoc } from '@salt/domain/schemas';
import { ErrorCode } from '@salt/shared-types';

// The observation log's write path (issue #812, phase 4 of epic #778).
//
// Three things this service exists to get right, and all three are asserted here
// rather than left to a screen:
//
//   • IT MINTS THE ID AND NOTHING ELSE (CLAUDE.md Rule 1 — the domain mints neither
//     an id nor an instant). The id is also the document id, which is what makes
//     correcting an entry a re-write rather than a delete-and-re-add. Since #1276
//     the INSTANT is the screen's, not this service's: `at` and `stageId` are
//     written through exactly as handed over, and no clock is read here.
//   • THE TWO WRITES GO IN ONE ORDER. The entry first, the photo second, because the
//     callable finishes with a partial update and a partial update of an absent
//     document fails.
//   • A FAILED UPLOAD COSTS THE PHOTO AND NEVER THE READING. The result is the
//     reading's; the photo's fate is reported separately inside a SUCCESS.

vi.mock('@salt/firebase-sync', () => ({
  subscribeBatchObservations: vi.fn(() => () => {}),
  addBatchObservation: vi.fn(async () => ({ kind: 'ok', value: undefined })),
  callSetObservationImageUpload: vi.fn(async () => ({ kind: 'ok', value: undefined })),
  isAuthTransitioning: vi.fn(() => false),
}));

vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
}));

import * as firebaseSync from '@salt/firebase-sync';
import {
  observations,
  initBatchObservationsSync,
  logObservation,
} from '../src/lib/batchObservationService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

const BATCH_ID = 'batch-1';

// When the reading was TAKEN, and it is deliberately a long way from now: every
// assertion that `at` survives untouched is also the assertion that nothing here
// reaches for a clock.
const OBSERVED_AT = '2026-08-11T20:40:00.000Z';

/** The two the screen now owns, defaulted so a case can name only what it is about. */
function input(over: Partial<Parameters<typeof logObservation>[0]> = {}) {
  return {
    batchId: BATCH_ID,
    at: OBSERVED_AT,
    stageId: null,
    weightGrams: null,
    temperatureC: null,
    relativeHumidityPercent: null,
    note: '',
    ...over,
  };
}

function writtenObservation(call = 0): BatchObservationDoc {
  const args = fs.addBatchObservation.mock.calls[call];
  if (!args) throw new Error('addBatchObservation was not called');
  return args[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.subscribeBatchObservations.mockImplementation(() => () => {});
  fs.addBatchObservation.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.callSetObservationImageUpload.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('batchObservationService — the subscription', () => {
  it('resets to not-loaded on init, so one run never shows another’s readings', () => {
    initBatchObservationsSync(BATCH_ID);
    expect(get(observations)).toBeUndefined();
    expect(fs.subscribeBatchObservations).toHaveBeenCalledWith(
      BATCH_ID,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('publishes the adapter’s list exactly as delivered, in its order', () => {
    // `orderBy('at', 'asc')` is the adapter's and is not re-done here: a service that
    // re-sorted could disagree with the query, and arrival order would quietly make a
    // cure's curve wrong.
    const delivered: BatchObservationDoc[] = [
      {
        id: 'obs-tuesday',
        schemaVersion: 1,
        at: '2026-08-11T08:00:00.000Z',
        stageId: null,
        weightGrams: 1440,
        ph: null,
        temperatureC: null,
        relativeHumidityPercent: null,
        note: '',
        image: null,
      },
      {
        id: 'obs-thursday',
        schemaVersion: 1,
        at: '2026-08-13T08:00:00.000Z',
        stageId: null,
        weightGrams: 1402,
        ph: null,
        temperatureC: null,
        relativeHumidityPercent: null,
        note: '',
        image: null,
      },
    ];
    initBatchObservationsSync(BATCH_ID);
    const onObservations = fs.subscribeBatchObservations.mock.calls[0]![1];
    onObservations(delivered);

    expect(get(observations)).toEqual(delivered);
  });

  it('hands the unsub straight back', () => {
    const unsub = vi.fn();
    fs.subscribeBatchObservations.mockReturnValue(unsub);
    expect(initBatchObservationsSync(BATCH_ID)).toBe(unsub);
  });
});

describe('batchObservationService — the instant it refuses (issue #1292)', () => {
  // CLAUDE.md Rule 12. The header claimed "`at` arrives already an instant" and one
  // component's `canSave` was the whole of the enforcement — so the claim held only
  // while this path had a single caller, and #1280 gave it more. These are the tests
  // that go red if the rail comes out.

  it.each([
    ['empty', ''],
    ['prose', 'yesterday evening'],
    ['a half-typed box', '2026-08-14T08:'],
    ['an impossible date', '2026-02-31T25:99'],
  ])('refuses %s rather than writing an entry the log cannot place', async (_label, at) => {
    const result = await logObservation(input({ at, weightGrams: 1440 }));

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') throw new Error('unreachable');
    expect(result.error).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.INVALID_OBSERVATION_TIME,
    });
    // Refused BEFORE the write, not cleaned up after one.
    expect(fs.addBatchObservation).not.toHaveBeenCalled();
  });

  it('does not substitute a clock of its own for the one it refused', async () => {
    // A silent "now" would file the reading at the wrong point in the very ordering
    // `at` exists to carry. The caller holds the box and is the only thing that can
    // ask again.
    await logObservation(input({ at: 'not a time', weightGrams: 1440 }));

    expect(fs.addBatchObservation).not.toHaveBeenCalled();
    expect(fs.callSetObservationImageUpload).not.toHaveBeenCalled();
  });

  it('refuses before the photo, so a rejected entry cannot leave an orphan image', async () => {
    const result = await logObservation(
      input({ at: 'not a time', weightGrams: 1440, photoBase64: 'AAAA' }),
    );

    expect(result.kind).toBe('err');
    expect(fs.callSetObservationImageUpload).not.toHaveBeenCalled();
  });

  it('asks only that the instant be readable, not that it be formatted one way', async () => {
    // `Date.parse` is the bar, exactly as it is in the domain's own stage
    // transitions. A caller is not made to pre-normalise.
    const result = await logObservation(
      input({ at: '2026-08-11T21:40:00+01:00', weightGrams: 1440 }),
    );

    expect(result.kind).toBe('ok');
  });

  it('stores one canonical form, so the string ordering IS the instant ordering', async () => {
    // Firestore orders the log with `orderBy('at', 'asc')` over a string. An offset
    // form and a Z form of the SAME moment sort an hour apart, so the canonicalising
    // is what makes the log's ordering true of every caller and not just the sheet.
    await logObservation(input({ at: '2026-08-11T21:40:00+01:00', weightGrams: 1440 }));

    expect(writtenObservation().at).toBe('2026-08-11T20:40:00.000Z');
  });
});

describe('batchObservationService — logging a reading', () => {
  it('mints the id, and mints nothing else', async () => {
    const result = await logObservation(input({ weightGrams: 1440, note: 'open crumb' }));

    expect(result.kind).toBe('ok');
    const doc = writtenObservation();
    expect(doc.id).toMatch(/[0-9a-f-]{16,}/i);
    expect(fs.addBatchObservation).toHaveBeenCalledWith(BATCH_ID, doc);
    // The document id IS the observation id — that is what makes a correction a
    // re-write of the same entry.
    expect(result.kind === 'ok' && result.value.observationId).toBe(doc.id);
  });

  it('writes the instant it was handed, and never reaches for a clock', async () => {
    // The pin for #1276. `OBSERVED_AT` is days away from now, so a service that read
    // `new Date()` — here, or in a later "helpful" default — fails this exactly.
    const before = Date.now();
    await logObservation(input({ at: OBSERVED_AT, weightGrams: 1440 }));
    const after = Date.now();

    expect(writtenObservation().at).toBe(OBSERVED_AT);
    const written = new Date(writtenObservation().at).getTime();
    expect(written).toBeLessThan(before);
    expect(written).toBeLessThan(after);
  });

  it('writes the stage it was handed, and does not check that it names one', async () => {
    // A plain FK into the parent's frozen `stages`, resolved at render — this service
    // has never seen the run and so cannot judge it.
    await logObservation(input({ stageId: 'stage-bulk', weightGrams: 1240 }));

    expect(writtenObservation().stageId).toBe('stage-bulk');
  });

  it('writes no stage at all for a reading about the whole run', async () => {
    await logObservation(input({ stageId: null, note: '108 g, good crumb' }));

    expect(writtenObservation().stageId).toBeNull();
  });

  it('mints a fresh id every time, so two readings can never collide', async () => {
    await logObservation(input({ weightGrams: 1440 }));
    await logObservation(input({ weightGrams: 1438 }));

    expect(writtenObservation(0).id).not.toBe(writtenObservation(1).id);
  });

  it('writes the fields it collects and nulls the two it does not', async () => {
    await logObservation(input({ weightGrams: 1440, note: 'open crumb' }));

    expect(writtenObservation()).toMatchObject({
      schemaVersion: 1,
      at: OBSERVED_AT,
      stageId: null,
      weightGrams: 1440,
      note: 'open crumb',
      // No screen asks for these yet; null is what "not measured" is.
      ph: null,
      temperatureC: null,
      relativeHumidityPercent: null,
      // The photo never travels through the document — the callable stamps it on.
      image: null,
    });
  });

  it('writes the entry BEFORE attaching the photo', async () => {
    // Forced, not stylistic: the callable finishes with a partial update, and a
    // partial update of an absent document fails.
    const order: string[] = [];
    fs.addBatchObservation.mockImplementation(async () => {
      order.push('entry');
      return { kind: 'ok', value: undefined };
    });
    fs.callSetObservationImageUpload.mockImplementation(async () => {
      order.push('photo');
      return { kind: 'ok', value: undefined };
    });

    const result = await logObservation(input({ photoBase64: 'AAAA' }));

    expect(order).toEqual(['entry', 'photo']);
    expect(fs.callSetObservationImageUpload).toHaveBeenCalledWith(
      BATCH_ID,
      writtenObservation().id,
      'AAAA',
      'image/webp',
    );
    expect(result.kind === 'ok' && result.value.photo.kind).toBe('attached');
  });

  it('calls no callable at all when there is no photo', async () => {
    const result = await logObservation(input({ weightGrams: 1440 }));

    expect(fs.callSetObservationImageUpload).not.toHaveBeenCalled();
    expect(result.kind === 'ok' && result.value.photo.kind).toBe('none');
  });

  it('keeps the reading when the photo will not upload, and says so separately', async () => {
    // The whole point of the ordering. By the time an upload can fail the entry is
    // already in the log, so this is a SUCCESS whose photo failed — never an error
    // that would imply the weight was lost.
    fs.callSetObservationImageUpload.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });

    const result = await logObservation(
      input({ weightGrams: 1440, note: 'open crumb', photoBase64: 'AAAA' }),
    );

    expect(fs.addBatchObservation).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.value.photo).toEqual({
      kind: 'failed',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
  });

  it('never tries the photo when the entry itself did not land', async () => {
    // Nothing to attach it to, and a partial update of an absent document fails.
    fs.addBatchObservation.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });

    const result = await logObservation(input({ weightGrams: 1440, photoBase64: 'AAAA' }));

    expect(fs.callSetObservationImageUpload).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'err', error: { kind: 'NetworkError', reason: 'offline' } });
  });

  it('appends rather than replacing — two readings are two documents', async () => {
    // The subcollection is what makes two people logging on the same day safe. This
    // service must never gather them up: one call, one document, one id.
    await logObservation(input({ weightGrams: 1440, note: 'hers' }));
    await logObservation(input({ weightGrams: 1438, note: 'his' }));

    expect(fs.addBatchObservation).toHaveBeenCalledTimes(2);
    expect(writtenObservation(0).note).toBe('hers');
    expect(writtenObservation(1).note).toBe('his');
  });
});
