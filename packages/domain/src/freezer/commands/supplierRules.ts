// The comparison the supplier list makes (issue #1684): trimmed and
// case-insensitive, so "swaledale " and "Swaledale" are one place. Internal to
// the module, like `itemRules.ts`.
export function supplierKey(text: string): string {
  return text.trim().toLowerCase();
}
