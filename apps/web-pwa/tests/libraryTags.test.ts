import { describe, it, expect } from 'vitest';
import { parseTagLine } from '../src/routes/library/libraryTags.js';

// The one rule on the library page (epic #1372, Phase 1): a comma-separated line
// in, the stored tag list out.

describe('parseTagLine', () => {
  it('splits on commas and trims', () => {
    expect(parseTagLine(' Fermentation , Sous vide ')).toEqual(['Fermentation', 'Sous vide']);
  });

  it('drops empties, so a trailing comma is not a blank tag', () => {
    expect(parseTagLine('Fermentation, ,')).toEqual(['Fermentation']);
    expect(parseTagLine('')).toEqual([]);
    expect(parseTagLine('   ')).toEqual([]);
  });

  // Two chips reading the same word is the thing this prevents; rewriting what
  // somebody typed is the thing it must not do.
  it('collapses duplicates case-insensitively and keeps the first spelling', () => {
    expect(parseTagLine('Fermentation, fermentation, FERMENTATION')).toEqual(['Fermentation']);
  });

  it('keeps tags that merely share a prefix', () => {
    expect(parseTagLine('Sous vide, Sous vide chuck')).toEqual(['Sous vide', 'Sous vide chuck']);
  });
});
