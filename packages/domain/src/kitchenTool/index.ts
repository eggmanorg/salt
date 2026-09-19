// KitchenTool module — published surface. The ONLY thing other domain modules
// and coordinators may import from kitchenTool; anything not re-exported here is
// private to the module by design (mirrors productForm/index.ts).
//
// One display-time lookup, the two commands that CURATE the vocabulary the lookup
// reads, and the query that says what the vocabulary is still missing. Nothing
// here writes an answer back onto a recipe or a plan — that is the whole shape of
// the feature: the words stay where the cook typed them and the picture is found
// from them every time a row is drawn.
export { resolveKitchenTool, resolveKitchenToolMatch } from './queries/resolveKitchenTool.js';
export type { KitchenToolMatch } from './queries/resolveKitchenTool.js';
// The same lookup with the accessory-name rule in front of it (issues #1460,
// #1465) — a machine part never borrows an unrelated object's drawing. Every kit
// surface goes through this; `resolveKitchenTool` above still serves the
// vocabulary tests and the admin page, where no manifest is in play.
export {
  kitchenToolForKitLabel,
  namesManifestAccessory,
} from './queries/kitchenToolForKitLabel.js';
export { unresolvedKitLabels } from './queries/unresolvedKitLabels.js';
export { suggestKitchenToolParent } from './queries/suggestKitchenToolParent.js';
export { instanceNamedKitchenTools } from './queries/instanceNamedKitchenTools.js';
export type { InstanceNamedKitchenTool } from './queries/instanceNamedKitchenTools.js';
export type {
  UnresolvedKitLabel,
  KitLabelSource,
  ContainerSource,
} from './queries/unresolvedKitLabels.js';
export { createKitchenTool } from './commands/createKitchenTool.js';
export type { CreateKitchenToolInput } from './commands/createKitchenTool.js';
export { updateKitchenTool } from './commands/updateKitchenTool.js';
export type { UpdateKitchenToolInput } from './commands/updateKitchenTool.js';
export { kitchenToolSlug } from './commands/kitchenToolIdentity.js';
