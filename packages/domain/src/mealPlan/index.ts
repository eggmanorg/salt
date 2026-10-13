// Meal planning module — published surface (issue #169).
// This file is the ONLY thing other domain modules and adapters import from
// mealPlan. Anything not re-exported here is private. See docs/meal-planning.md.

export type { Weekday } from './entities/Weekday.js';
export { WEEKDAYS } from './entities/Weekday.js';
export type { Attendee, Day } from './entities/Day.js';
export type { MealPlanConfig } from './entities/MealPlanConfig.js';
export type { MealPlanTemplate } from './entities/MealPlanTemplate.js';
export type { MealPlanWeek } from './entities/MealPlanWeek.js';

export {
  weekStartFor,
  weekDates,
  weekdayOf,
  dayIndexInWeek,
  weekExtendsIntoNext,
  WEEK_EXTENSION_DAYS,
  templateWeekStarts,
  TEMPLATE_WEEK_OFFERS,
  WEEKDAY_INDEX,
} from './queries/weekdays.js';

// Meals (issue #752) — the plan's answer to "when is dinner tonight?", which is
// what a meal's cook plan defaults its serve time to.
export { latestHomeTimeFor } from './queries/latestHomeTimeFor.js';

// The night a pack used from the freezer is for, worked out once at commit (#1696).
export { nextPlannedNight } from './queries/nextPlannedNight.js';

export { emptyDay, emptyWeek, emptyTemplate } from './commands/emptyDay.js';
export { instantiateWeek } from './commands/instantiateWeek.js';
export {
  setDayNote,
  setDayChefs,
  setDayRecipes,
  setDayGuests,
  addAttendee,
  removeAttendee,
  setAttendeeHomeTime,
  setAttendeeNote,
} from './commands/dayMutators.js';
