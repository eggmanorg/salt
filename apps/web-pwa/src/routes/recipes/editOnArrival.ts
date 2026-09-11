// "Land on the entry's own page, already editing it" (issue #1319 Phase 6).
//
// The New sheet writes a document and then navigates to `/recipes/{id}`. The page
// it lands on has no idea the entry was created a moment ago — `editing` starts
// false and its id-keyed reset effect puts it back to false on every arrival — so
// the intent has to travel with the navigation somehow. This is that channel: one
// id, handed over, consumed once.
//
// MODULE STATE, deliberately, and CLAUDE.md Rule 3 is why there is no fourth
// sanctioned storage key here: the request is worth exactly one navigation inside
// one tab, so a reload is allowed to land in read mode. Nothing is lost by that —
// the document is already written and everything on the page is editable one tap
// away. It is the same shape `stashImportedDraft` in `recipeService.ts` already
// uses for the same kind of single-hop hand-off.
//
// A querystring was the alternative and was rejected: `?edit=1` would survive a
// reload, which sounds like a feature until it has to be cleared — `startEditing`
// and `finishEditing` already push `?serves=` away on the way in and out, and a
// second param riding those same two pushes is a second thing that can be left
// behind in the address bar.
//
// ID-MATCHED rather than a bare boolean: a request made for one entry must not
// open edit mode on whatever page happens to mount next if the navigation is
// diverted. The boundary, stated rather than rounded up — a request whose page
// never mounts is not cleaned up and stays pending until a page for that exact id
// mounts, which for a just-minted uuid means effectively never. It holds one
// string, so nothing accumulates.
let pendingId: string | null = null;

/** Ask the next `/recipes/{recipeId}` to open in edit mode. */
export function requestEditOnArrival(recipeId: string): void {
  pendingId = recipeId;
}

/**
 * Consume the request, if one was made for this recipe. True at most once per
 * `requestEditOnArrival` call — a second arrival on the same page reads false,
 * which is what keeps a back-button return to the entry in read mode.
 */
export function takeEditOnArrival(recipeId: string): boolean {
  if (pendingId !== recipeId) return false;
  pendingId = null;
  return true;
}

/** Drop a pending request without acting on it — test isolation only. */
export function clearEditOnArrival(): void {
  pendingId = null;
}
