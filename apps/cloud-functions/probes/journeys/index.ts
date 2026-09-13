import type { Journey } from '../harness/journey.js';

import { authRules } from './auth-rules.js';
import { canonIcon } from './canon-icon.js';
import { chefChat } from './chef-chat.js';
import { cookTimer } from './cook-timer.js';
import { mealplanShopday } from './mealplan-shopday.js';
import { recipeCanonShopping } from './recipe-canon-shopping.js';
import { recipeImport } from './recipe-import.js';

/**
 * Every journey the runner can dispatch. Order is the `all` run order, cheapest
 * and most diagnostic first: if `auth-rules` fails, no later result means
 * anything. The opt-in journeys sort last.
 */
export const JOURNEYS: readonly Journey[] = [
  authRules,
  mealplanShopday,
  recipeCanonShopping,
  chefChat,
  canonIcon,
  cookTimer,
  recipeImport,
];

export function findJourney(name: string): Journey | undefined {
  return JOURNEYS.find((journey) => journey.name === name);
}
