/**
 * The chef reading the household's notes (issue #816, phase 2).
 *
 * Three things carry the feature and are pinned here:
 *
 *  - GROUPING BY AUTHOR. The chef only ever raises a note belonging to someone
 *    OTHER than the person it is talking to, which it cannot do unless the prompt
 *    says who wrote what. A flat list of sentences would quietly turn "your partner
 *    doesn't eat mushrooms" into nagging the mushroom-lover about their own note.
 *  - IT DEGRADES TO SILENCE. Empty, missing, malformed or unreadable, the section
 *    is omitted entirely and chat behaves exactly as it did before this existed.
 *    One corrupt document costs its own note and nothing else.
 *  - THE FRAMING IS PREFERENCES, NOT RULES. The conversation always wins, a note is
 *    never a refusal, and the notes are never listed back. Those words are the
 *    whole difference between a chef that remembers and a chef that nags.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWarn = vi.fn();
vi.mock('firebase-functions', () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

const { renderKitchenMemories, readKitchenMemoryContext, kitchenMemorySectionForChef } =
  await import('../../src/flows/kitchenMemoryContext.js');

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function note(id: string, author: string, text: string, createdAt: string) {
  return { id, schemaVersion: 1 as const, author, text, createdAt };
}

/** A Firestore stub whose `kitchenMemories` collection holds `docs`. */
function dbWith(docs: { id: string; data: unknown }[]) {
  return {
    collection: () => ({
      get: () => Promise.resolve({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) }),
    }),
  } as never;
}

// ─── rendering ────────────────────────────────────────────────────────────────

describe('renderKitchenMemories', () => {
  it('groups the notes under the name of whoever wrote each one', () => {
    const out = renderKitchenMemories([
      note('m1', 'Daniel', 'we hate coriander', '2026-08-01T09:00:00.000Z'),
      note('m2', 'Kate', "I don't eat mushrooms", '2026-08-01T10:00:00.000Z'),
      note('m3', 'Daniel', 'Tuesday is always quick', '2026-08-01T11:00:00.000Z'),
    ]);

    // Each author appears once, with their own notes under them — the grouping is
    // what lets the chef tell its own listener's note from their partner's.
    expect(out).toBe(
      [
        'Daniel:',
        '- we hate coriander',
        '- Tuesday is always quick',
        '',
        'Kate:',
        "- I don't eat mushrooms",
      ].join('\n'),
    );
  });

  it('renders a stable order regardless of the order Firestore hands them back', () => {
    const notes = [
      note('m3', 'Kate', 'third', '2026-08-03T00:00:00.000Z'),
      note('m1', 'Daniel', 'first', '2026-08-01T00:00:00.000Z'),
      note('m2', 'Daniel', 'second', '2026-08-02T00:00:00.000Z'),
    ];

    const forwards = renderKitchenMemories(notes);
    const backwards = renderKitchenMemories([...notes].reverse());

    // The prompt must not churn between turns over an unordered collection read.
    expect(forwards).toBe(backwards);
    expect(forwards.indexOf('first')).toBeLessThan(forwards.indexOf('second'));
    expect(forwards.indexOf('Daniel:')).toBeLessThan(forwards.indexOf('Kate:'));
  });

  it('keeps the household notes verbatim', () => {
    const out = renderKitchenMemories([
      note('m1', 'Daniel', 'no more than 20 minutes on a school night', '2026-08-01T00:00:00.000Z'),
    ]);
    expect(out).toContain('- no more than 20 minutes on a school night');
  });

  it('degrades to an empty string when there are no notes', () => {
    expect(renderKitchenMemories([])).toBe('');
  });
});

// ─── reading ──────────────────────────────────────────────────────────────────

describe('readKitchenMemoryContext', () => {
  it('reads, validates, and renders the collection', async () => {
    const db = dbWith([
      { id: 'm1', data: note('m1', 'Daniel', 'we hate coriander', '2026-08-01T09:00:00.000Z') },
      { id: 'm2', data: note('m2', 'Kate', 'I love a Sunday roast', '2026-08-01T10:00:00.000Z') },
    ]);

    const out = await readKitchenMemoryContext(db, 'chefChat');
    expect(out).toContain('Daniel:');
    expect(out).toContain('- we hate coriander');
    expect(out).toContain('Kate:');
    expect(out).toContain('- I love a Sunday roast');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('degrades to an empty string when the household has written nothing', async () => {
    expect(await readKitchenMemoryContext(dbWith([]), 'chefChat')).toBe('');
  });

  it('skips a note that fails validation and keeps the rest', async () => {
    const db = dbWith([
      { id: 'bad', data: { nonsense: true } },
      { id: 'm2', data: note('m2', 'Kate', "I don't eat mushrooms", '2026-08-01T10:00:00.000Z') },
    ]);

    const out = await readKitchenMemoryContext(db, 'chefChat');
    // One corrupt document must not cost the household everything else it said.
    expect(out).toContain("- I don't eat mushrooms");
    expect(out).not.toContain('nonsense');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('bad'));
  });

  it('degrades to an empty string when every note fails validation', async () => {
    const db = dbWith([{ id: 'bad', data: { nonsense: true } }]);
    expect(await readKitchenMemoryContext(db, 'chefChat')).toBe('');
  });

  it('logs and degrades when the read throws — never propagates the failure', async () => {
    const db = {
      collection: () => ({ get: () => Promise.reject(new Error('firestore down')) }),
    } as never;

    expect(await readKitchenMemoryContext(db, 'chefChat')).toBe('');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('failed to read kitchenMemories'),
      expect.anything(),
    );
  });
});

// ─── framing ──────────────────────────────────────────────────────────────────

describe('kitchenMemorySectionForChef', () => {
  const context = 'Daniel:\n- we hate coriander';

  it('frames the notes as preferences the conversation overrules, never as rules', () => {
    const section = kitchenMemorySectionForChef(context, 'Kate');

    expect(section).toContain(context);
    expect(section).toContain('preferences, not rules');
    expect(section).toContain('WHAT IS SAID IN THIS CONVERSATION ALWAYS WINS');
    expect(section).toContain('exactly what they asked for');
    expect(section).toContain('do not quietly substitute an ingredient');
    expect(section).toContain('never present a note as a reason you cannot do something');
    // ...and the rule is scoped to taste. Unscoped, the chef read it as "never
    // question any request" and stopped warning about methods that hurt the dish.
    expect(section).toContain('It never stops you warning that a METHOD will');
    // The one permitted mention, and its two limits: someone else's note, once.
    expect(section).toContain('someone OTHER than the person you are talking to');
    expect(section).toContain('only once');
    expect(section).toContain('Never list these back');
    // "Standing instructions" is the wording that produces the nagging chef this
    // whole framing exists to avoid. It must never come back.
    expect(section).not.toContain('standing instruction');
  });

  it('tells the chef who it is talking to', () => {
    expect(kitchenMemorySectionForChef(context, 'Kate')).toContain('You are talking to Kate.');
  });

  it('drops the attribution line rather than naming nobody when the speaker is unknown', () => {
    // An older client after a deploy sends no speaker. The section still carries
    // the notes and their authors; it just never claims to know who is typing.
    const section = kitchenMemorySectionForChef(context);
    expect(section).not.toContain('You are talking to');
    expect(section).toContain(context);
    expect(section).toContain('preferences, not rules');

    // A blank speaker is the same case, not an empty name in the prompt.
    expect(kitchenMemorySectionForChef(context, '   ')).not.toContain('You are talking to');
  });

  it('omits the section entirely when there are no notes', () => {
    expect(kitchenMemorySectionForChef('', 'Kate')).toBe('');
    expect(kitchenMemorySectionForChef('')).toBe('');
  });
});
