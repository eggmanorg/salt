import { describe, it, expect } from 'vitest';
import {
  WEEKDAYS,
  weekStartFor,
  weekDates,
  weekdayOf,
  dayIndexInWeek,
  weekExtendsIntoNext,
  WEEK_EXTENSION_DAYS,
  templateWeekStarts,
  emptyDay,
  emptyWeek,
  emptyTemplate,
  instantiateWeek,
  setDayNote,
  setDayChefs,
  setDayRecipes,
  setDayGuests,
  addAttendee,
  removeAttendee,
  setAttendeeHomeTime,
  setAttendeeNote,
  type Attendee,
  type MealPlanConfig,
  type MealPlanTemplate,
  type Weekday,
} from '@salt/domain';
import { TEMPLATE_WEEK_OFFERS } from '../../src/mealPlan/index.js';

const config = (firstDayOfWeek: Weekday): MealPlanConfig => ({
  firstDayOfWeek,
  schemaVersion: 1,
});

describe('weekdayOf', () => {
  it('maps known dates to their weekday', () => {
    // 2026-06-08 is a Monday; the following six days walk the week.
    expect(weekdayOf('2026-06-08')).toBe('mon');
    expect(weekdayOf('2026-06-09')).toBe('tue');
    expect(weekdayOf('2026-06-13')).toBe('sat');
    expect(weekdayOf('2026-06-14')).toBe('sun');
  });
});

describe('weekStartFor', () => {
  // 2026-06-10 is a Wednesday.
  it('finds the Monday-start of a midweek date', () => {
    expect(weekStartFor('2026-06-10', 'mon')).toBe('2026-06-08');
  });

  it('returns the date itself when it is already the start day', () => {
    expect(weekStartFor('2026-06-08', 'mon')).toBe('2026-06-08');
  });

  it('handles every firstDayOfWeek for the same Wednesday', () => {
    // Wed 2026-06-10. The start is the most recent occurrence of firstDayOfWeek.
    expect(weekStartFor('2026-06-10', 'mon')).toBe('2026-06-08');
    expect(weekStartFor('2026-06-10', 'tue')).toBe('2026-06-09');
    expect(weekStartFor('2026-06-10', 'wed')).toBe('2026-06-10');
    expect(weekStartFor('2026-06-10', 'thu')).toBe('2026-06-04');
    expect(weekStartFor('2026-06-10', 'fri')).toBe('2026-06-05');
    expect(weekStartFor('2026-06-10', 'sat')).toBe('2026-06-06');
    expect(weekStartFor('2026-06-10', 'sun')).toBe('2026-06-07');
  });

  it('crosses a month boundary correctly', () => {
    // Wed 2026-07-01 with a Friday start day → previous Friday is 2026-06-26.
    expect(weekStartFor('2026-07-01', 'fri')).toBe('2026-06-26');
  });

  it('accepts a Date and uses its local calendar day', () => {
    const d = new Date(2026, 5, 10); // local Wed 2026-06-10
    expect(weekStartFor(d, 'mon')).toBe('2026-06-08');
  });
});

describe('weekDates', () => {
  it('returns seven consecutive dates from the start', () => {
    expect(weekDates('2026-06-08')).toEqual([
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
    ]);
  });
});

describe('dayIndexInWeek', () => {
  it('gives the 0-based position of a date inside the week', () => {
    expect(dayIndexInWeek('2026-06-08', '2026-06-08')).toBe(0);
    expect(dayIndexInWeek('2026-06-08', '2026-06-11')).toBe(3);
    expect(dayIndexInWeek('2026-06-08', '2026-06-14')).toBe(6);
  });

  it('returns -1 for a date outside the week on either side', () => {
    expect(dayIndexInWeek('2026-06-08', '2026-06-07')).toBe(-1);
    expect(dayIndexInWeek('2026-06-08', '2026-06-15')).toBe(-1);
    expect(dayIndexInWeek('2026-06-08', '2025-06-11')).toBe(-1);
  });

  it('returns -1 rather than NaN for an unparseable date', () => {
    expect(dayIndexInWeek('2026-06-08', 'not-a-date')).toBe(-1);
    expect(dayIndexInWeek('', '2026-06-08')).toBe(-1);
  });

  it('agrees with weekDates on every day of the week', () => {
    const start = '2026-06-08';
    weekDates(start).forEach((date, i) => {
      expect(dayIndexInWeek(start, date)).toBe(i);
    });
  });

  it('is unaffected by the DST boundary inside the week (all week maths is UTC)', () => {
    // BST ends on 2026-10-25; the week straddling it must still be seven days.
    expect(dayIndexInWeek('2026-10-19', '2026-10-25')).toBe(6);
    expect(dayIndexInWeek('2026-10-19', '2026-10-26')).toBe(-1);
  });
});

describe('weekExtendsIntoNext (#639)', () => {
  // Production runs a Friday-start week, which is what makes "from Tuesday" the
  // user-facing rule: Tuesday is index 4 of a fri→thu cycle.
  const FRI = '2026-07-24'; // a Friday
  const [fri, sat, sun, mon, tue, wed, thu] = weekDates(FRI) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  it('holds for the last three days of the cycle and no earlier', () => {
    expect(weekExtendsIntoNext(FRI, fri, 'fri')).toBe(false);
    expect(weekExtendsIntoNext(FRI, sat, 'fri')).toBe(false);
    expect(weekExtendsIntoNext(FRI, sun, 'fri')).toBe(false);
    expect(weekExtendsIntoNext(FRI, mon, 'fri')).toBe(false);
    // Tuesday, Wednesday and Thursday — the days you plan and shop for the week
    // ahead.
    expect(weekExtendsIntoNext(FRI, tue, 'fri')).toBe(true);
    expect(weekExtendsIntoNext(FRI, wed, 'fri')).toBe(true);
    expect(weekExtendsIntoNext(FRI, thu, 'fri')).toBe(true);
  });

  it('is the last three days of the CYCLE, not the literal weekday Tuesday', () => {
    // Same calendar Tuesday, a Monday-start household: it is now index 1, six
    // days from the end, so nothing is appended. Move firstDayOfWeek and the
    // trigger moves with it.
    const monStart = weekStartFor(tue, 'mon');
    expect(weekExtendsIntoNext(monStart, tue, 'mon')).toBe(false);
    // Its own last three days (Friday, Saturday, Sunday) are the trigger instead.
    expect(weekExtendsIntoNext(monStart, weekDates(monStart)[4]!, 'mon')).toBe(true);
    expect(weekExtendsIntoNext(monStart, weekDates(monStart)[5]!, 'mon')).toBe(true);
    expect(weekExtendsIntoNext(monStart, weekDates(monStart)[6]!, 'mon')).toBe(true);
  });

  it('never extends a week that is not the one today falls in', () => {
    // The week AFTER today's, viewed on a Wednesday — the extension belongs to
    // today's week only, so navigating forward shows that week alone.
    expect(weekExtendsIntoNext('2026-07-31', wed, 'fri')).toBe(false);
    expect(weekExtendsIntoNext('2026-07-17', wed, 'fri')).toBe(false);
    expect(weekExtendsIntoNext('2026-01-02', wed, 'fri')).toBe(false);
  });

  it('rejects a startDate that is not a week start under firstDayOfWeek', () => {
    // Mid-week anchors are not cycles; "contains today" is asked of the cycle.
    expect(weekExtendsIntoNext(sun, wed, 'fri')).toBe(false);
    expect(weekExtendsIntoNext('', wed, 'fri')).toBe(false);
  });

  it('extends across a month and a year boundary like any other week', () => {
    // 2026-12-25 is a Friday; its cycle's last three days are 29, 30 and 31
    // December.
    expect(weekExtendsIntoNext('2026-12-25', '2026-12-29', 'fri')).toBe(true);
    expect(weekExtendsIntoNext('2026-12-25', '2026-12-30', 'fri')).toBe(true);
    expect(weekExtendsIntoNext('2026-12-25', '2026-12-31', 'fri')).toBe(true);
    expect(weekExtendsIntoNext('2026-12-25', '2026-12-28', 'fri')).toBe(false);
  });

  it('is unaffected by the DST boundary inside the week (all week maths is UTC)', () => {
    // BST ends on 2026-10-25, inside this mon→sun cycle.
    expect(weekExtendsIntoNext('2026-10-19', '2026-10-23', 'mon')).toBe(true);
    expect(weekExtendsIntoNext('2026-10-19', '2026-10-24', 'mon')).toBe(true);
    expect(weekExtendsIntoNext('2026-10-19', '2026-10-25', 'mon')).toBe(true);
    expect(weekExtendsIntoNext('2026-10-19', '2026-10-22', 'mon')).toBe(false);
  });

  it('WEEK_EXTENSION_DAYS is the three days the rule is stated in', () => {
    expect(WEEK_EXTENSION_DAYS).toBe(3);
  });
});

describe('templateWeekStarts (#639)', () => {
  it('offers this week, next week and the week after next', () => {
    // 2026-07-29 is a Wednesday inside the fri→thu cycle starting 2026-07-24.
    expect(templateWeekStarts('2026-07-29', 'fri')).toEqual([
      '2026-07-24',
      '2026-07-31',
      '2026-08-07',
    ]);
    expect(TEMPLATE_WEEK_OFFERS).toBe(3);
  });

  it('anchors on the cycle today falls in, so it follows firstDayOfWeek', () => {
    // Same day, a Monday-start household: a different first week, and the two
    // that follow move with it.
    expect(templateWeekStarts('2026-07-29', 'mon')).toEqual([
      '2026-07-27',
      '2026-08-03',
      '2026-08-10',
    ]);
  });

  it('always offers real week starts, seven days apart', () => {
    for (const first of WEEKDAYS) {
      const starts = templateWeekStarts('2026-07-29', first);
      expect(starts).toHaveLength(TEMPLATE_WEEK_OFFERS);
      for (const start of starts) {
        expect(weekStartFor(start, first)).toBe(start);
        expect(weekdayOf(start)).toBe(first);
      }
      expect(dayIndexInWeek(starts[0]!, '2026-07-29')).toBeGreaterThanOrEqual(0);
    }
  });

  it('crosses month and year boundaries like any other week arithmetic', () => {
    expect(templateWeekStarts('2026-12-28', 'mon')).toEqual([
      '2026-12-28',
      '2027-01-04',
      '2027-01-11',
    ]);
  });

  it('is unaffected by a DST boundary between the offered weeks', () => {
    // BST ends on 2026-10-25, between the first and second offered week.
    expect(templateWeekStarts('2026-10-19', 'mon')).toEqual([
      '2026-10-19',
      '2026-10-26',
      '2026-11-02',
    ]);
  });
});

describe('emptyDay / emptyWeek / emptyTemplate', () => {
  it('emptyDay is fully blank', () => {
    expect(emptyDay()).toEqual({ note: '', recipeIds: [], chefs: [], attendees: [], guests: 0 });
  });

  it('emptyTemplate has all seven weekdays blank', () => {
    const t = emptyTemplate();
    expect(Object.keys(t.days).sort()).toEqual([...WEEKDAYS].sort());
    for (const wd of WEEKDAYS) expect(t.days[wd]).toEqual(emptyDay());
  });

  it('emptyWeek is keyed by its seven dates with a blank updatedAt', () => {
    const w = emptyWeek('2026-06-08');
    expect(w.id).toBe('2026-06-08');
    expect(w.startDate).toBe('2026-06-08');
    expect(w.updatedAt).toBe('');
    expect(Object.keys(w.days)).toEqual(weekDates('2026-06-08'));
  });
});

describe('instantiateWeek', () => {
  function templateWithLabels(): MealPlanTemplate {
    const days = Object.fromEntries(
      WEEKDAYS.map((wd) => [wd, { ...emptyDay(), note: `usual-${wd}` }]),
    );
    return { schemaVersion: 1, days };
  }

  it('copies each weekday template day onto the matching dated day (Monday start)', () => {
    const week = instantiateWeek('2026-06-08', config('mon'), templateWithLabels());
    expect(week.days['2026-06-08']!.note).toBe('usual-mon');
    expect(week.days['2026-06-14']!.note).toBe('usual-sun');
  });

  it('maps weekdays correctly when firstDayOfWeek is not Monday', () => {
    // Friday start: 2026-06-12 is a Friday.
    const week = instantiateWeek('2026-06-12', config('fri'), templateWithLabels());
    expect(week.startDate).toBe('2026-06-12');
    expect(week.days['2026-06-12']!.note).toBe('usual-fri');
    expect(week.days['2026-06-13']!.note).toBe('usual-sat');
    expect(week.days['2026-06-18']!.note).toBe('usual-thu');
  });

  it('normalises a midweek startDate to the true week start', () => {
    const week = instantiateWeek('2026-06-10', config('mon'), templateWithLabels());
    expect(week.id).toBe('2026-06-08');
    expect(week.startDate).toBe('2026-06-08');
  });

  it('deep-copies template days (no shared array references)', () => {
    const template = emptyTemplate();
    const week = instantiateWeek('2026-06-08', config('mon'), template);
    expect(week.days['2026-06-08']!.chefs).not.toBe(template.days.mon!.chefs);
  });

  // Issue #1056. `MealPlanTemplateSchema` accepts a document missing weekdays,
  // so this input is a legally parsed template. Before the fix this threw
  // `TypeError: Cannot read properties of undefined (reading 'recipeIds')` out
  // of a non-async function, escaping the planner's `await` and its toast.
  it('instantiates a weekday the template omits as a blank day, and still returns seven dates', () => {
    const partial: MealPlanTemplate = {
      schemaVersion: 1,
      days: { mon: { ...emptyDay(), note: 'usual-mon' } },
    };
    const week = instantiateWeek('2026-06-08', config('mon'), partial);
    expect(Object.keys(week.days)).toEqual(weekDates('2026-06-08'));
    expect(week.days['2026-06-08']!.note).toBe('usual-mon');
    for (const date of weekDates('2026-06-08').slice(1)) {
      expect(week.days[date]).toEqual(emptyDay());
    }
  });

  it('instantiates an entirely empty template as seven blank days', () => {
    const week = instantiateWeek('2026-06-08', config('mon'), { schemaVersion: 1, days: {} });
    expect(Object.keys(week.days)).toEqual(weekDates('2026-06-08'));
    for (const date of weekDates('2026-06-08')) expect(week.days[date]).toEqual(emptyDay());
  });
});

describe('day mutators (immutability + correctness)', () => {
  const base = emptyWeek('2026-06-08');
  const key = '2026-06-08';
  const attendee: Attendee = { memberId: 'a@x.org', homeTime: '18:00', note: '' };

  it('setDayNote sets the note and does not mutate the input', () => {
    const next = setDayNote(base, key, 'pasta');
    expect(next.days[key]!.note).toBe('pasta');
    expect(base.days[key]!.note).toBe('');
  });

  // Issue #1513: the planner headline reads the note's first line, the "is it
  // named?" guards read the whole note. A leading blank line split the two.
  it('setDayNote drops a leading blank line, so the first line is the content', () => {
    const next = setDayNote(base, key, '\nbring wine');
    expect(next.days[key]!.note).toBe('bring wine');
    expect(next.days[key]!.note.split('\n')[0]!.trim()).not.toBe('');
  });

  it('setDayNote drops only whole blank leading lines, keeping a leading space on real content', () => {
    // "Pie and mash", first word deleted: " and mash" must survive untouched —
    // it is not a blank line, so trimming it would rewrite the field mid-edit.
    expect(setDayNote(base, key, ' and mash').days[key]!.note).toBe(' and mash');
  });

  it('setDayNote strips a leading blank line even with \\r\\n endings', () => {
    expect(setDayNote(base, key, '\r\nbring wine').days[key]!.note).toBe('bring wine');
    expect(setDayNote(base, key, ' \r\npie').days[key]!.note).toBe('pie');
  });

  it('setDayNote agrees with the first-line headline for any leading whitespace', () => {
    for (const raw of ['  \n\t\n roast\nwith gravy', ' \r\n pie', '\n\n\n', ' and mash']) {
      const note = setDayNote(base, key, raw).days[key]!.note;
      // The two tests the planner uses must never disagree about a stored note.
      expect(Boolean(note.split('\n')[0]?.trim())).toBe(Boolean(note.trim()));
    }
  });

  it('setDayNote keeps trailing whitespace, which the typed field depends on', () => {
    expect(setDayNote(base, key, 'Pasta ').days[key]!.note).toBe('Pasta ');
    expect(setDayNote(base, key, 'Pasta\n').days[key]!.note).toBe('Pasta\n');
  });

  it('setDayNote tidies a template note too, which instantiateWeek copies verbatim', () => {
    const template = setDayNote(emptyTemplate(), 'mon', '\nlasagne');
    const week = instantiateWeek('2026-06-08', config('mon'), template);
    expect(week.days['2026-06-08']!.note).toBe('lasagne');
  });

  it('setDayChefs replaces chefs with a fresh array', () => {
    const next = setDayChefs(base, key, ['a@x.org', 'b@x.org']);
    expect(next.days[key]!.chefs).toEqual(['a@x.org', 'b@x.org']);
    expect(base.days[key]!.chefs).toEqual([]);
  });

  it('setDayRecipes replaces recipeIds with a fresh array and does not mutate the input', () => {
    const next = setDayRecipes(base, key, ['r1', 'r2']);
    expect(next.days[key]!.recipeIds).toEqual(['r1', 'r2']);
    // fresh array, not the caller's reference
    const src = ['r3'];
    expect(setDayRecipes(base, key, src).days[key]!.recipeIds).not.toBe(src);
    // input untouched
    expect(base.days[key]!.recipeIds).toEqual([]);
  });

  it('setDayGuests sets a non-negative integer count and clamps junk to 0', () => {
    expect(setDayGuests(base, key, 3).days[key]!.guests).toBe(3);
    expect(setDayGuests(base, key, -2).days[key]!.guests).toBe(0);
    expect(setDayGuests(base, key, 2.9).days[key]!.guests).toBe(2);
    expect(base.days[key]!.guests).toBe(0);
  });

  it('addAttendee appends and is idempotent on memberId', () => {
    const once = addAttendee(base, key, attendee);
    const twice = addAttendee(once, key, { ...attendee, homeTime: '19:30' });
    expect(twice.days[key]!.attendees).toHaveLength(1);
    expect(twice.days[key]!.attendees[0]!.homeTime).toBe('19:30');
    expect(base.days[key]!.attendees).toHaveLength(0);
  });

  it('removeAttendee drops the matching member', () => {
    const withA = addAttendee(base, key, attendee);
    const without = removeAttendee(withA, key, 'a@x.org');
    expect(without.days[key]!.attendees).toHaveLength(0);
  });

  it('setAttendeeHomeTime round-trips a blank time as null', () => {
    const withA = addAttendee(base, key, attendee);
    const blanked = setAttendeeHomeTime(withA, key, 'a@x.org', null);
    expect(blanked.days[key]!.attendees[0]!.homeTime).toBeNull();
    // input untouched
    expect(withA.days[key]!.attendees[0]!.homeTime).toBe('18:00');
  });

  it('setAttendeeNote updates only the per-person note', () => {
    const withA = addAttendee(base, key, attendee);
    const noted = setAttendeeNote(withA, key, 'a@x.org', 'portion for tomorrow');
    expect(noted.days[key]!.attendees[0]!.note).toBe('portion for tomorrow');
    expect(noted.days[key]!.attendees[0]!.homeTime).toBe('18:00');
  });

  it('mutators also operate on a template keyed by weekday', () => {
    const template = emptyTemplate();
    const next = setDayNote(template, 'fri', 'pizza');
    expect(next.days.fri!.note).toBe('pizza');
    expect(template.days.fri!.note).toBe('');
  });

  // Issue #1056, both failure modes of an absent day key. The four whole-day
  // mutators did not throw — they wrote a malformed one-key `Day`, which every
  // `MealPlanDaySchema` field defaulting meant read back as a blank day, so the
  // corruption concealed itself. Asserting the SHAPE is therefore the only
  // assertion that fails on the unfixed code; `not.toThrow()` would pass.
  it('setDayNote on a weekday the template omits creates a complete day', () => {
    const partial: MealPlanTemplate = { schemaVersion: 1, days: {} };
    const next = setDayNote(partial, 'wed', 'curry');
    expect(next.days.wed).toEqual({ ...emptyDay(), note: 'curry' });
    expect(partial.days.wed).toBeUndefined();
  });

  // The other row: the four attendee mutators threw a `TypeError` off
  // `undefined.attendees` / `.filter`.
  it('addAttendee on a weekday the template omits creates a complete day', () => {
    const partial: MealPlanTemplate = { schemaVersion: 1, days: {} };
    const next = addAttendee(partial, 'sat', attendee);
    expect(next.days.sat).toEqual({ ...emptyDay(), attendees: [attendee] });
  });

  // The generic container is shared with the concrete week, whose keys are
  // always seeded as the full `weekDates(start)` — so this arm is defence in
  // depth, and it must behave the same way rather than diverging.
  it('a week mutator on an unseeded date key also creates a complete day', () => {
    const next = setDayNote(base, '2026-12-25', 'goose');
    expect(next.days['2026-12-25']).toEqual({ ...emptyDay(), note: 'goose' });
  });
});
