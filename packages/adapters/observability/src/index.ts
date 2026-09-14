// Pure re-export barrel. The client singleton, init, guards, identify/track
// helpers and span shims live in the leaf module src/init.ts, which the adapters
// and session modules import from. This file is imported by NONE of them —
// keeping it a dependency-graph leaf so there is no cycle (CLAUDE.md Rule 8 /
// dependency-cruiser no-circular).
export {
  initObservability,
  isObservabilityReady,
  safePosthog,
  identifyObservabilityUser,
  identifyObservabilityAnonymous,
  trackObservabilityEvent,
  sendSupportFeedback,
  startSpan,
  extractTraceHeaders,
  // Feature flags (issue #831) — the cosmetic gate web-pwa reads to hide an
  // unfinished feature from everyone but the people testing it.
  isObservabilityFeatureEnabled,
  areObservabilityFeatureFlagsSettled,
  onObservabilityFeatureFlags,
} from './init.js';
export type { ObservabilityOptions, ObservabilitySpan, SupportFeedbackTraits } from './init.js';
// Browser-rooted distributed tracing (issue #362, Phase 4). The real OTel tracer
// surface for instrumented user actions: start a ROOT span, get its W3C
// traceparent for the firebase-sync callable wrappers, capture client-side timing.
// initBrowserTracing is wired by initObservability; web-pwa uses startUserActionSpan.
//
// VALUES COME FROM THE FACADE ONLY (issue #813). browserTracer.js is free of
// `@opentelemetry/*` and loads the SDK dynamically; re-exporting any value from
// browserTracerImpl.js here would restore a static edge from this barrel — which
// web-pwa imports — and put the whole SDK back in the boot graph with no visible
// symptom. `toBrowserOtlpSpan` was such a value and is no longer re-exported:
// nothing outside the package used it, and its unit test imports the
// implementation module directly. Types are erased and remain safe to re-export.
export { startUserActionSpan, isBrowserTracingReady } from './browserTracer.js';
export type { UserActionSpan, UserActionChildSpan } from './browserTracer.js';
export {
  createPosthogMatchLoggingAdapter as createObservabilityMatchLoggingAdapter,
  createPosthogMatchLoggingAdapter,
} from './posthogMatchLoggingAdapter.js';
export {
  createPosthogErrorReportingAdapter as createObservabilityErrorReportingAdapter,
  createPosthogErrorReportingAdapter,
} from './posthogErrorReportingAdapter.js';
export { tagObservabilitySession, getObservabilitySessionURL } from './sessionTagging.js';
export type { ObservabilitySessionMeta } from './sessionTagging.js';
export {
  startObservabilitySession,
  stopObservabilitySession,
  isObservabilitySessionActive,
} from './sessionControl.js';
// Feature-usage events (issue #684) — the typed, closed taxonomy web-pwa
// captures at its action seams.
export { trackUsageEvent } from './usageEvents.js';
export type { UsageEventMap, UsageEventName } from './usageEvents.js';
export { CANON_MATCH_EVENT } from './shared/matchOutcomeEvent.js';
export type { CanonMatchEventProps, CanonMatchPath } from './shared/matchOutcomeEvent.js';
// Category-gated error reporting predicate — single source of truth, shared with
// the /server subpath (Phase 3) so the report/suppress gate cannot drift.
export { isReportableCategory } from './shared/reportableCategory.js';
// PostHog feature-flag keys — shared with the /server subpath so both halves of
// a gate cannot spell the same flag differently (issue #1054).
export { BREAD_FLAG_KEY, LIBRARY_FLAG_KEY } from './shared/featureFlagKeys.js';
