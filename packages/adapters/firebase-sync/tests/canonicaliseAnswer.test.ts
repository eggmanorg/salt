import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `callCanonicaliseRecipeIngredients` reads the function's answer by arm (issue
// #1601). Naming a recipe asks for `{ results, persistence }`; a function deployed
// before #1601 ignores that and answers the bare array, which is read as "did not
// say" rather than handed on as a shape the caller's type does not describe. A
// content-only call keeps its bare array untouched.

const callableMock = vi.fn();
const httpsCallable = vi.fn(() => callableMock);
const getFunctions = vi.fn(() => ({}));

vi.mock('firebase/functions', () => ({ getFunctions, httpsCallable }));

const { callCanonicaliseRecipeIngredients } = await import('../src/canonMatching.js');

const ITEMS = [{ rawName: 'flour', ingredientId: 'i1' }];
const RESULTS = [{ kind: 'ok', value: { decision: 'matched', item: { id: 'c1' } } }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callCanonicaliseRecipeIngredients — reading the answer', () => {
  it('hands on the envelope when a recipe is named', async () => {
    callableMock.mockResolvedValue({ data: { results: RESULTS, persistence: 'failed' } });

    const answer = await callCanonicaliseRecipeIngredients({ recipeId: 'r1', items: ITEMS });

    expect(answer).toEqual({ kind: 'ok', value: { results: RESULTS, persistence: 'failed' } });
  });

  it('reads an older function’s bare array, on the recipe arm, as "did not say"', async () => {
    callableMock.mockResolvedValue({ data: RESULTS });

    const answer = await callCanonicaliseRecipeIngredients({ recipeId: 'r1', items: ITEMS });

    expect(answer).toEqual({ kind: 'ok', value: { results: RESULTS, persistence: null } });
  });

  it('leaves the content arm’s bare array untouched', async () => {
    callableMock.mockResolvedValue({ data: RESULTS });

    const answer = await callCanonicaliseRecipeIngredients({ items: [{ rawName: 'flour' }] });

    expect(answer).toEqual({ kind: 'ok', value: RESULTS });
  });
});
