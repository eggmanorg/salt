import { describe, expect, it } from 'vitest';

import { isEpicTitle, isLedger, ledgerRunSet, ledgerShouldAttachTo } from '../lib/boardTitles.mjs';

describe('isLedger', () => {
  it('matches a campaign ledger, which carries no board fields', () => {
    expect(isLedger('campaign: fold the side nav away (#1143)')).toBe(true);
  });

  // The whole point of the untriaged rule is to catch these, and they are the
  // issue an agent files most often. Exempting them defeats the change.
  it('does NOT match a campaign follow-ups issue, which is ordinary work', () => {
    expect(isLedger('campaign follow-ups: fold the side nav away (#1194)')).toBe(false);
  });

  it('only matches at the start, so an issue merely mentioning one is work', () => {
    expect(isLedger('fix: /salt-campaign: leaves the worktree behind')).toBe(false);
  });

  it('survives a title that is missing', () => {
    expect(isLedger(undefined)).toBe(false);
    expect(isLedger(null)).toBe(false);
  });
});

describe('isEpicTitle', () => {
  it('matches the live epics', () => {
    expect(isEpicTitle('epic: get recipes right — one authoring contract')).toBe(true);
    expect(isEpicTitle('epic: formulas, schedules and batches')).toBe(true);
  });

  // The regression this predicate replaced: both of these hold sub-issues and
  // both belong in a work band.
  it('does not match a work issue that happens to hold sub-issues', () => {
    expect(isEpicTitle('feat: the recipe phase timeline, the phase editor')).toBe(false);
    expect(isEpicTitle('feat: recipe timings as named phases')).toBe(false);
  });

  it('survives a title that is missing', () => {
    expect(isEpicTitle(undefined)).toBe(false);
  });
});

describe('ledgerRunSet', () => {
  it('reads the issues a campaign dispatched out of its title', () => {
    expect(ledgerRunSet('campaign: canon dedup + amber tokens (#968 #971 #993)')).toEqual([
      968, 971, 993,
    ]);
  });

  // #1009's live title. The `+` prefix is somebody's shorthand for "and this
  // one too", not a different kind of member.
  it('counts a `+#N` member like any other', () => {
    expect(ledgerRunSet('campaign: overnight next-5 sweep (#995 #1006 #1007 +#985)')).toEqual([
      995, 1006, 1007, 985,
    ]);
  });

  it('returns nothing for a title naming no issues, rather than guessing', () => {
    expect(ledgerRunSet('campaign: flake-fixes')).toEqual([]);
    expect(ledgerRunSet(undefined)).toEqual([]);
  });
});

describe('ledgerShouldAttachTo', () => {
  const parents = (pairs) => new Map(pairs);

  it('returns the parent every run-set issue shares', () => {
    // Campaign #1266: #968, #971 and #993 all sit under epic #913.
    expect(
      ledgerShouldAttachTo(
        [968, 971, 993],
        parents([
          [968, 913],
          [971, 913],
          [993, 913],
        ]),
      ),
    ).toBe(913);
  });

  // Campaign #1204 on the live board: #1202 is under #1122 and #1203 under
  // #1129. Forcing a parent here would invent a relationship the work does not
  // have, so the ledger stays a root and the check must not complain.
  it('returns null for a mixed run-set, which is a pass and not a miss', () => {
    expect(
      ledgerShouldAttachTo(
        [1202, 1203],
        parents([
          [1202, 1122],
          [1203, 1129],
        ]),
      ),
    ).toBeNull();
  });

  it('returns null when the run-set issues are themselves unparented', () => {
    expect(
      ledgerShouldAttachTo(
        [987, 989],
        parents([
          [987, null],
          [989, null],
        ]),
      ),
    ).toBeNull();
  });

  // An unparsable title reaches here as an empty run-set. Treating that as
  // "attach to nothing" is the only safe direction: the alternative is a check
  // that goes red on a ledger nobody can act on.
  it('returns null for an empty run-set', () => {
    expect(ledgerShouldAttachTo([], parents([]))).toBeNull();
  });

  // A run-set member absent from the map counts as unparented, so one issue the
  // query could not resolve cannot manufacture a shared parent out of the rest.
  it('treats a run-set issue missing from the map as unparented', () => {
    expect(ledgerShouldAttachTo([968, 4242], parents([[968, 913]]))).toBeNull();
  });

  it('is unmoved by order', () => {
    expect(
      ledgerShouldAttachTo(
        [993, 968],
        parents([
          [968, 913],
          [993, 913],
        ]),
      ),
    ).toBe(913);
  });
});
