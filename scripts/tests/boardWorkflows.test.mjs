import { describe, expect, it } from 'vitest';

import { disabledWorkflowFailures } from '../lib/boardWorkflows.mjs';

/** The live board's seven built-ins, as read back over GraphQL. */
const live = (over = {}) =>
  [
    ['Auto-add sub-issues to project', true],
    ['Auto-add to project', true],
    ['Auto-close issue', false],
    ['Item added to project', true],
    ['Item closed', false],
    ['Pull request linked to issue', false],
    ['Pull request merged', false],
  ].map(([name, enabled]) => ({ name, enabled: over[name] ?? enabled }));

describe('disabledWorkflowFailures', () => {
  it('passes the board as it actually stands', () => {
    expect(disabledWorkflowFailures(live())).toEqual([]);
  });

  // Cause C, exactly as it was found: the rung the pipeline table credits with
  // setting Triage was switched off, and four issues sat at unset for their
  // whole life while two documents said otherwise.
  it('fails when the Triage rung is switched off', () => {
    const [failure, ...rest] = disabledWorkflowFailures(live({ 'Item added to project': false }));
    expect(rest).toEqual([]);
    expect(failure).toContain('"Item added to project" workflow is disabled');
    expect(failure).toContain('new issues land with no Status');
    expect(failure).toContain('UI setting');
  });

  it('fails when sub-issue auto-add is switched off', () => {
    const [failure] = disabledWorkflowFailures(live({ 'Auto-add sub-issues to project': false }));
    expect(failure).toContain('"Auto-add sub-issues to project" workflow is disabled');
  });

  // THE BOUNDARY, both ways. Only what a doc claims is pinned — the other five
  // are deliberately off and must stay passable — and a workflow that vanishes
  // from the list fails rather than passing by absence, because a rename is
  // indistinguishable from a switch-off and means the same thing.
  it('says nothing about the built-ins that are deliberately off', () => {
    expect(disabledWorkflowFailures(live())).toEqual([]);
    expect(disabledWorkflowFailures(live({ 'Auto-close issue': true }))).toEqual([]);
  });

  it('fails a required workflow that is missing from the list entirely', () => {
    const withoutIt = live().filter((w) => w.name !== 'Item added to project');
    const [failure] = disabledWorkflowFailures(withoutIt);
    expect(failure).toContain('"Item added to project" workflow is missing');
  });

  // A query that came back empty must not read as a healthy board.
  it('fails both when the list is empty or absent', () => {
    expect(disabledWorkflowFailures([])).toHaveLength(2);
    expect(disabledWorkflowFailures(undefined)).toHaveLength(2);
  });
});
