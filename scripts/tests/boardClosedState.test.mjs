import { describe, expect, it } from 'vitest';

import { closedItemVerdict } from '../lib/boardClosedState.mjs';

/** A closed board item, with only the fields the rule reads. */
const item = (over) => ({ number: 1, title: 'fix: something', status: null, ...over });

describe('closedItemVerdict', () => {
  // The behaviour `board.mjs release` depends on: a shipped issue STAYS on the
  // board, and the rule must say nothing about it.
  it('says nothing about an issue at Merged', () => {
    expect(closedItemVerdict(item({ status: 'Merged' })).level).toBe('ok');
  });

  it('notes a Released issue as safe to remove, and does not fail', () => {
    const v = closedItemVerdict(item({ number: 1178, status: 'Released' }));
    expect(v.level).toBe('note');
    expect(v.message).toContain('#1178 is Released — safe to remove from the board');
  });

  // The rule's original and still-primary job: work that shipped without the
  // `Closes #N` that moves it, or that was closed without shipping at all.
  it('fails an ordinary issue that never reached Merged', () => {
    const v = closedItemVerdict(item({ number: 999, status: null }));
    expect(v.level).toBe('failure');
    expect(v.message).toContain('Status="unset"');
    expect(v.message).toContain('its PR had no "Closes #999"');
  });

  it('fails an ordinary issue stuck part-way down the pipeline', () => {
    expect(closedItemVerdict(item({ status: 'In review' })).level).toBe('failure');
  });

  // A ledger is IN the rule — that is the 2026-09-12 correction, and the reason
  // it must not be swept up by `isHandClosed`.
  it('fails a closed ledger, and tells you to set it from its run-set', () => {
    const v = closedItemVerdict(item({ number: 1266, title: 'campaign: sweep (#968 #971)' }));
    expect(v.level).toBe('failure');
    expect(v.message).toContain('closed campaign ledger');
    expect(v.message).toContain('board.mjs set 1266 --status Merged');
  });

  // The three hand-closed kinds: a note, so `check`'s exit code keeps meaning
  // "a mechanism is broken" rather than "somebody could tidy the board".
  it.each([
    ['an epic', 'epic: act on the architecture review'],
    ['a campaign follow-ups checklist', 'campaign follow-ups: fold the side nav away (#1194)'],
    ['a question', 'question(chat): should a chat go read-only'],
  ])('notes %s rather than failing it', (_kind, title) => {
    const v = closedItemVerdict(item({ number: 1196, title, status: 'Triage' }));
    expect(v.level).toBe('note');
    expect(v.message).toContain('closes by hand and has no PR');
    expect(v.message).toContain('Status="Triage"');
  });

  // A hand-closed kind that DID reach Merged is silent like anything else — the
  // exemption is from the failure, not from the pipeline.
  it('says nothing about a hand-closed kind that reached Merged', () => {
    expect(
      closedItemVerdict(item({ title: 'campaign follow-ups: x (#1)', status: 'Merged' })).level,
    ).toBe('ok');
  });
});
