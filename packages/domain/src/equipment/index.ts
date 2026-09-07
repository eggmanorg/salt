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
export { setEquipmentEnvironment } from './commands/setEquipmentEnvironment.js';
export type { SetEquipmentEnvironmentInput } from './commands/setEquipmentEnvironment.js';

export { equipmentIconAwaitingApproval } from './queries/equipmentIcon.js';
export { resolveEquipmentItem, namesItemItself } from './queries/resolveEquipmentItem.js';
export type { EditRuleInput } from './commands/editRule.js';
