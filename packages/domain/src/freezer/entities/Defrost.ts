import type { DefrostDoc } from '../../schemas/defrost.js';

// Wire shape of one `defrosts/{number}_{recipeId|manual}` document (issue #1685).
// Schema-first (issue #932): the type is the schema's.
export type Defrost = DefrostDoc;
