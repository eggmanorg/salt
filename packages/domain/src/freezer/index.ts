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

// What is in the freezers (issue #1684).
export type { FreezerItem, PackWeight } from './entities/FreezerItem.js';
export type { FreezerStorePort } from './ports/FreezerStorePort.js';
export { addFreezerItem } from './commands/addItem.js';
export type { AddFreezerItemInput } from './commands/addItem.js';
export { editFreezerItem } from './commands/editItem.js';
export type { EditFreezerItemInput } from './commands/editItem.js';
export { moveFreezerItem } from './commands/moveItem.js';
export type { MoveFreezerItemInput } from './commands/moveItem.js';
export { removeFreezerItem } from './commands/removeItem.js';
export type { RemoveFreezerItemInput } from './commands/removeItem.js';
export { nextBagNumber } from './queries/nextBagNumber.js';
export { recordBagNumber } from './commands/recordBagNumber.js';
export { itemsByShelf, oldestFirst } from './queries/itemsByShelf.js';
export type { ItemsByShelf, FreezerStock, ShelfStock } from './queries/itemsByShelf.js';
export { itemAge } from './queries/itemAge.js';
export type { ItemAge } from './queries/itemAge.js';

// Taking packs out, and the remembered suppliers (issue #1684, Phase 2).
export { takeFreezerPacks } from './commands/takeAmount.js';
export type { TakeFreezerPacksInput, TakenPacks } from './commands/takeAmount.js';
export { setFreezerItemAmount } from './commands/setAmount.js';
export type { SetFreezerItemAmountInput } from './commands/setAmount.js';
export { rememberSupplier } from './commands/rememberSupplier.js';
export { forgetSupplier } from './commands/forgetSupplier.js';
export type { ForgetSupplierInput } from './commands/forgetSupplier.js';
export { displayAmount } from './queries/displayAmount.js';
export { supplierSuggestions, supplierSpelling } from './queries/supplierSuggestions.js';

// Using a pack from the freezer instead of buying it (issue #1685).
export type { Defrost } from './entities/Defrost.js';
export { commitDefrost } from './commands/commitDefrost.js';
export type { CommitDefrostInput } from './commands/commitDefrost.js';
export { freezerStockFor } from './queries/freezerStockFor.js';
