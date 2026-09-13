import { describe, expect, it } from 'vitest';

import { absentTargetVerdict, closedItemVerdict } from '../lib/boardClosedState.mjs';

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

  // Cause B. The old message told you a PR was missing its `Closes #N` when
  // there was never going to be a PR — #1086 and #1191 both read like that.
  it('notes a not-planned close instead of demanding it reached Merged', () => {
    const v = closedItemVerdict(item({ number: 1086, stateReason: 'NOT_PLANNED' }));
    expect(v.level).toBe('note');
    expect(v.message).toContain('closed as not planned');
    expect(v.message).toContain('take it off the board');
    expect(v.message).not.toContain('Closes #');
  });

  // An abandoned campaign never shipped, so the ledger advice — set it from its
  // run-set — would be a lie. The not-planned branch wins, deliberately.
  it('notes a ledger abandoned as not planned rather than telling it to ship', () => {
    const v = closedItemVerdict(
      item({ number: 1266, title: 'campaign: abandoned (#1 #2)', stateReason: 'NOT_PLANNED' }),
    );
    expect(v.level).toBe('note');
    expect(v.message).toContain('closed as not planned');
  });

  // The boundary, asserted: it reads GitHub's field and nothing else, so work
  // abandoned under "Close as completed" still fails. Fail-visible, not exempt.
  it('still fails work abandoned but closed as COMPLETED', () => {
    expect(closedItemVerdict(item({ stateReason: 'COMPLETED' })).level).toBe('failure');
    expect(closedItemVerdict(item({ stateReason: null })).level).toBe('failure');
  });

  // Shipping wins over the reason. An issue that reached Merged stays silent
  // whatever its close was labelled, because `release` still walks that set.
  it('says nothing about a Merged issue whatever its stateReason says', () => {
    expect(closedItemVerdict(item({ status: 'Merged', stateReason: 'NOT_PLANNED' })).level).toBe(
      'ok',
    );
  });

  // Cause D, with #1123's real timestamps. Its PR merged 2026-08-30; a parent
  // link auto-added its board item on 2026-09-12, 13 days later.
  it('notes an item auto-added after its issue had already closed', () => {
    const v = closedItemVerdict(
      item({
        number: 1123,
        closedAt: '2026-08-30T15:52:22Z',
        createdAt: '2026-09-12T14:41:34Z',
      }),
    );
    expect(v.level).toBe('note');
    expect(v.message).toContain('added to the board after it had already closed');
    expect(v.message).toContain('a parent link auto-added it');
  });

  // It outranks every other exemption, because it is the only correct
  // explanation for how the item got there — #1191 is NOT_PLANNED as well.
  it('puts the auto-added explanation ahead of not-planned and the ledger', () => {
    const base = { closedAt: '2026-09-05T16:25:04Z', createdAt: '2026-09-12T14:41:37Z' };
    expect(closedItemVerdict(item({ ...base, stateReason: 'NOT_PLANNED' })).message).toContain(
      'added to the board after',
    );
    expect(closedItemVerdict(item({ ...base, title: 'campaign: x (#1)' })).message).toContain(
      'added to the board after',
    );
  });

  // THE BOUNDARY. An item that predates the close went through the pipeline and
  // is still in the rule; equality is ambiguous and falls toward firing.
  it('does not exempt an item that predates, or exactly matches, the close', () => {
    expect(
      closedItemVerdict(
        item({ createdAt: '2026-08-29T14:29:57Z', closedAt: '2026-09-11T06:27:51Z' }),
      ).level,
    ).toBe('failure');
    const same = '2026-09-11T06:27:51Z';
    expect(closedItemVerdict(item({ createdAt: same, closedAt: same })).level).toBe('failure');
  });

  it('does not exempt an item with a timestamp missing on either side', () => {
    expect(
      closedItemVerdict(item({ createdAt: '2026-09-12T14:41:34Z', closedAt: null })).level,
    ).toBe('failure');
    expect(
      closedItemVerdict(item({ createdAt: null, closedAt: '2026-08-30T15:52:22Z' })).level,
    ).toBe('failure');
  });

  // A hand-closed kind that DID reach Merged is silent like anything else — the
  // exemption is from the failure, not from the pipeline.
  it('says nothing about a hand-closed kind that reached Merged', () => {
    expect(
      closedItemVerdict(item({ title: 'campaign follow-ups: x (#1)', status: 'Merged' })).level,
    ).toBe('ok');
  });
});

describe('absentTargetVerdict', () => {
  const pr = { prNumber: 1125, prCreatedAt: '2026-08-30T09:00:00Z' };

  // The case the old blanket skip got right: a PR body referencing work that
  // finished long ago. Nothing to move, and saying so is correct.
  it('notes a back-reference to an issue closed before the PR was raised', () => {
    const v = absentTargetVerdict({ ...pr, number: 900, closedAt: '2026-08-01T10:00:00Z' });
    expect(v.level).toBe('note');
    expect(v.message).toContain('closed before PR #1125 was raised');
  });

  // The hole. #1123 was closed BY PR #1125, so its closedAt is the merge — after
  // the PR was raised. Real work shipped and the board never heard of it, and
  // the job reported success.
  it('fails an issue this very PR is closing, which the board has never seen', () => {
    const v = absentTargetVerdict({ ...pr, number: 1123, closedAt: '2026-08-30T15:52:22Z' });
    expect(v.level).toBe('failure');
    expect(v.message).toContain('live and NOT on the board');
    expect(v.message).toContain('board.mjs add 1123 --queue');
  });

  it('fails an open issue, which is live work by definition', () => {
    expect(absentTargetVerdict({ ...pr, number: 1300, closedAt: null }).level).toBe('failure');
  });

  // Fails safe when the PR's own timestamp is unavailable: an unprovable
  // back-reference is reported rather than waved through.
  it('fails when the PR creation time is missing', () => {
    expect(
      absentTargetVerdict({
        number: 900,
        closedAt: '2026-08-01T10:00:00Z',
        prNumber: 1125,
        prCreatedAt: null,
      }).level,
    ).toBe('failure');
  });
});
