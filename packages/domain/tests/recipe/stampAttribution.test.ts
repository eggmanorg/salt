import { describe, it, expect } from 'vitest';
import { stampAttribution } from '../../src/index.js';

// The ONE attribution rule (issue #845), in the domain since #1431 because it is
// applied on both sides of the callable boundary: `recipeService` stamps every
// in-place edit in the browser, and the `authorRecipe` flow stamps the recipe it
// writes for itself in Cloud Functions. These are the properties both depend on,
// pinned here rather than asserted twice in prose.

function recipe(over: Partial<{ createdBy: string; lastEditedBy: string }> = {}) {
  return { id: 'r1', title: 'Pilaf', createdBy: '', lastEditedBy: '', ...over };
}

describe('stampAttribution', () => {
  it('fills a blank createdBy and sets lastEditedBy', () => {
    expect(stampAttribution(recipe(), 'Daniel')).toEqual({
      id: 'r1',
      title: 'Pilaf',
      createdBy: 'Daniel',
      lastEditedBy: 'Daniel',
    });
  });

  it('never re-points an existing createdBy at a later editor', () => {
    // A recipe is added once and edited forever. This is the property that makes
    // "Added by" mean something a year later.
    const stamped = stampAttribution(recipe({ createdBy: 'Kate' }), 'Daniel');

    expect(stamped.createdBy).toBe('Kate');
    expect(stamped.lastEditedBy).toBe('Daniel');
  });

  it('leaves BOTH fields alone when there is no name', () => {
    // The roster has not loaded, the signed-in email is not on it, or a Cloud
    // Function was handed no name over the wire. A placeholder reads as a person,
    // and clobbering a real creator because a store had not settled is worse than
    // recording nothing.
    const input = recipe({ createdBy: 'Kate', lastEditedBy: 'Daniel' });

    expect(stampAttribution(input, '')).toEqual(input);
  });

  it('returns a copy, never mutating what it was handed', () => {
    const input = recipe();

    const stamped = stampAttribution(input, 'Daniel');

    expect(input.createdBy).toBe('');
    expect(stamped).not.toBe(input);
  });

  it('carries every other field through untouched', () => {
    expect(stampAttribution(recipe(), 'Daniel').title).toBe('Pilaf');
  });
});
