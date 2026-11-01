import type { FreezerItemDoc, PackWeightDoc } from '../../schemas/freezerItem.js';

// Wire shape of one `freezerItems/{number}` document (issue #1684).
// Schema-first (issue #932): the type is the schema's.
export type FreezerItem = FreezerItemDoc;

/** How big one pack under a bag number is: g, ml, or a count of pieces (issue #1712). */
export type PackWeight = PackWeightDoc;
