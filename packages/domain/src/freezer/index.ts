// Freezer module (issue #1682, epic #795) — published surface.
// This file is the ONLY thing other domain modules and adapters are allowed
// to import from freezer. Anything not re-exported here is private.

export type { Freezer, FreezerConfig } from './entities/FreezerConfig.js';
export { emptyFreezerConfig } from './entities/FreezerConfig.js';
export type { FreezerConfigPort } from './ports/FreezerConfigPort.js';
export type { FreezerIdGenerator } from './ports/FreezerIdGenerator.js';

export { addFreezer } from './commands/addFreezer.js';
export type { AddFreezerInput } from './commands/addFreezer.js';
export { renameFreezer } from './commands/renameFreezer.js';
export type { RenameFreezerInput } from './commands/renameFreezer.js';
export { setShelves } from './commands/setShelves.js';
export type { SetShelvesInput } from './commands/setShelves.js';
export { removeFreezer } from './commands/removeFreezer.js';
export type { RemoveFreezerInput } from './commands/removeFreezer.js';
