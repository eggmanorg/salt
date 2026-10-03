import { describe, it, expect, vi } from 'vitest';
import {
  matchOrCreate,
  ARBITRATION_FAILED_REASONING,
  ARBITRATION_NO_MATCH_REASONING,
} from '../../src/canon/commands/matchOrCreate.js';
import type { CanonLocalStorePort } from '../../src/canon/ports/CanonLocalStorePort.js';
import type { AisleLocalStorePort } from '../../src/canon/ports/AisleLocalStorePort.js';
import type { EmbeddingPort } from '../../src/canon/ports/EmbeddingPort.js';
import type { CanonArbitrationPort } from '../../src/canon/ports/CanonArbitrationPort.js';
import type { IdGenerator } from '../../src/canon/ports/IdGenerator.js';
import type { MatchLoggingPort } from '../../src/canon/ports/MatchLoggingPort.js';
import type { CanonItem } from '../../src/canon/entities/CanonItem.js';
import type { MatchLogEntry } from '../../src/canon/entities/MatchLogEntry.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function canonItem(overrides: Partial<CanonItem> & { id: string; name: string }): CanonItem {
  return {
    schemaVersion: 5,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
    ...overrides,
  };
}

let idCounter = 0;

function makeIds(): IdGenerator {
  return { newCanonId: () => `id-${++idCounter}`, newAisleId: () => `aisle-${++idCounter}` };
}

function makeStore(initial: CanonItem[] = []): CanonLocalStorePort & { items: CanonItem[] } {
  const items = [...initial];
  return {
    items,
    list: async () => ({ kind: 'ok', value: items }),
    load: async (id) => {
      const found = items.find((i) => i.id === id) ?? null;
      return { kind: 'ok', value: found };
    },
    upsert: async (item) => {
      const idx = items.findIndex((i) => i.id === item.id);
      if (idx >= 0) items[idx] = item;
      else items.push(item);
      return { kind: 'ok', value: item };
    },
    delete: async () => ({ kind: 'ok', value: undefined }),
  };
}

function makeAisleStore(): AisleLocalStorePort {
  return {
    load: async () => ({ kind: 'ok', value: [] }),
    save: async () => ({ kind: 'ok', value: undefined }),
  };
}

function makeAisleStoreWithAisles(): AisleLocalStorePort {
  const aisles = [{ id: 'produce', name: 'Produce', order: 1 }];
  return {
    load: async () => ({ kind: 'ok', value: aisles }),
    save: async () => ({ kind: 'ok', value: undefined }),
  };
}

// eX · eX = 1.0 (above stage5Stop=0.75); eX · eY = 0.0 (below)
const eX = [1, 0] as const;
const eY = [0, 1] as const;

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

function makeEmbedding(queryVec: readonly number[], itemVec?: readonly number[]): EmbeddingPort {
  return {
    computeEmbedding: async () => ({ kind: 'ok', value: queryVec }),
    cosineSimilarity: (a, b) => cosine(a, itemVec ?? b),
  };
}

function failEmbedding(): EmbeddingPort {
  return {
    computeEmbedding: async () => ({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    }),
    cosineSimilarity: cosine,
  };
}

function noMatchArbitration(): CanonArbitrationPort {
  return { arbitrate: async () => ({ kind: 'ok', value: { kind: 'no-match' } }) };
}

function newArbitration(canonName: string, aisleId: string | null = null): CanonArbitrationPort {
  return {
    arbitrate: async () => ({
      kind: 'ok',
      value: { kind: 'new', canonName, aisleId, shoppingBehavior: 'needed' as const },
    }),
  };
}

function matchArbitration(itemId: string, reasoning?: string): CanonArbitrationPort {
  return {
    arbitrate: async () => ({
      kind: 'ok',
      value: {
        kind: 'match',
        itemId,
        confidence: 0.95,
        shoppingBehavior: 'needed' as const,
        ...(reasoning !== undefined ? { reasoning } : {}),
      },
    }),
  };
}

function errorArbitration(): CanonArbitrationPort {
  return {
    arbitrate: async () => ({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    }),
  };
}

function makePipeline(
  opts: {
    store?: CanonLocalStorePort & { items: CanonItem[] };
    items?: CanonItem[];
    aisleStore?: AisleLocalStorePort;
    embedding?: EmbeddingPort;
    arbitration?: CanonArbitrationPort;
    logging?: MatchLoggingPort | null;
    isDerivedName?: (rawName: string) => boolean;
  } = {},
) {
  const store = opts.store ?? makeStore(opts.items ?? []);
  idCounter = 0;
  const ports = {
    store,
    aisleStore: opts.aisleStore ?? makeAisleStore(),
    embedding: opts.embedding ?? failEmbedding(),
    arbitration: opts.arbitration ?? noMatchArbitration(),
    ids: makeIds(),
    logging: opts.logging ?? null,
    ...(opts.isDerivedName !== undefined ? { isDerivedName: opts.isDerivedName } : {}),
  };
  const run = (rawName: string, selectedAisleId?: string | null, forceCreate?: boolean) =>
    matchOrCreate(
      {
        rawName,
        // `exactOptionalPropertyTypes` is on, so an omitted argument must leave
        // the key ABSENT rather than present-and-undefined.
        ...(selectedAisleId === undefined ? {} : { selectedAisleId }),
        ...(forceCreate === undefined ? {} : { forceCreate }),
      },
      ports,
    );
  return { run, store };
}

// ─── Stage 1: exact normalised name match ────────────────────────────────────

describe('stage 1 — exact name match', () => {
  it('returns the matched item when normalised names are identical', async () => {
    const apple = canonItem({ id: 'a1', name: 'Apple' });
    const { run } = makePipeline({ items: [apple] });
    const result = await run('apple');
    // No synonym added: normalised input equals normalised item name.
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.item.id).toBe('a1');
      expect(result.value.decision).toBe('matched');
    }
  });

  it('matches despite casing differences', async () => {
    const apple = canonItem({ id: 'a1', name: 'APPLE' });
    const { run } = makePipeline({ items: [apple] });
    const result = await run('apple');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.item.id).toBe('a1');
  });

  it('matches plural forms after singularisation', async () => {
    const apple = canonItem({ id: 'a1', name: 'apple' });
    const { run } = makePipeline({ items: [apple] });
    const result = await run('apples');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.item.id).toBe('a1');
  });

  it('does not create a new item when stage 1 matches', async () => {
    const apple = canonItem({ id: 'a1', name: 'apple' });
    const { run, store } = makePipeline({ items: [apple] });
    await run('apple');
    expect((store as ReturnType<typeof makeStore>).items).toHaveLength(1);
  });

  it('returns decision=matched for a stage-1 hit', async () => {
    const apple = canonItem({ id: 'a1', name: 'apple' });
    const { run } = makePipeline({ items: [apple] });
    const result = await run('apple');
    if (result.kind === 'ok') expect(result.value.decision).toBe('matched');
  });
});

// ─── Stage 3: synonym match ───────────────────────────────────────────────────

describe('stage 3 — synonym match', () => {
  it('matches via a stored synonym', async () => {
    const tomato = canonItem({ id: 't1', name: 'tomato', synonyms: ['love apple'] });
    const { run } = makePipeline({ items: [tomato] });
    const result = await run('Love Apple');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.item.id).toBe('t1');
  });
});

// ─── Stage 5: embedding match ─────────────────────────────────────────────────

describe('stage 5 — embedding match', () => {
  it('returns the best cosine match when above stage5Stop threshold', async () => {
    // Item embedding = eX; query embedding = eX → cosine = 1.0 >= 0.75
    const oil = canonItem({ id: 'o1', name: 'XYZ-unique-name', embedding: eX });
    const { run } = makePipeline({
      items: [oil],
      embedding: makeEmbedding(eX),
    });
    const result = await run('XYZ-unique-name');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.item.id).toBe('o1');
      expect(result.value.decision).toBe('matched');
    }
  });

  it('prefers the approved item when confidence is equal', async () => {
    const unapproved = canonItem({
      id: 'u1',
      name: 'foo bar baz',
      embedding: eX,
      needs_approval: true,
    });
    const approved = canonItem({
      id: 'a1',
      name: 'foo bar baz',
      embedding: eX,
      needs_approval: false,
    });
    const { run } = makePipeline({
      items: [unapproved, approved],
      embedding: makeEmbedding(eX),
    });
    const result = await run('foo bar baz qux'); // stage 1–4 won't fire; stage 5 will
    if (result.kind === 'ok') expect(result.value.item.id).toBe('a1');
  });
});

// ─── Stage 6: single near-miss → direct match ────────────────────────────────
// When exactly one candidate is above aiThreshold (but below a deterministic
// stop threshold), it is matched directly without calling the arbitration port.

describe('stage 6 — single near-miss: direct match', () => {
  it('matches the single near-miss candidate directly', async () => {
    // tokenMatch('olive oil', 'olive oil extra') ≈ 0.67 — above aiThreshold (0.6)
    const item = canonItem({ id: 'x1', name: 'olive oil extra' });
    const { run } = makePipeline({ items: [item] });
    const result = await run('olive oil');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.item.id).toBe('x1');
      expect(result.value.decision).toBe('matched');
    }
  });

  it('does not call the arbitration port for a single near-miss', async () => {
    const item = canonItem({ id: 'x1', name: 'olive oil extra' });
    const arbitrateSpy = vi.fn().mockResolvedValue({ kind: 'ok', value: { kind: 'no-match' } });
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'olive oil' },
      {
        store: makeStore([item]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: { arbitrate: arbitrateSpy },
        ids: makeIds(),
        logging: null,
      },
    );
    expect(arbitrateSpy).not.toHaveBeenCalled();
  });
});

// ─── Stage 6: lone edit-distance near-miss → AI, never a silent match ────────
// Regression: "olives" vs "limes" normalises to "olive" vs "lime", a Levenshtein
// similarity of exactly 0.6 — at aiThreshold but only stage 4 (edit distance, a
// spelling coincidence). A lone stage-4 candidate must NOT auto-bind the way a
// stage-2 token candidate does; it escalates to AI like embeddings, so unrelated
// foods are never silently merged.

describe('stage 6 — lone edit-distance near-miss escalates to AI', () => {
  it('does not silently match "olives" to "limes"', async () => {
    const limes = canonItem({ id: 'lime1', name: 'limes' });
    const arbitrateSpy = vi.fn().mockResolvedValue({ kind: 'ok', value: { kind: 'no-match' } });
    const { run } = makePipeline({
      items: [limes],
      arbitration: { arbitrate: arbitrateSpy },
    });
    const result = await run('olives');
    // It consults AI rather than auto-binding to the 0.6 Levenshtein neighbour…
    expect(arbitrateSpy).toHaveBeenCalled();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // …and with a no-match verdict a fresh canon item is created, not limes.
      expect(result.value.item.id).not.toBe('lime1');
      expect(result.value.decision).not.toBe('matched');
    }
  });
});

// ─── Stage 6: multiple near-misses → AI arbitration is sole decider ──────────

describe('stage 6 — multiple near-misses: AI arbitrates', () => {
  // Both items score above aiThreshold (0.6) with tokenMatch for 'olive oil'
  const item1 = canonItem({ id: 'x1', name: 'olive oil extra' });
  const item2 = canonItem({ id: 'x2', name: 'olive oil light' });

  it('returns ai_arbitrated when AI picks one candidate', async () => {
    const { run } = makePipeline({
      items: [item1, item2],
      arbitration: matchArbitration('x2'),
    });
    const result = await run('olive oil');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.decision).toBe('ai_arbitrated');
      expect(result.value.item.id).toBe('x2');
    }
  });

  it('sets reasoning on the matched item when AI provides reasoning', async () => {
    const { run } = makePipeline({
      items: [item1, item2],
      arbitration: matchArbitration('x2', 'synonym is a regional variant'),
    });
    const result = await run('olive oil');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.item.reasoning).toBe('synonym is a regional variant');
    }
  });

  it('falls back to highest-confidence candidate when AI errors, flagged needs_approval', async () => {
    const { run, store } = makePipeline({
      items: [item1, item2],
      arbitration: errorArbitration(),
    });
    const result = await run('olive oil');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.decision).toBe('ai_arbitrated');
      expect(['x1', 'x2']).toContain(result.value.item.id);
      // appendCanonSynonym sets needs_approval=true so the user can review.
      expect(result.value.item.needs_approval).toBe(true);
    }
    // Original two items still exist; no third item created.
    expect((store as ReturnType<typeof makeStore>).items).toHaveLength(2);
  });
});

// ─── Aisle suggestion via arbitration ────────────────────────────────────────
// Arbitration is called with empty candidates when a new item needs an aisle.

describe('aisle suggestion — arbitration called on creation', () => {
  it('uses the AI-suggested aisle when creating a new item with no match', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: newArbitration('Garlic', 'produce'),
    });
    const result = await run('garlic-xyz-unique');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.item.aisleId).toBe('produce');
      expect(result.value.decision).toBe('created');
    }
  });

  it('creates item from the AI-arbitrated canonName, not the raw input', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: newArbitration('Garlic', 'produce'),
    });
    const result = await run('5 cloves garlic (minced)');
    if (result.kind === 'ok') {
      expect(result.value.item.name).toBe('Garlic');
    }
  });

  it('user-provided aisle overrides AI-suggested aisle', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: newArbitration('Garlic', 'produce'),
    });
    const result = await run('garlic-xyz-unique', 'spices');
    if (result.kind === 'ok') expect(result.value.item.aisleId).toBe('spices');
  });
});

// ─── No candidates → straight creation ───────────────────────────────────────

describe('creation path — no candidates', () => {
  it('creates a new item when the catalog is empty', async () => {
    const { run, store } = makePipeline();
    const result = await run('Garlic');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.item.name).toBe('Garlic');
      expect(result.value.item.aisleId).toBeNull();
      expect(result.value.item.needs_approval).toBe(true);
      expect(result.value.decision).toBe('created');
    }
    expect((store as ReturnType<typeof makeStore>).items).toHaveLength(1);
  });

  it('uses selectedAisleId when provided', async () => {
    const { run } = makePipeline();
    const result = await run('Garlic', 'produce');
    if (result.kind === 'ok') expect(result.value.item.aisleId).toBe('produce');
  });

  it('falls back to null when selectedAisleId is null', async () => {
    const { run } = makePipeline();
    const result = await run('Garlic', null);
    if (result.kind === 'ok') expect(result.value.item.aisleId).toBeNull();
  });

  it('uses arbitration-suggested aisle when selectedAisleId is absent and aisles exist', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: newArbitration('Garlic', 'produce'),
    });
    const result = await run('Garlic', null);
    if (result.kind === 'ok') expect(result.value.item.aisleId).toBe('produce');
  });

  it('leaves aisle null when no aisles are configured', async () => {
    const { run } = makePipeline({ arbitration: newArbitration('Garlic', 'produce') });
    const result = await run('Garlic', null);
    if (result.kind === 'ok') expect(result.value.item.aisleId).toBeNull();
  });
});

// ─── forceCreate ─────────────────────────────────────────────────────────────

describe('forceCreate — bypass matching', () => {
  it('creates a new item even when an exact match exists', async () => {
    const apple = canonItem({ id: 'a1', name: 'apple' });
    const { run, store } = makePipeline({ items: [apple] });
    const result = await run('apple', null, true);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.decision).toBe('created');
      // a new item, not the existing one
      expect(result.value.item.id).not.toBe('a1');
    }
    expect((store as ReturnType<typeof makeStore>).items).toHaveLength(2);
  });

  it('uses selectedAisleId when provided alongside forceCreate', async () => {
    const { run } = makePipeline({ arbitration: newArbitration('Garlic', 'produce') });
    const result = await run('Garlic', 'spices', true);
    if (result.kind === 'ok') expect(result.value.item.aisleId).toBe('spices');
  });

  it('falls back to arbitration-suggested aisle when selectedAisleId is absent', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: newArbitration('Garlic', 'produce'),
    });
    const result = await run('Garlic', null, true);
    if (result.kind === 'ok') expect(result.value.item.aisleId).toBe('produce');
  });

  it('leaves aisle null when arbitration provides no aisle', async () => {
    const { run } = makePipeline({ arbitration: noMatchArbitration() });
    const result = await run('Garlic', null, true);
    if (result.kind === 'ok') expect(result.value.item.aisleId).toBeNull();
  });

  it('returns decision=created', async () => {
    const { run } = makePipeline();
    const result = await run('Garlic', null, true);
    if (result.kind === 'ok') expect(result.value.decision).toBe('created');
  });
});

// ─── Error paths ──────────────────────────────────────────────────────────────

describe('error paths', () => {
  it('returns err when rawName normalises to empty string', async () => {
    const { run } = makePipeline();
    const result = await run('   ');
    expect(result.kind).toBe('err');
    if (result.kind === 'err') expect(result.error.kind).toBe('ValidationError');
  });

  it('propagates store.list() failure', async () => {
    const brokenStore: CanonLocalStorePort = {
      list: async () => ({ kind: 'err', error: { kind: 'StorageError', reason: 'unavailable' } }),
      load: async () => ({ kind: 'ok', value: null }),
      upsert: async (i) => ({ kind: 'ok', value: i }),
      delete: async () => ({ kind: 'ok', value: undefined }),
    };
    idCounter = 0;
    const result = await matchOrCreate(
      { rawName: 'Garlic' },
      {
        store: brokenStore,
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: null,
      },
    );
    expect(result.kind).toBe('err');
    if (result.kind === 'err') expect(result.error.kind).toBe('StorageError');
  });

  it('propagates store.upsert() failure', async () => {
    const brokenStore: CanonLocalStorePort = {
      list: async () => ({ kind: 'ok', value: [] }),
      load: async () => ({ kind: 'ok', value: null }),
      upsert: async () => ({ kind: 'err', error: { kind: 'StorageError', reason: 'unavailable' } }),
      delete: async () => ({ kind: 'ok', value: undefined }),
    };
    idCounter = 0;
    const result = await matchOrCreate(
      { rawName: 'Garlic' },
      {
        store: brokenStore,
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: null,
      },
    );
    expect(result.kind).toBe('err');
    if (result.kind === 'err') expect(result.error.kind).toBe('StorageError');
  });

  it('falls through to creation when arbitration port errors (aisle suggestion path)', async () => {
    // Empty catalog → no match → aisle arbitration triggered → errors → item created with null aisle
    idCounter = 0;
    const result = await matchOrCreate(
      { rawName: 'Garlic' },
      {
        store: makeStore([]),
        aisleStore: makeAisleStoreWithAisles(),
        embedding: failEmbedding(),
        arbitration: errorArbitration(),
        ids: makeIds(),
        logging: null,
      },
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.item.name).toBe('Garlic');
      expect(result.value.item.aisleId).toBeNull();
    }
  });
});

// ─── Phase 2 — fallback name when arbitration fails on creation ──────────────
// When a new item is created but arbitration could not supply a canonical name,
// the raw input is kept verbatim and a reasoning marker surfaces it for review.
// err and no-match get distinct markers; needs_approval stays true by default.

describe('fallback — arbitration invoked but no canonical name', () => {
  it('no-candidates path: arbitration error → rawName + failed marker, needs_approval', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: errorArbitration(),
    });
    const result = await run('5 cloves garlic (minced)');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.decision).toBe('created');
      expect(result.value.item.name).toBe('5 cloves garlic (minced)');
      expect(result.value.item.reasoning).toBe(ARBITRATION_FAILED_REASONING);
      expect(result.value.item.needs_approval).toBe(true);
    }
  });

  it('no-candidates path: arbitration no-match → rawName + no-match marker', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: noMatchArbitration(),
    });
    const result = await run('5 cloves garlic (minced)');
    if (result.kind === 'ok') {
      expect(result.value.item.name).toBe('5 cloves garlic (minced)');
      expect(result.value.item.reasoning).toBe(ARBITRATION_NO_MATCH_REASONING);
      expect(result.value.item.needs_approval).toBe(true);
    }
  });

  it('forceCreate path: arbitration error → rawName + failed marker', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: errorArbitration(),
    });
    const result = await run('2kg maris piper potatoes', null, true);
    if (result.kind === 'ok') {
      expect(result.value.decision).toBe('created');
      expect(result.value.item.name).toBe('2kg maris piper potatoes');
      expect(result.value.item.reasoning).toBe(ARBITRATION_FAILED_REASONING);
    }
  });

  it('forceCreate path: arbitration no-match → rawName + no-match marker', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: noMatchArbitration(),
    });
    const result = await run('2kg maris piper potatoes', null, true);
    if (result.kind === 'ok') {
      expect(result.value.item.reasoning).toBe(ARBITRATION_NO_MATCH_REASONING);
    }
  });

  it('manual create with a chosen aisle skips arbitration — no failure marker', async () => {
    // selectedAisleId provided → arbitration never runs on the no-candidates
    // path; this is a deliberately-authored canon name, not a failure.
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: errorArbitration(),
    });
    const result = await run('Maris Piper Potato', 'produce');
    if (result.kind === 'ok') {
      expect(result.value.item.name).toBe('Maris Piper Potato');
      expect(result.value.item.aisleId).toBe('produce');
      expect(result.value.item.reasoning).toBeUndefined();
    }
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('idempotency (stages 1–4)', () => {
  it('returns the same item for identical input after first creation', async () => {
    const { run, store } = makePipeline();
    const first = await run('Garlic');
    expect(first.kind).toBe('ok');

    // Second call: the item now exists in the store, stage 1 will match it
    const second = await run('Garlic');
    expect(second.kind).toBe('ok');
    if (first.kind === 'ok' && second.kind === 'ok') {
      expect(second.value.item.id).toBe(first.value.item.id);
    }
    expect((store as ReturnType<typeof makeStore>).items).toHaveLength(1);
  });

  it('matches the same item regardless of input casing', async () => {
    const { run } = makePipeline();
    const first = await run('Garlic');
    const second = await run('GARLIC');
    if (first.kind === 'ok' && second.kind === 'ok') {
      expect(second.value.item.id).toBe(first.value.item.id);
    }
  });
});

// ─── Ambiguity gap — near-tie at stages 1–4 → AI arbitration ─────────────────

describe('ambiguity gap — near-tie at stage 2 forwards to AI', () => {
  // Two items with the same token-overlap score against the query
  // 'alpha beta gamma delta epsilon' vs both 6-token items → both score 5/6 ≈ 0.833, gap ≈ 0
  const item1 = canonItem({ id: 'i1', name: 'alpha beta gamma delta epsilon zeta' });
  const item2 = canonItem({ id: 'i2', name: 'alpha beta gamma delta epsilon eta' });

  it('calls the arbitration port with the near-tie candidates', async () => {
    const arbitrateSpy = vi.fn().mockResolvedValue({
      kind: 'ok',
      value: { kind: 'match', itemId: 'i1', confidence: 0.9, shoppingBehavior: 'needed' },
    });
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'alpha beta gamma delta epsilon' },
      {
        store: makeStore([item1, item2]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: { arbitrate: arbitrateSpy },
        ids: makeIds(),
        logging: null,
      },
    );
    expect(arbitrateSpy).toHaveBeenCalledOnce();
    const req = arbitrateSpy.mock.calls[0]![0];
    expect(req.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('returns ai_arbitrated when arbitration picks one of the near-tie candidates', async () => {
    const { run } = makePipeline({
      items: [item1, item2],
      arbitration: matchArbitration('i1'),
    });
    const result = await run('alpha beta gamma delta epsilon');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.decision).toBe('ai_arbitrated');
      expect(result.value.item.id).toBe('i1');
    }
  });

  it('creates a new item when arbitration returns new for a near-tie', async () => {
    const { run, store } = makePipeline({
      items: [item1, item2],
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: newArbitration('Alpha Beta', 'produce'),
    });
    const result = await run('alpha beta gamma delta epsilon');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.decision).toBe('created');
      expect(result.value.item.name).toBe('Alpha Beta');
    }
    // Original two items still exist; one new item added
    expect((store as ReturnType<typeof makeStore>).items).toHaveLength(3);
  });
});

// ─── Auto-synonym capture — stages 1–5 matches ───────────────────────────────

describe('auto-synonym capture', () => {
  it('does not add a synonym when the normalised input equals the canonical name', async () => {
    const apple = canonItem({ id: 'a1', name: 'apple' });
    const { run, store } = makePipeline({ items: [apple] });
    await run('apple');
    const stored = (store as ReturnType<typeof makeStore>).items.find((i) => i.id === 'a1');
    expect(stored?.synonyms).toHaveLength(0);
    expect(stored?.needs_approval).toBe(false);
  });

  it('does not add a synonym or flip needs_approval for plural/case variants that normalise to the canonical name', async () => {
    const approved = canonItem({ id: 'a1', name: 'onion', needs_approval: false });
    const { run, store } = makePipeline({ items: [approved] });
    await run('onions');
    const stored = (store as ReturnType<typeof makeStore>).items.find((i) => i.id === 'a1');
    expect(stored?.synonyms).toHaveLength(0);
    expect(stored?.needs_approval).toBe(false);
  });

  it('does not upsert when the synonym is already present (deduped)', async () => {
    const apple = canonItem({ id: 'a1', name: 'apple', synonyms: ['apple'] });
    const { run, store } = makePipeline({ items: [apple] });
    const upsertSpy = vi.spyOn(store as ReturnType<typeof makeStore>, 'upsert');
    await run('apple');
    // 'apple' already in synonyms → no upsert called (beyond any initial store setup)
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('appends the normalised input as a synonym on a stage-5 (embedding) match', async () => {
    const oil = canonItem({ id: 'o1', name: 'coconut oil', embedding: eX });
    const { run, store } = makePipeline({
      items: [oil],
      embedding: makeEmbedding(eX),
    });
    // 'coconut oil xyz' won't match stages 1–4; embedding will fire
    await run('coconut oil xyz');
    const stored = (store as ReturnType<typeof makeStore>).items.find((i) => i.id === 'o1');
    expect(stored?.synonyms).toContain('coconut oil xyz');
    expect(stored?.needs_approval).toBe(true);
  });
});

// ─── Concurrent creation ──────────────────────────────────────────────────────

describe('concurrent creation', () => {
  it('both calls complete without error when run in parallel', async () => {
    const store = makeStore();
    idCounter = 0;
    const ports = {
      store,
      aisleStore: makeAisleStore(),
      embedding: failEmbedding(),
      arbitration: noMatchArbitration(),
      ids: makeIds(),
      logging: null,
    };
    const [a, b] = await Promise.all([
      matchOrCreate({ rawName: 'Cilantro' }, ports),
      matchOrCreate({ rawName: 'Cilantro' }, ports),
    ]);
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
  });
});

// ─── Logging ─────────────────────────────────────────────────────────────────

describe('logging integration', () => {
  it('writes a log entry after a stage-1 match', async () => {
    const written: MatchLogEntry[] = [];
    const loggingPort: MatchLoggingPort = {
      write: async (e) => {
        written.push(e);
      },
    };
    const apple = canonItem({ id: 'a1', name: 'apple' });
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'apple' },
      {
        store: makeStore([apple]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    await Promise.resolve();
    expect(written).toHaveLength(1);
    expect(written[0]?.finalDecision).toBe('matched');
    expect(written[0]?.finalItemId).toBe('a1');
    expect(written[0]?.rawInput).toBe('apple');
  });

  it('writes a log entry with schemaVersion 2', async () => {
    const written: MatchLogEntry[] = [];
    const loggingPort: MatchLoggingPort = {
      write: async (e) => {
        written.push(e);
      },
    };
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'Basil' },
      {
        store: makeStore([]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    await Promise.resolve();
    expect(written[0]?.schemaVersion).toBe(2);
  });

  it('writes a log entry with finalDecision=created when creating a new item', async () => {
    const written: MatchLogEntry[] = [];
    const loggingPort: MatchLoggingPort = {
      write: async (e) => {
        written.push(e);
      },
    };
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'Basil' },
      {
        store: makeStore([]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    await Promise.resolve();
    expect(written[0]?.finalDecision).toBe('created');
  });

  it('records inputItemCount matching the catalog size at call time', async () => {
    const written: MatchLogEntry[] = [];
    const loggingPort: MatchLoggingPort = {
      write: async (e) => {
        written.push(e);
      },
    };
    const items = [canonItem({ id: 'a1', name: 'apple' }), canonItem({ id: 'b1', name: 'banana' })];
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'mango' },
      {
        store: makeStore(items),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    await Promise.resolve();
    expect(written[0]?.inputItemCount).toBe(2);
  });

  it('records totalDurationMs as a non-negative number', async () => {
    const written: MatchLogEntry[] = [];
    const loggingPort: MatchLoggingPort = {
      write: async (e) => {
        written.push(e);
      },
    };
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'Basil' },
      {
        store: makeStore([]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    await Promise.resolve();
    expect(written[0]?.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('records arbitration log when AI is called for aisle suggestion', async () => {
    const written: MatchLogEntry[] = [];
    const loggingPort: MatchLoggingPort = {
      write: async (e) => {
        written.push(e);
      },
    };
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'Garlic' },
      {
        store: makeStore([]),
        aisleStore: makeAisleStoreWithAisles(),
        embedding: failEmbedding(),
        arbitration: newArbitration('Garlic', 'produce'),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    await Promise.resolve();
    expect(written[0]?.arbitration).not.toBeNull();
    expect(written[0]?.arbitration?.reason).toBe('aisle_suggestion');
    expect(written[0]?.arbitration?.aislesIn).toBe(1);
    expect(written[0]?.arbitration?.candidatesIn).toBe(0);
    expect(written[0]?.arbitration?.outcome).toBe('new');
  });

  it('records null arbitration when no AI is called', async () => {
    const written: MatchLogEntry[] = [];
    const loggingPort: MatchLoggingPort = {
      write: async (e) => {
        written.push(e);
      },
    };
    const apple = canonItem({ id: 'a1', name: 'apple' });
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'apple' },
      {
        store: makeStore([apple]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    await Promise.resolve();
    expect(written[0]?.arbitration).toBeNull();
  });

  it('writes a log entry with finalDecision=matched for a single near-miss above aiThreshold', async () => {
    const written: MatchLogEntry[] = [];
    const loggingPort: MatchLoggingPort = {
      write: async (e) => {
        written.push(e);
      },
    };
    const item = canonItem({ id: 'x1', name: 'olive oil extra' });
    idCounter = 0;
    await matchOrCreate(
      { rawName: 'olive oil' },
      {
        store: makeStore([item]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    await Promise.resolve();
    expect(written[0]?.finalDecision).toBe('matched');
    expect(written[0]?.finalItemId).toBe('x1');
  });

  it('does not block the pipeline when the logging port throws', async () => {
    const loggingPort: MatchLoggingPort = {
      write: async () => {
        throw new Error('log write failed');
      },
    };
    idCounter = 0;
    const result = await matchOrCreate(
      { rawName: 'Basil' },
      {
        store: makeStore([]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    expect(result.kind).toBe('ok');
  });

  it('skips logging entirely when logging port is null', async () => {
    const writeSpy = vi.fn();
    idCounter = 0;
    const result = await matchOrCreate(
      { rawName: 'Basil' },
      {
        store: makeStore([]),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: null,
      },
    );
    expect(result.kind).toBe('ok');
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ─── Derived names are never recorded as synonyms ────────────────────────────
//
// A synonym asserts IDENTITY, a product form asserts DERIVATION. Production held
// both claims about one string: `lime zest` sat in Lime's synonym list alongside
// a product form saying zest is scraped FROM a lime. `isDerivedName` is how a
// caller holding the forms table refuses the second write.
//
// Exercised THROUGH matchOrCreate rather than only against appendCanonSynonym
// because there are seven routes to a match here and the guard is only worth
// anything if it covers all of them — the reason resolveMatch takes the whole
// ports bag rather than just the store.
//
// The fixture is the real case: "chicken stock" is a derivative, and it shares
// two of three tokens with each stock canon (0.67 — over aiThreshold, under
// stage2Stop, and tied), so it lands in arbitration. That is not incidental. A
// derivative rarely clears a deterministic stage against its own parent, so the
// AI-arbitrated route is precisely the one that binds it, and precisely the one
// that used to write the derivative's name back as a synonym.
describe('isDerivedName — a derivation never becomes a synonym', () => {
  const cube = canonItem({ id: 'c1', name: 'Chicken Stock Cube' });
  const powder = canonItem({ id: 'c2', name: 'Chicken Stock Powder' });

  const pipeline = (isDerivedName?: (rawName: string) => boolean) =>
    makePipeline({
      items: [cube, powder],
      arbitration: matchArbitration('c1', 'stock is made from a cube'),
      ...(isDerivedName !== undefined ? { isDerivedName } : {}),
    });

  it('binds the match but records no synonym, and writes nothing', async () => {
    const { run, store } = pipeline(() => true);

    const result = await run('chicken stock');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // The ingredient still resolves to the cube — refusing the synonym must
      // not cost the user their match, only the false claim about what it is.
      expect(result.value.item.id).toBe('c1');
      expect(result.value.decision).toBe('ai_arbitrated');
      expect(result.value.item.synonyms).toEqual([]);
    }
    // No write at all: the guard returns the item by reference, so
    // resolveMatch's `updated !== item` check skips the upsert entirely — and
    // the canon item is not dragged into the needs_approval queue for a change
    // that never happened.
    expect(store.items.find((i) => i.id === 'c1')!.synonyms).toEqual([]);
    expect(store.items.find((i) => i.id === 'c1')!.needs_approval).toBe(false);
  });

  it('still appends when the name is NOT a derivation', async () => {
    const { run } = pipeline(() => false);

    const result = await run('chicken stock');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.item.synonyms).toEqual(['chicken stock']);
  });

  it('omitting the port leaves the append exactly as it was', async () => {
    const { run } = pipeline();

    const result = await run('chicken stock');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.item.synonyms).toEqual(['chicken stock']);
  });
});

// ─── The AI names something the catalog already holds ────────────────────────
//
// Arbitration is asked to NAME the thing, and the clean name it returns is often
// one the catalog already has under a rawName that failed every deterministic
// stage. The empty-shortlist path has always guarded against that; the path WITH
// candidates did not, and a corpus re-match walked straight through it —
// "small red onion or a couple of shallots" and "warm water" each had near-miss
// candidates, so arbitration ran with a non-empty shortlist, answered "new", and
// minted a second "Red Onion" and a second "Water" beside the originals.
//
// Having candidates makes a duplicate MORE likely, not less: the near-misses are
// what prove the concept is already known.
describe('arbitration returning "new" for a name that already exists', () => {
  // Two candidates tied at 0.67 token overlap — over aiThreshold, under
  // stage2Stop, and more than one, so neither a deterministic stop nor stage 6's
  // single-near-miss shortcut can fire. That is what actually reaches the model.
  const shortlisted = (canonName: string) =>
    makePipeline({
      items: [
        canonItem({ id: 'o1', name: 'Red Onion' }),
        canonItem({ id: 'o2', name: 'Red Onion Soup' }),
      ],
      arbitration: newArbitration(canonName),
    });

  it('binds to the existing item instead of minting a duplicate', async () => {
    const { run, store } = shortlisted('Red Onion');

    const result = await run('red onion salad');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.item.id).toBe('o1');
      expect(result.value.decision).toBe('ai_arbitrated');
    }
    expect(store.items).toHaveLength(2);
  });

  it('still mints when the name really is new', async () => {
    const { run, store } = shortlisted('Banana Shallot');

    const result = await run('red onion salad');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.item.name).toBe('Banana Shallot');
    expect(store.items).toHaveLength(3);
  });
});

// ─── Candidate provenance: "which signals support this", not "which scored top" ─
//
// `stage` records the single top-scoring signal. Two policy sites read candidate
// provenance and they ask DIFFERENT questions (issue #937):
//
//   • the lone-candidate fast bind asks "is token overlap the STRONGEST support?"
//     — `stage === 2` is exactly right, and #248 narrowed it on purpose;
//   • the degraded AI-failure fallback asks "is edit distance the ONLY support?"
//     — for which `stage !== 4` is the wrong proxy, because a candidate that token
//     overlap also backs gets skipped whenever its Levenshtein score came out
//     higher.
//
// `supportedStages` answers the second question; `stage` keeps answering the
// first. The two must not be collapsed into one field — doing so would widen the
// fast bind into the behaviour #248 removed.

describe('degraded fallback reads supporting signals, not the top-scoring one', () => {
  // Regression A. "chick pea flour" vs "Chick Pea Flakes": token overlap 0.667,
  // Levenshtein 0.800 — both clear aiThreshold (0.60), and edit distance wins the
  // confidence, so the candidate used to be stamped stage 4 and skipped. Token
  // overlap genuinely supports it, so the AI-error fallback must bind it.
  it('falls back to a candidate that token overlap also supports', async () => {
    const flakes = canonItem({ id: 'cpf1', name: 'Chick Pea Flakes' });
    const { run, store } = makePipeline({
      items: [flakes],
      arbitration: {
        arbitrate: async () => ({
          kind: 'err',
          error: { kind: 'NetworkError', reason: 'transient' },
        }),
      },
    });

    const result = await run('chick pea flour');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.decision).toBe('ai_arbitrated');
      expect(result.value.item.id).toBe('cpf1');
    }
    // Bound to the existing item rather than minting a second one.
    expect(store.items).toHaveLength(1);
  });

  it('falls back for the "red wine vinegar" / "White Wine Vinegar" pair too', async () => {
    const white = canonItem({ id: 'wwv1', name: 'White Wine Vinegar' });
    const { run, store } = makePipeline({
      items: [white],
      arbitration: {
        arbitrate: async () => ({
          kind: 'err',
          error: { kind: 'NetworkError', reason: 'transient' },
        }),
      },
    });

    const result = await run('red wine vinegar');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.item.id).toBe('wwv1');
    expect(store.items).toHaveLength(1);
  });

  // Regression B. The narrowing still holds where it should: "olives" vs "limes"
  // is supported by edit distance and NOTHING else (token overlap 0), so the
  // fallback must still refuse it and create a new item.
  it('still creates a new item when edit distance is the only support', async () => {
    const limes = canonItem({ id: 'lime1', name: 'limes' });
    const { run, store } = makePipeline({
      items: [limes],
      arbitration: {
        arbitrate: async () => ({
          kind: 'err',
          error: { kind: 'NetworkError', reason: 'transient' },
        }),
      },
    });

    const result = await run('olives');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.item.id).not.toBe('lime1');
    expect(store.items).toHaveLength(2);
  });

  // Regression C. The lone-candidate fast bind has NOT widened. "chick pea flour"
  // is a single shortlist candidate that token overlap supports, but its top
  // signal is edit distance — it must still escalate to the AI rather than
  // binding silently, which is precisely what #248 removed.
  it('does not widen the lone-candidate fast bind to dual-supported candidates', async () => {
    const flakes = canonItem({ id: 'cpf1', name: 'Chick Pea Flakes' });
    const arbitrateSpy = vi.fn().mockResolvedValue({ kind: 'ok', value: { kind: 'no-match' } });
    const { run } = makePipeline({ items: [flakes], arbitration: { arbitrate: arbitrateSpy } });

    await run('chick pea flour');

    expect(arbitrateSpy).toHaveBeenCalledOnce();
  });

  // The counterpart the fast bind is FOR: "plain flour" vs "Plain Flour Strong"
  // scores token 0.667 / Levenshtein 0.611, so token overlap is the top signal and
  // this one correctly binds without an AI call. Kept beside the case above so a
  // future change cannot quietly move the boundary between them.
  it('still fast-binds when token overlap is the top signal', async () => {
    const strong = canonItem({ id: 'pfs1', name: 'Plain Flour Strong' });
    const arbitrateSpy = vi.fn().mockResolvedValue({ kind: 'ok', value: { kind: 'no-match' } });
    const { run } = makePipeline({ items: [strong], arbitration: { arbitrate: arbitrateSpy } });

    const result = await run('plain flour');

    expect(arbitrateSpy).not.toHaveBeenCalled();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.item.id).toBe('pfs1');
  });
});

// Regression E (issue #937, B1). `classifyOne` builds the `needs_ai` shortlist
// two ways: a stage1to4 'none' result goes through `buildShortlist`, which
// accumulates `supportedStages` across signals — the path the cases above
// exercise. A stage1to4 'ambiguous' result instead takes `stage1to4.candidates`
// straight from `findClosestMatch`, where `runScoredStage` stamps every
// candidate `supportedStages: [stage]` — for a stage-4 near-tie, `[4]`
// regardless of what token overlap says. That needs a ≥2-item catalog that
// reaches `kind: 'ambiguous'` at stage 4 — every case above uses a one-item
// catalog, which can only ever reach `kind: 'none'`, which is why none of them
// caught this.
//
// "Self Raising Flor" / "Self Rising Flour" vs input "self raising flour":
// both score token overlap 0.667 (over aiThreshold 0.60) and Levenshtein 0.944
// (over stage4Stop 0.85, gap 0.0 < ambiguityGap) — a genuine stage-4 ambiguous
// tie where token overlap ALSO supports both candidates.
describe('degraded fallback on an ambiguous stage-4 shortlist (#937 B1)', () => {
  it('falls back to an existing candidate instead of minting a third item', async () => {
    const flor = canonItem({ id: 'flor1', name: 'Self Raising Flor' });
    const flour = canonItem({ id: 'flour1', name: 'Self Rising Flour' });
    const { run, store } = makePipeline({
      items: [flor, flour],
      arbitration: {
        arbitrate: async () => ({
          kind: 'err',
          error: { kind: 'NetworkError', reason: 'transient' },
        }),
      },
    });

    const result = await run('self raising flour');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.decision).toBe('ai_arbitrated');
      expect([flor.id, flour.id]).toContain(result.value.item.id);
    }
    // Bound to one of the two existing items, not a third `needs_approval` one.
    expect(store.items).toHaveLength(2);
  });
});

// Regression D. `MatchLogBuilder.start` resets inputItemCount to 0, and the
// forceCreate branch used to return above the line that set it — so every forced
// creation reported a canon snapshot of 0 into `canon.match` and Cloud Logging.
describe('inputItemCount on the forced-creation path', () => {
  it('records the catalog size, not 0, when forceCreate is set', async () => {
    const written: MatchLogEntry[] = [];
    const loggingPort: MatchLoggingPort = {
      write: async (e) => {
        written.push(e);
      },
    };
    const items = [canonItem({ id: 'a1', name: 'apple' }), canonItem({ id: 'b1', name: 'banana' })];
    idCounter = 0;

    await matchOrCreate(
      { rawName: 'mango', forceCreate: true },
      {
        store: makeStore(items),
        aisleStore: makeAisleStore(),
        embedding: failEmbedding(),
        arbitration: noMatchArbitration(),
        ids: makeIds(),
        logging: loggingPort,
      },
    );
    await Promise.resolve();

    expect(written[0]?.finalDecision).toBe('created');
    expect(written[0]?.inputItemCount).toBe(2);
  });
});

describe('matchOrCreate — a counted item is minted with its weight of one (issue #1643)', () => {
  it('carries the arbitrated unit and weight of one onto the new item', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: {
        arbitrate: async () => ({
          kind: 'ok',
          value: {
            kind: 'new',
            canonName: 'Red Onion',
            aisleId: 'produce',
            shoppingBehavior: 'needed' as const,
            unit: 'count' as const,
            gramsPerItem: 150,
          },
        }),
      },
    });
    const result = await run('red onion xyz');
    expect(result.kind === 'ok' && result.value.item).toMatchObject({
      unit: 'count',
      gramsPerItem: 150,
    });
  });

  it('mints no weight of one when arbitration gives none', async () => {
    const { run } = makePipeline({
      aisleStore: makeAisleStoreWithAisles(),
      arbitration: newArbitration('Garlic', 'produce'),
    });
    const result = await run('garlic-xyz-unique');
    expect(result.kind === 'ok' && result.value.item).not.toHaveProperty('gramsPerItem');
  });
});
