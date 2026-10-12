// VIOLATION: freezer must not import another module's internals via subpath.
// Sibling modules may only be imported through their published index.
// Expected: no-restricted-imports error.
import '../../equipment/entities/EquipmentManifest';
