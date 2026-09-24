import type { Attendee, Day } from '../entities/Day.js';
import { emptyDay } from './emptyDay.js';

// Day mutators operate on a "day container" — either a MealPlanWeek (date-keyed)
// or a MealPlanTemplate (weekday-keyed). They are generic over the key type so a
// week is mutated with a "YYYY-MM-DD" key and a template with a weekday key,
// while sharing one implementation. All return a new container and never mutate
// the input (pure, time-free — the service stamps `updatedAt` on save).

// The record is PARTIAL (issue #1056). A template legitimately omits weekdays —
// `MealPlanTemplateSchema` accepts a document missing them — and `Record<K, Day>`
// with a generic `K` is a mapped type, not an index signature, so
// `noUncheckedIndexedAccess` did not apply and the read below was silently typed
// `Day`. Partial is what makes the `?? emptyDay()` guard load-bearing rather
// than dead code the compiler thinks unreachable.
type DayContainer<K extends string> = { readonly days: Readonly<Partial<Record<K, Day>>> };

// An absent `dayKey` updates a blank day rather than `undefined`. Two failure
// modes preceded this (issue #1056): the four whole-day mutators wrote a
// malformed one-key `Day` — which every `MealPlanDaySchema` field defaulting
// meant read back as a blank day, concealing itself — and the four attendee
// mutators threw a `TypeError` off `undefined.attendees`. Both now produce the
// same well-formed day. Live for templates; defence in depth for a concrete
// week, whose keys are always seeded as the full `weekDates(start)`.
function withDay<K extends string, T extends DayContainer<K>>(
  container: T,
  dayKey: K,
  update: (day: Day) => Day,
): T {
  const next = update(container.days[dayKey] ?? emptyDay());
  return { ...container, days: { ...container.days, [dayKey]: next } } as T;
}

function withAttendee(day: Day, memberId: string, update: (a: Attendee) => Attendee): Day {
  return {
    ...day,
    attendees: day.attendees.map((a) => (a.memberId === memberId ? update(a) : a)),
  };
}

// The note is tidied on the way in (issue #1513): leading whitespace — blank
// lines included — is dropped. The planner's headline is the note's FIRST line,
// while "is this night named?" asks whether the WHOLE note is blank; a note like
// "\nbring wine" answered those two questions differently and read "Nothing
// planned" over a planned night. Once the note starts with a non-blank
// character, its first line is non-blank exactly when the whole note is.
//
// Only the START is trimmed, not both ends. This runs on every keystroke of the
// Dinner textarea, whose `value` is driven from the store: stripping a trailing
// space reset the field mid-sentence ("Pa b", backspace, "Pa " became "Pa", so
// the next word ran on). `apps/web-pwa/tests/MealDayDetail.noteTyping.test.ts`
// pins that. A trailing blank never changes what the first line reads, so it
// costs nothing to keep.
//
// Every note the app EDITS — week day and weekday template alike — is written
// through here, which is why the tidy lives here and not at a persist boundary:
// a template note is copied verbatim into each new week by `instantiateWeek`, so
// tidying it once here tidies every week built from it. The limit: a note
// stored before this change keeps its old shape until that day (or template
// weekday) is next edited, and `instantiateWeek` copies an old template note
// as it stands. #1513 chose fix-forward — see docs/meal-planning.md.
export function setDayNote<K extends string, T extends DayContainer<K>>(
  container: T,
  dayKey: K,
  note: string,
): T {
  return withDay(container, dayKey, (day) => ({ ...day, note: note.trimStart() }));
}

export function setDayChefs<K extends string, T extends DayContainer<K>>(
  container: T,
  dayKey: K,
  chefs: readonly string[],
): T {
  return withDay(container, dayKey, (day) => ({ ...day, chefs: [...chefs] }));
}

// Replace the day's attached recipe ids with a fresh array. Order-preserving —
// the caller decides ordering (append-on-add). Stores ids only; titles/images
// resolve live from the recipes store at render time (no denormalisation).
export function setDayRecipes<K extends string, T extends DayContainer<K>>(
  container: T,
  dayKey: K,
  recipeIds: readonly string[],
): T {
  return withDay(container, dayKey, (day) => ({ ...day, recipeIds: [...recipeIds] }));
}

// Set the count of extra unnamed guests. Negative inputs are clamped to 0.
export function setDayGuests<K extends string, T extends DayContainer<K>>(
  container: T,
  dayKey: K,
  guests: number,
): T {
  return withDay(container, dayKey, (day) => ({ ...day, guests: Math.max(0, Math.trunc(guests)) }));
}

// Add an attendee. Idempotent on memberId: an existing entry for the same member
// is replaced, so a member can never appear twice.
export function addAttendee<K extends string, T extends DayContainer<K>>(
  container: T,
  dayKey: K,
  attendee: Attendee,
): T {
  return withDay(container, dayKey, (day) => ({
    ...day,
    attendees: [...day.attendees.filter((a) => a.memberId !== attendee.memberId), { ...attendee }],
  }));
}

export function removeAttendee<K extends string, T extends DayContainer<K>>(
  container: T,
  dayKey: K,
  memberId: string,
): T {
  return withDay(container, dayKey, (day) => ({
    ...day,
    attendees: day.attendees.filter((a) => a.memberId !== memberId),
  }));
}

// Set an attendee's home time. `null` (blank) is a valid saved state.
export function setAttendeeHomeTime<K extends string, T extends DayContainer<K>>(
  container: T,
  dayKey: K,
  memberId: string,
  homeTime: string | null,
): T {
  return withDay(container, dayKey, (day) =>
    withAttendee(day, memberId, (a) => ({ ...a, homeTime })),
  );
}

export function setAttendeeNote<K extends string, T extends DayContainer<K>>(
  container: T,
  dayKey: K,
  memberId: string,
  note: string,
): T {
  return withDay(container, dayKey, (day) => withAttendee(day, memberId, (a) => ({ ...a, note })));
}
