// Shared date formatting (issue #940, Phase 2).
//
// `new Intl.DateTimeFormat(...)` resolves locale data; it is orders of magnitude
// dearer than calling `.format()` on one that already exists. Ten call sites
// across five feature areas built theirs INSIDE the function that formatted, so
// a fourteen-row planner view constructed forty-odd of them on mount and again
// on every snapshot. Two screens already had it right as a module constant
// (`MealCookPlanPage`, `MinePage`); this module is that shape, shared.
//
// `packages/domain/src/shoppingDay/calendarDates.ts` is deliberately NOT a
// client: it takes `timeZone` as a parameter, so it cannot become one constant,
// and a memo there would be mutable module state in a package CLAUDE.md Rule 1
// requires to be pure. It formats once per daily reminder — there is no cost to
// recover (issue #940, D4).

// One formatter per distinct (locale, options) pair, built on first use.
//
// A memo rather than a fixed set of constants because two callers pass their
// options in — the planner's week/day labels and the add-to-planner night
// list each format the same date six different ways. The keys are the option literals
// written in the source, so the map is bounded by the code, not by the data:
// nothing user-supplied ever reaches it.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  // `Intl` normalises the options it was given, so the resolved set is a stable
  // key whatever order the caller wrote them in.
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * A `YYYY-MM-DD` calendar day, in words.
 *
 * UTC throughout, and that is not a detail: a date key is a calendar day, not an
 * instant, so parsing it as local midnight renders the day before anywhere west
 * of Greenwich. Every caller that had its own copy of this got that right, and
 * every one of them wrote the `T00:00:00.000Z` by hand to do so.
 */
export function formatDayKey(date: string, options: Intl.DateTimeFormatOptions): string {
  return formatterFor('en-GB', { ...options, timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00.000Z`),
  );
}

/**
 * An instant, in words. Local time — unlike a date key, an instant genuinely
 * happened at a moment the reader was living through.
 *
 * `locale` defaults to `en-GB` because most of the app states dates the British
 * way regardless of the device; the chat surfaces pass `undefined` to follow the
 * reader's own locale instead, which is the behaviour they already had.
 */
export function formatInstant(
  at: Date | number,
  options: Intl.DateTimeFormatOptions,
  locale: string | undefined = 'en-GB',
): string {
  return formatterFor(locale, options).format(at);
}

/**
 * A chat's "last said" stamp — the same month/day/time in the reader's own
 * locale, wherever a list of conversations is shown.
 *
 * `RecipeChatList` and `ChatListPage` each carried a byte-identical private
 * `formatDate` for this (finding `A5-015`). `ChatMemoryPage`'s twin was NOT
 * identical — it omits the time — so it stays its own call rather than being
 * bent to fit a shared name.
 */
export function formatChatTimestamp(iso: string): string {
  return formatInstant(
    new Date(iso),
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    undefined,
  );
}
