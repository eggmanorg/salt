import { describe, it, expect } from 'vitest';
import { MemberSchema } from '@salt/domain/schemas';
import {
  createMember,
  updateMember,
  normaliseMemberEmail,
  memberInitials,
  memberFirstName,
  sortMembers,
  isPerson,
  onlyPeople,
  type Member,
} from '@salt/domain';

const NOW = '2026-06-07T12:00:00.000Z';

function makeMember(overrides: Partial<Member> & { id: string }): Member {
  return {
    schemaVersion: 1,
    name: 'Test Person',
    email: overrides.id,
    admin: false,
    sortOrder: 0,
    icon: null,
    cookMode: 'standard',
    system: false,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('normaliseMemberEmail', () => {
  it('lowercases and trims', () => {
    expect(normaliseMemberEmail('  Daniel@Pendery.ORG ')).toBe('daniel@pendery.org');
  });

  it('is idempotent', () => {
    const once = normaliseMemberEmail('A@B.com');
    expect(normaliseMemberEmail(once)).toBe(once);
  });
});

describe('memberInitials', () => {
  it('returns two initials for a first + last name', () => {
    expect(memberInitials('Daniel Pendery')).toBe('DP');
  });

  it('uses first and last word for three+ word names', () => {
    expect(memberInitials('Mary Jane Watson')).toBe('MW');
  });

  it('returns first two letters for a single word', () => {
    expect(memberInitials('Cher')).toBe('CH');
  });

  it('falls back to ? for empty input', () => {
    expect(memberInitials('   ')).toBe('?');
  });

  it('uppercases lowercase names', () => {
    expect(memberInitials('alice smith')).toBe('AS');
  });
});

describe('memberFirstName', () => {
  it('returns the first word of a full name', () => {
    expect(memberFirstName('Daniel Pendery')).toBe('Daniel');
  });

  it('returns the whole name for a single word', () => {
    expect(memberFirstName('Cher')).toBe('Cher');
  });

  it('ignores surrounding and inner whitespace', () => {
    expect(memberFirstName('  Mary  Jane Watson ')).toBe('Mary');
  });

  it('returns empty string for empty input', () => {
    expect(memberFirstName('')).toBe('');
    expect(memberFirstName('   ')).toBe('');
  });

  // The cases below exist because this is load-bearing for cook-timer DELIVERY
  // (issue #680), not only for display: the result is lowercased into a
  // `<firstname>-` prefix and matched against Pushover device names, so anything
  // that leaks whitespace into it silently stops matching and drops the timer.
  it('treats tabs and newlines as whitespace', () => {
    expect(memberFirstName('\tDaniel\nPendery')).toBe('Daniel');
    expect(memberFirstName('\n\t ')).toBe('');
  });

  it('never yields a value carrying whitespace', () => {
    for (const name of ['Daniel Pendery', '  Mary  Jane Watson ', 'Cher', '']) {
      expect(memberFirstName(name)).not.toMatch(/\s/);
    }
  });

  it('keeps a hyphenated first name whole', () => {
    // `Mary-Jane` stays one word, so the device prefix is `mary-jane-` and
    // `mary-jane-phone` still resolves.
    expect(memberFirstName('Mary-Jane Watson')).toBe('Mary-Jane');
  });
});

describe('createMember', () => {
  it('uses the normalised email as both id and email', () => {
    const m = createMember({
      name: 'Daniel',
      email: '  Daniel@Pendery.ORG ',
      admin: true,
      sortOrder: 1,
      now: NOW,
    });
    expect(m.id).toBe('daniel@pendery.org');
    expect(m.email).toBe('daniel@pendery.org');
  });

  it('trims the name and defaults icon to null', () => {
    const m = createMember({
      name: '  Daniel  ',
      email: 'd@e.org',
      admin: false,
      sortOrder: 0,
      now: NOW,
    });
    expect(m.name).toBe('Daniel');
    expect(m.icon).toBeNull();
  });

  it('stamps schemaVersion 1 and updatedAt', () => {
    const m = createMember({ name: 'D', email: 'd@e.org', admin: false, sortOrder: 0, now: NOW });
    expect(m.schemaVersion).toBe(1);
    expect(m.updatedAt).toBe(NOW);
  });

  it('preserves the admin flag', () => {
    const m = createMember({ name: 'D', email: 'd@e.org', admin: true, sortOrder: 0, now: NOW });
    expect(m.admin).toBe(true);
  });
});

describe('updateMember', () => {
  const base = makeMember({ id: 'd@e.org', name: 'Old', admin: false, sortOrder: 0 });

  it('applies the patched fields and re-stamps updatedAt', () => {
    const next = updateMember(
      base,
      { name: 'New', admin: true, sortOrder: 3 },
      '2026-06-08T00:00:00.000Z',
    );
    expect(next.name).toBe('New');
    expect(next.admin).toBe(true);
    expect(next.sortOrder).toBe(3);
    expect(next.updatedAt).toBe('2026-06-08T00:00:00.000Z');
  });

  it('leaves unpatched fields unchanged', () => {
    const next = updateMember(base, { sortOrder: 9 }, NOW);
    expect(next.name).toBe('Old');
    expect(next.admin).toBe(false);
  });

  it('never changes the id or email (key is immutable)', () => {
    const next = updateMember(base, { name: 'New' }, NOW);
    expect(next.id).toBe('d@e.org');
    expect(next.email).toBe('d@e.org');
  });

  it('does not mutate the original', () => {
    updateMember(base, { name: 'Mutated' }, NOW);
    expect(base.name).toBe('Old');
  });

  it('trims a patched name', () => {
    const next = updateMember(base, { name: '  Spaced  ' }, NOW);
    expect(next.name).toBe('Spaced');
  });
});

describe('sortMembers', () => {
  it('orders by sortOrder ascending', () => {
    const members = [
      makeMember({ id: 'c@e.org', name: 'C', sortOrder: 2 }),
      makeMember({ id: 'a@e.org', name: 'A', sortOrder: 0 }),
      makeMember({ id: 'b@e.org', name: 'B', sortOrder: 1 }),
    ];
    expect(sortMembers(members).map((m) => m.name)).toEqual(['A', 'B', 'C']);
  });

  it('breaks ties by name', () => {
    const members = [
      makeMember({ id: 'z@e.org', name: 'Zara', sortOrder: 0 }),
      makeMember({ id: 'a@e.org', name: 'Alice', sortOrder: 0 }),
    ];
    expect(sortMembers(members).map((m) => m.name)).toEqual(['Alice', 'Zara']);
  });

  it('does not mutate the input array', () => {
    const members = [
      makeMember({ id: 'b@e.org', name: 'B', sortOrder: 1 }),
      makeMember({ id: 'a@e.org', name: 'A', sortOrder: 0 }),
    ];
    sortMembers(members);
    expect(members[0]!.name).toBe('B');
  });
});

// ─── The cook-mode preference (issue #776) ───────────────────────────────────
//
// A field on the member doc rather than a fourth owner-scoped collection: a
// member doc IS the per-person record, so this does not touch the family-shared
// rule. WHO may change it is a question for firestore.rules — proved in
// firebase-sync/tests/firestoreRules.emulator.test.ts, where the pinning that
// stops "edit my cooking preference" also meaning "make myself an admin" lives.

describe('cookMode', () => {
  it('BACK-COMPAT: a member doc written before the field reads as standard', () => {
    // Every member doc in production is in this state, so the default is what
    // decides that shipping this changes nothing for anyone until they choose.
    const parsed = MemberSchema.parse({
      id: 'a@e.org',
      schemaVersion: 1,
      name: 'A',
      email: 'a@e.org',
      admin: false,
      sortOrder: 0,
      updatedAt: NOW,
    });
    expect(parsed.cookMode).toBe('standard');
  });

  it('round-trips a stored preference', () => {
    const parsed = MemberSchema.parse({
      id: 'a@e.org',
      schemaVersion: 1,
      name: 'A',
      email: 'a@e.org',
      admin: false,
      sortOrder: 0,
      icon: null,
      cookMode: 'guided',
      updatedAt: NOW,
    });
    expect(parsed.cookMode).toBe('guided');
  });

  it('refuses a mode that is not one of the two', () => {
    // Mirrored in the rules, which constrain the same two values — the doc is
    // family-readable, so an unconstrained string here is a place to park
    // arbitrary data on someone else's screen.
    const result = MemberSchema.safeParse({
      id: 'a@e.org',
      schemaVersion: 1,
      name: 'A',
      email: 'a@e.org',
      admin: false,
      sortOrder: 0,
      icon: null,
      cookMode: 'anything',
      updatedAt: NOW,
    });
    expect(result.success).toBe(false);
  });

  it('starts a new member on standard, and the admin screen cannot choose', () => {
    // `createMember` takes no cookMode input on purpose: the admin adding someone
    // to the roster has no business deciding how they like to cook.
    const created = createMember({
      name: 'New',
      email: 'New@E.org',
      admin: false,
      sortOrder: 3,
      now: NOW,
    });
    expect(created.cookMode).toBe('standard');
  });

  it('is patched like any other field, and leaves the rest alone', () => {
    const before = makeMember({ id: 'a@e.org', name: 'A', admin: true, cookMode: 'standard' });
    const after = updateMember(before, { cookMode: 'guided' }, '2026-08-09T12:00:00.000Z');
    expect(after.cookMode).toBe('guided');
    // Nothing else moves — the command is a plain patch, and it is firestore.rules
    // that decides a self-update may carry only this one.
    expect(after.admin).toBe(true);
    expect(after.name).toBe('A');
    expect(after.email).toBe(before.email);
  });

  it('leaves the preference alone when a patch does not mention it', () => {
    const before = makeMember({ id: 'a@e.org', cookMode: 'guided' });
    const after = updateMember(before, { name: 'Renamed' }, '2026-08-09T12:00:00.000Z');
    expect(after.cookMode).toBe('guided');
  });
});

// ─── System accounts (issue #1300) ──────────────────────────────────────────

describe('system accounts', () => {
  it('reads a document with no `system` key back as an ordinary person', () => {
    // The back-compat claim the `.default(false)` exists for, and the reason
    // there is no migration: every member doc in production predates the field.
    const parsed = MemberSchema.safeParse({
      id: 'a@e.org',
      schemaVersion: 1,
      name: 'A',
      email: 'a@e.org',
      admin: false,
      sortOrder: 0,
      icon: null,
      cookMode: 'standard',
      updatedAt: NOW,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.system).toBe(false);
    expect(parsed.success && isPerson(parsed.data)).toBe(true);
  });

  it('rejects a non-boolean `system`', () => {
    const parsed = MemberSchema.safeParse({
      id: 'a@e.org',
      schemaVersion: 1,
      name: 'A',
      email: 'a@e.org',
      admin: false,
      sortOrder: 0,
      icon: null,
      cookMode: 'standard',
      system: 'yes',
      updatedAt: NOW,
    });
    expect(parsed.success).toBe(false);
  });

  it('isPerson is true for an ordinary member and false for a system account', () => {
    expect(isPerson(makeMember({ id: 'a@e.org' }))).toBe(true);
    expect(isPerson(makeMember({ id: 'fridge@e.org', system: true }))).toBe(false);
  });

  it('isPerson is independent of admin', () => {
    // The two flags answer different questions and the form must not couple them:
    // an admin can be a system account, and a system account can be an admin.
    expect(isPerson(makeMember({ id: 'a@e.org', admin: true }))).toBe(true);
    expect(isPerson(makeMember({ id: 'b@e.org', admin: true, system: true }))).toBe(false);
  });

  it('onlyPeople drops system accounts and keeps the incoming order', () => {
    const roster = [
      makeMember({ id: 'a@e.org', name: 'Ann' }),
      makeMember({ id: 'fridge@e.org', name: 'Fridge', system: true }),
      makeMember({ id: 'b@e.org', name: 'Bob' }),
    ];
    expect(onlyPeople(roster).map((m) => m.name)).toEqual(['Ann', 'Bob']);
  });

  it('onlyPeople does not mutate its input', () => {
    const roster = [makeMember({ id: 'fridge@e.org', system: true })];
    onlyPeople(roster);
    expect(roster).toHaveLength(1);
  });

  it('createMember makes a person unless asked otherwise', () => {
    const person = createMember({
      name: 'New',
      email: 'new@e.org',
      admin: false,
      sortOrder: 3,
      now: NOW,
    });
    expect(person.system).toBe(false);
    const fridge = createMember({
      name: 'Fridge',
      email: 'fridge@e.org',
      admin: false,
      system: true,
      sortOrder: 4,
      now: NOW,
    });
    expect(fridge.system).toBe(true);
  });

  it('updateMember patches the flag and leaves it alone when unmentioned', () => {
    const before = makeMember({ id: 'fridge@e.org', name: 'Fridge', system: true });
    expect(updateMember(before, { system: false }, NOW).system).toBe(false);
    expect(updateMember(before, { name: 'Kitchen' }, NOW).system).toBe(true);
  });
});
