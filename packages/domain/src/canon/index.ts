// Canon module — published surface.
// This file is the ONLY thing other domain modules and coordinators are allowed
// to import from canon. Anything not re-exported here is private to canon by
// design.

export type {
  CanonItem,
  ShoppingBehavior,
  CanonItemUnit,
  PendingCanonChange,
} from './entities/CanonItem.js';
export type { Aisle } from './entities/Aisle.js';
export type { CanonLocalStorePort } from './ports/CanonLocalStorePort.js';
export type { AisleLocalStorePort } from './ports/AisleLocalStorePort.js';
export type { IdGenerator } from './ports/IdGenerator.js';
export { createCanonItem } from './commands/createCanonItem.js';
export type { CreateCanonItemInput } from './commands/createCanonItem.js';
export type { MatchCandidate, MatchStage } from './entities/MatchCandidate.js';
export { MATCH_THRESHOLDS } from './queries/matchThresholds.js';
export type {
  MatchLogEntry,
  StageLog,
  CandidateLog,
  StageSkipReason,
  FinalDecision,
  ArbitrationLog,
} from './entities/MatchLogEntry.js';
export type { MatchLoggingPort } from './ports/MatchLoggingPort.js';
export type { EmbeddingPort } from './ports/EmbeddingPort.js';
export { MatchLogBuilder } from './commands/buildMatchLog.js';
export { embedMatch } from './queries/embedMatch.js';
export { findClosestMatch } from './queries/findClosestMatch.js';
export { findExactCanonMatch } from './queries/findExactCanonMatch.js';
export type { FindClosestMatchResult } from './queries/findClosestMatch.js';
export type {
  CanonArbitrationPort,
  ArbitrationRequest,
  ArbitrationResult,
} from './ports/CanonArbitrationPort.js';
export {
  matchOrCreate,
  matchOrCreateBatch,
  ARBITRATION_FAILED_REASONING,
  ARBITRATION_NO_MATCH_REASONING,
} from './commands/matchOrCreate.js';
export { appendCanonSynonym } from './commands/appendCanonSynonym.js';
export type {
  DerivedNamePredicate,
  AppendCanonSynonymOptions,
} from './commands/appendCanonSynonym.js';
export { recordPendingCanonChange } from './commands/recordPendingCanonChange.js';
export type {
  MatchOrCreateInput,
  MatchOrCreatePorts,
  MatchOrCreateResult,
} from './commands/matchOrCreate.js';
export { approveCanonItem } from './commands/approveCanonItem.js';
export type { ApproveCanonItemOverrides } from './commands/approveCanonItem.js';
export { renameCanonItem } from './commands/renameCanonItem.js';
export { setCanonItemAisle } from './commands/setCanonItemAisle.js';
export { setCanonItemSynonyms } from './commands/setCanonItemSynonyms.js';
export {
  setCanonItemShoppingBehavior,
  setCanonItemThreshold,
  setCanonItemGramsPerItem,
} from './commands/setCanonItemShoppingFields.js';
export { setCanonItemThumbnail } from './commands/setCanonItemThumbnail.js';
// The one description of an icon-regeneration write (issue #1054), shared by the
// admin screens and the canon/product-form callables — different apps that
// cannot import each other.
export { iconRegenerationFields } from './commands/iconRegenerationFields.js';
export type { IconRegenerationFields } from './commands/iconRegenerationFields.js';
export { createAisle } from './commands/createAisle.js';
export type { CreateAisleInput } from './commands/createAisle.js';
export { createAislesBulk } from './commands/createAislesBulk.js';
export type { CreateAislesBulkInput } from './commands/createAislesBulk.js';
export { renameAisle } from './commands/renameAisle.js';
export type { RenameAisleInput } from './commands/renameAisle.js';
export { reorderAisles } from './commands/reorderAisles.js';
export type { ReorderAislesInput } from './commands/reorderAisles.js';
export { deleteAisles } from './commands/deleteAisles.js';
export type { DeleteAislesInput } from './commands/deleteAisles.js';
export { mergeAisles } from './commands/mergeAisles.js';
export type {
  MergeAislesInput,
  PerItemMergeChoice,
  ItemMergeChoice,
} from './commands/mergeAisles.js';
export { normaliseName } from './queries/normaliseName.js';
export { CANON_ICON_HIDDEN, isCanonIconRenderable } from './queries/canonIcon.js';
export { summarizeMatchLog } from './queries/summarizeMatchLog.js';
export type { MatchLogSummary } from './queries/summarizeMatchLog.js';
export { describePendingCanonChange } from './queries/describePendingCanonChange.js';
export type { PendingCanonChangeDescription } from './queries/describePendingCanonChange.js';
export { hasLiveCanonMatch, isResolvedMatchState } from './queries/hasLiveCanonMatch.js';
