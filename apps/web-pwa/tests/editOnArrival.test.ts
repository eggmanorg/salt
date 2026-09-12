import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearEditOnArrival,
  requestEditOnArrival,
  takeEditOnArrival,
} from '../src/routes/recipes/editOnArrival.js';

// The one-shot channel the New sheet uses to say "open this entry in edit mode"
// (issue #1319 Phase 6). Three properties, and they are the whole module: it is
// consumed once, it is matched by id, and an unasked-for page reads false.

beforeEach(() => {
  clearEditOnArrival();
});

describe('editOnArrival', () => {
  it('reads false when nothing was requested', () => {
    expect(takeEditOnArrival('recipe-1')).toBe(false);
  });

  it('reads true for the requested recipe', () => {
    requestEditOnArrival('recipe-1');

    expect(takeEditOnArrival('recipe-1')).toBe(true);
  });

  it('is consumed once — a second arrival on the same page reads false', () => {
    requestEditOnArrival('recipe-1');

    expect(takeEditOnArrival('recipe-1')).toBe(true);
    expect(takeEditOnArrival('recipe-1')).toBe(false);
  });

  it('leaves a request alone for a different recipe, and still honours it afterwards', () => {
    requestEditOnArrival('recipe-1');

    // A diverted navigation must not open edit mode on whatever mounts next...
    expect(takeEditOnArrival('recipe-2')).toBe(false);
    // ...and must not have eaten the request either.
    expect(takeEditOnArrival('recipe-1')).toBe(true);
  });

  it('keeps only the latest request', () => {
    requestEditOnArrival('recipe-1');
    requestEditOnArrival('recipe-2');

    expect(takeEditOnArrival('recipe-1')).toBe(false);
    expect(takeEditOnArrival('recipe-2')).toBe(true);
  });
});
