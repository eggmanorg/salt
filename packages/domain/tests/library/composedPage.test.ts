/**
 * The checks that decide whether the page writer's layout replaces the chef's
 * draft (issue #1663). The CF handler keeps the draft whenever these refuse, so
 * each refusal below is a page that would otherwise have been saved wrong.
 */
import { describe, it, expect } from 'vitest';
import { checkComposedPage, figuresIn, findLibraryBlocks, missingFigures } from '@salt/domain';

const fence = (info: string, body: string, f = '```') => `${f}${info}\n${body}\n${f}`;

describe('findLibraryBlocks', () => {
  it('finds every salt- fence in order, with its kind and source', () => {
    const body = [
      '# Page',
      fence('salt-callout', 'body: one'),
      'prose',
      fence('salt-stats', 'items: []'),
    ].join('\n\n');
    expect(findLibraryBlocks(body)).toEqual([
      { kind: 'callout', source: 'body: one' },
      { kind: 'stats', source: 'items: []' },
    ]);
  });

  it('ignores ordinary code fences, and a salt- fence quoted inside one', () => {
    const quoted = fence('markdown', fence('salt-callout', 'body: quoted'), '````');
    expect(findLibraryBlocks(`${fence('ts', 'const a = 1;')}\n\n${quoted}`)).toEqual([]);
  });

  it('does not open a backtick fence whose info string holds a backtick (CommonMark)', () => {
    // Not a fence at all — inline code — so the salt fence after it is the only block.
    expect(
      findLibraryBlocks('```salt-callout `x`\nnot a block\n\n```salt-stats\nitems: []\n```'),
    ).toEqual([{ kind: 'stats', source: 'items: []' }]);
  });

  it('reads tilde fences, and runs an unclosed fence to the end', () => {
    expect(findLibraryBlocks(fence('salt-callout', 'body: t', '~~~'))).toEqual([
      { kind: 'callout', source: 'body: t' },
    ]);
    expect(findLibraryBlocks('```salt-callout\nbody: open')).toEqual([
      { kind: 'callout', source: 'body: open' },
    ]);
  });
});

describe('missingFigures — a multiset, compared as written', () => {
  it('passes when every figure survives, in any order, and new ones are added', () => {
    expect(
      missingFigures('Duck: 130–140 °C, then 175, then 175.', '175 · 175 · 130–140 · 16 total'),
    ).toEqual([]);
  });

  it('reports a dropped figure', () => {
    expect(missingFigures('Render at 130, crisp at 175.', 'Render at 130.')).toEqual(['175']);
  });

  it('reports a changed figure', () => {
    expect(missingFigures('6.3 L in all', '6.4 L in all')).toEqual(['6.3']);
  });

  it('counts repeats: twice in the draft needs twice in the layout', () => {
    expect(missingFigures('175 then 175', '175')).toEqual(['175']);
  });

  it('does not count ordered-list markers as figures', () => {
    expect(figuresIn('1. Heat to 190\n2. Drop to 150\n 10) Serve')).toEqual(['190', '150']);
    expect(missingFigures('1. Heat to 190\n2. Drop to 150', 'Heat to 190, drop to 150')).toEqual(
      [],
    );
  });

  it('finds no figures in text without numbers, and misses one the layout dropped', () => {
    expect(figuresIn('Season to taste.')).toEqual([]);
    expect(missingFigures('Rest for 10 minutes', 'Rest until relaxed')).toEqual(['10']);
  });
});

describe('checkComposedPage', () => {
  const draft = 'Poached eggs: 90–95 °C. Use Probe Control.';
  const good = `Poached eggs at 90–95 °C.\n\n${fence('salt-callout', 'tone: warning\nlabel: Probe Control\nbody: Use it for poaching.')}`;

  it('accepts a layout that keeps every figure and whose blocks parse', () => {
    expect(checkComposedPage(draft, good, 10_000)).toEqual({ ok: true });
  });

  it('refuses a blank layout', () => {
    expect(checkComposedPage(draft, '  \n', 10_000)).toEqual({ ok: false, reason: 'blank' });
  });

  it('refuses a layout over the length limit', () => {
    expect(checkComposedPage(draft, good, 20)).toEqual({ ok: false, reason: 'too long' });
  });

  it('refuses a layout with a block that does not parse', () => {
    const bad = `90–95\n\n${fence('salt-callout', 'tone: "#f00"\nbody: x')}`;
    const result = checkComposedPage(draft, bad, 10_000);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/^salt-callout:/);
  });

  it('refuses a layout with an unknown block kind', () => {
    const bad = `90–95\n\n${fence('salt-pie', 'x: 1')}`;
    expect(checkComposedPage(draft, bad, 10_000).ok).toBe(false);
  });

  it('refuses a broken block nested where the top-level scan cannot check it', () => {
    // An unquoted colon in YAML — the renderer would draw "couldn't be read".
    const broken = 'body: Rest: 10 min';
    const inList = `90–95\n\n- ${fence('salt-callout', broken).replace(/\n/g, '\n  ')}`;
    const inQuote = `90–95\n\n> ${fence('salt-callout', broken).replace(/\n/g, '\n> ')}`;
    for (const bad of [inList, inQuote]) {
      expect(checkComposedPage(draft, bad, 10_000)).toEqual({
        ok: false,
        reason: 'salt- block not at top level',
      });
    }
  });

  it('refuses a salt- fence quoted inside an ordinary code block — it errs towards the draft', () => {
    const quoted = `90–95\n\n${fence('markdown', fence('salt-callout', 'body: x'), '````')}`;
    expect(checkComposedPage(draft, quoted, 10_000).ok).toBe(false);
  });

  it('passes a figure moved to another item — the boundary missingFigures states', () => {
    expect(
      checkComposedPage(
        'Duck 175, steak 200, freeze at -18.',
        'Duck 200, steak 175, freeze at 18.',
        10_000,
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a layout that lost a figure', () => {
    expect(checkComposedPage(draft, 'Poached eggs at 90 °C.', 10_000)).toEqual({
      ok: false,
      reason: 'figures lost: 95',
    });
  });
});
