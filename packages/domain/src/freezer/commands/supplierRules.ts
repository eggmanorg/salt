// The comparison the remembered lists make — the places bought from (issue #1684)
// and the containers: trimmed and case-insensitive, so "swaledale " and
// "Swaledale" are one place. Internal to the module, like `itemRules.ts`.
export function supplierKey(text: string): string {
  return text.trim().toLowerCase();
}

/** `list` with `raw` added, or `null` when it is blank or already there (first spelling kept). */
export function rememberIn(list: readonly string[], raw: string | null): string[] | null {
  const text = raw?.trim() ?? '';
  const key = supplierKey(text);
  if (!text || list.some((s) => supplierKey(s) === key)) return null;
  return [...list, text];
}

/** `list` without `raw`, or `null` when it does not have it. */
export function forgetIn(list: readonly string[], raw: string): string[] | null {
  const key = supplierKey(raw);
  const kept = list.filter((s) => supplierKey(s) !== key);
  return kept.length === list.length ? null : kept;
}

/** The entries containing `typed`, compared as above, alphabetical; all when blank. */
export function matchingIn(list: readonly string[], typed: string): string[] {
  const q = supplierKey(typed);
  return list.filter((s) => supplierKey(s).includes(q)).sort((a, b) => a.localeCompare(b));
}

/** The remembered spelling of `typed`, else `typed` trimmed; `null` when blank. */
export function spellingIn(list: readonly string[], typed: string | null): string | null {
  const text = typed?.trim() ?? '';
  if (!text) return null;
  const key = supplierKey(text);
  return list.find((s) => supplierKey(s) === key) ?? text;
}
