import type { FreezerItemDoc } from '../../schemas/freezerItem.js';

// Wire shape of one `freezerItems/{number}` document (issue #1684).
// Schema-first (issue #932): the type is the schema's.
export type FreezerItem = FreezerItemDoc;
