/**
 * A bag number as it is shown and written on the bag: at least four digits,
 * zero-padded — `7` → `"0007"`. A number past 9999 is shown in full, never cut.
 * Display only: the stored number, the document id and every comparison stay
 * the plain integer.
 */
export function formatBagNumber(number: number): string {
  return String(number).padStart(4, '0');
}
