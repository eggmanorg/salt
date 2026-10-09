/**
 * `parseLibraryBlock` when the YAML parser throws something that is not an
 * `Error` (issue #1663). `yaml` throws `YAMLParseError` in practice, but a
 * `catch` binding is `unknown` and the household still sees the problem text on
 * the library page — so a non-Error throw must come back as a result with a
 * sentence, never escape. Its own file because `vi.mock` replaces the module for
 * the whole file.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('yaml', () => ({
  parse: () => {
    throw 'not an Error';
  },
}));

const { parseLibraryBlock } = await import('@salt/domain/schemas');

describe('parseLibraryBlock — a non-Error throw from the YAML parser', () => {
  it('is still a result with a problem to show, not a throw', () => {
    expect(parseLibraryBlock('callout', 'body: x')).toEqual({
      ok: false,
      problem: 'its lines could not be read ()',
    });
  });
});
