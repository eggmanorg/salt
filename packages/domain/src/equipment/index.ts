// Equipment module — published surface.
// This file is the ONLY thing other domain modules and adapters are allowed
// to import from equipment. Anything not re-exported here is private.

export type { Accessory, EquipmentItem } from './entities/EquipmentItem.js';
export type { EquipmentManifest } from './entities/EquipmentManifest.js';
export type { EquipmentManifestPort } from './ports/EquipmentManifestPort.js';

export { addEquipment } from './commands/addEquipment.js';
export type { AddEquipmentInput } from './commands/addEquipment.js';
export { removeEquipment } from './commands/removeEquipment.js';
export type { RemoveEquipmentInput } from './commands/removeEquipment.js';
export { renameEquipment } from './commands/renameEquipment.js';
export type { RenameEquipmentInput } from './commands/renameEquipment.js';
export { addAccessory } from './commands/addAccessory.js';
export type { AddAccessoryInput } from './commands/addAccessory.js';
export { removeAccessory } from './commands/removeAccessory.js';
export type { RemoveAccessoryInput } from './commands/removeAccessory.js';
export { setAccessoryOwned } from './commands/setAccessoryOwned.js';
export type { SetAccessoryOwnedInput } from './commands/setAccessoryOwned.js';
export { addRule } from './commands/addRule.js';
export type { AddRuleInput } from './commands/addRule.js';
export { removeRule } from './commands/removeRule.js';
export type { RemoveRuleInput } from './commands/removeRule.js';
export { editRule } from './commands/editRule.js';
export { editAccessoryNote } from './commands/editAccessoryNote.js';
export type { EditAccessoryNoteInput } from './commands/editAccessoryNote.js';
export { editEquipmentNote } from './commands/editEquipmentNote.js';
export type { EditEquipmentNoteInput } from './commands/editEquipmentNote.js';
export { setEquipmentKind } from './commands/setEquipmentKind.js';
export type { SetEquipmentKindInput } from './commands/setEquipmentKind.js';
export { setEquipmentEnvironment } from './commands/setEquipmentEnvironment.js';
// Point one of your things at a picture that already exists (issue #1465, Phase
// 3) — a reference, never a copied URL, so redrawing the source updates
// everything borrowing it.
export { setBorrowedPicture } from './commands/setBorrowedPicture.js';
export type { SetBorrowedPictureInput } from './commands/setBorrowedPicture.js';
export type { SetEquipmentEnvironmentInput } from './commands/setEquipmentEnvironment.js';

export { equipmentIconAwaitingApproval, equipmentIconOwnerIds } from './queries/equipmentIcon.js';
export type { IconOwner } from './queries/equipmentIcon.js';
// The words ONE ENTRY's picture is described from (issue #1465, Phase 2) — the
// entry's own name for a family member, qualified by the appliance for a part.
export { equipmentEntrySubjectName } from './queries/equipmentEntrySubject.js';
export { resolveEquipmentItem, namesItemItself } from './queries/resolveEquipmentItem.js';
// The LINK half of the same question (issue #1465) — which of your things a kit
// entry recorded, read from an id rather than guessed from the words. Where a
// link resolves it is authoritative; a dangling one answers null and the label
// falls back to the word resolver above.
export {
  resolveKitEntryEquipment,
  resolveKitEntryItem,
} from './queries/resolveKitEntryEquipment.js';
export type {
  ResolvedKitEquipment,
  KitEquipmentLinkSource,
  KitEntryEquipmentSource,
} from './queries/resolveKitEntryEquipment.js';
export type { EditRuleInput } from './commands/editRule.js';
