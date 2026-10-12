// Mints a freezer's id when it is added (issue #1682). Injected so the domain
// stays random-free (Rule 1). The id is opaque and outlives every rename.
export interface FreezerIdGenerator {
  newFreezerId(): string;
}
