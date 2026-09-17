# Cloud Functions — subsystem conventions

Loaded only when working under `apps/cloud-functions/`. The universal AI rules (all
AI access via Genkit callables; wrap every AI call in `withAiTimeout`) stay in the
root [CLAUDE.md](../../CLAUDE.md) — this file holds the subsystem detail.

## AI timeouts — the three sub-rules

`withAiTimeout` is stated as a rule in the root contract. These three make it
mechanical rather than remembered (issue #915), and `tests/aiTimeoutGuard.test.ts`
enforces all three by scanning the whole of `src`:

- **The wrapper goes in the file that calls the model**, never at a caller. A flow may be invoked from several places — and several are exported as callables in their own right, which no caller wraps — so a caller-side deadline is coverage of the callers that remembered, not of the flow. A second wrapper nested around a flow that already has one is also wrong: two budgets disagree, and the outer (house default 20 s) pre-empts and retries an inner one sized for the work.
- **`ai.generateStream` needs `withAiStreamTimeout`, not `withAiTimeout`.** A promise wrapper cannot bound a stream: applied to the aggregated response it is not reached until the drain loop has finished, so a model that goes quiet mid-stream is unguarded. The stream wrapper races each chunk against an idle timer — a stream is bounded by silence, never by total duration.
- **`{ timeoutMs: 55_000, retries: 0 }` is `AI_TEXT_FLOW_TIMEOUT`**, exported beside `withAiTimeout`. A site that deliberately wants other values (the image flows, `generateChatTitle`) keeps its own literal and says why.
- **A flow whose only host is a trigger takes `AI_TRIGGER_FLOW_TIMEOUT`, not the callable budget** (issue #1418). Nobody is waiting, nothing cancels the upstream call, and the deadline's only job is to give up just before Cloud Run does so the failure can still be recorded — so it is DERIVED from the host's `timeoutSeconds`, which the trigger imports from the same place. Pinned by `tests/aiBudgetVsFunctionQuota.test.ts`. A dual-hosted flow keeps the callable's budget; the two that are ([`withAiTimeout.ts`](src/adapters/withAiTimeout.ts)) say so.

Functions calling AI must also declare their AI-related secrets.

## Trace propagation

**Goal:** one CF invocation renders as one coherent trace, rooted at the browser
click and never re-rooted server-side. The browser mints a real trace id with its
in-memory OTel tracer (`startUserActionSpan`, `packages/adapters/observability/src/browserTracer.ts`)
and exports it to PostHog, so the whole path shares one trace id. Rationale and
history: [docs/trace-propagation.md](../../docs/trace-propagation.md).

1. **Callables prefer the browser-supplied field over the inbound header.** Two
   context sources, fixed precedence: (1) a browser-supplied `traceparent` carried
   as a named, typed, optional field on the callable wire input, run via
   `runWithSuppliedTraceContext`; failing that, (2) a real inbound W3C trace header
   off `request.rawRequest.headers`, extracted via `runWithExtractedTraceContext`.
   Both live in `@salt/observability/server`, and both degrade to a plain call and
   never throw (Rule 10).

   **This precedence cannot be flipped.** The Firebase callable SDK cannot carry a
   custom per-call HTTP header — `HttpsCallableOptions` is only
   `{ timeout?, limitedUseAppCheckTokens? }`, and the `@firebase/functions`
   transport sets its own fixed headers (Content-Type, Authorization, App Check,
   Instance-ID). The field is therefore the _only_ channel that can carry the
   browser's trace id, and the only one that unifies the browser action with the
   server flow. The inbound header is GCP's fresh request-trace root: preferring it
   would re-root away from the browser trace and could never unify with it. It is
   the fallback, used only when no non-empty field is present.

2. **The field is schema-validated, then stripped at the entrypoint.** Wire envelope
   is `<Name>WireInputSchema = <Name>InputSchema.extend({ traceparent: z.string().optional() })`
   in `@salt/domain/schemas`. The entrypoint strips `traceparent` so the flow
   receives the pure domain input — flows never consume it (domain purity). A
   malformed or absent `traceparent` must **not** fail the call; it is optional and
   best-effort. Only a malformed wire envelope (bad domain input) is rejected, with
   `HttpsError('invalid-argument', …)`.

3. **`traceContextWire.ts` is the roll-call — never copy it.** Every callable
   declared with `makeTracedCallable` gets this treatment, and the wire envelopes in
   `packages/domain/src/schemas/traceContextWire.ts` (re-exported from the
   `@salt/domain/schemas` barrel) _are_ the list. It is deliberately not restated
   here: a hand-maintained roll-call is exactly what went stale, naming six while
   `index.ts` built nine. Note this is not an AI-flow feature —
   `refreshWeatherForecast` carries the field and calls no model. A new callable
   that doesn't need the nesting can use `onCallGenkit`.

4. **One browser span may cover several callables.** `identifyEquipment` →
   `populateEquipmentEntry` is the standing case (#361): the add-equipment action
   fires both with human think-time between, so the browser mints one
   `startUserActionSpan('Add equipment: <name>')` and supplies the _same_
   `traceparent` to both calls, nesting both flows under one trace instead of
   re-rooting two. Both were converted `onCallGenkit` → `onCall` for this. **Any
   `onCall` flow must flush AI-OTLP spans in a `finally`** — `onCall` has no
   framework forceFlush — with error reporting at the entrypoint catch.

5. **Firestore triggers continue the trace via a doc field.** Triggers have no
   inbound HTTP headers, so an optional, additive `traceContext` (a W3C
   `traceparent` string) rides on the written doc; `ShoppingListItemSchema` and
   `CanonItemSchema` each carry it. The chain: browser roots
   `startUserActionSpan('Add item: <name>')` → `saveShoppingListItem(item, traceparent?)`
   stamps it as `traceContext` → `onShoppingListItemWrite` runs its canon-matching
   within that context and propagates the field onto the canon doc it writes →
   `onCanonItemWritten` runs icon + embedding work in the same context. So "Add
   tinned tomatoes to shopping list" renders as one trace: browser action →
   canon-match trigger → icon trigger.

   Two purity constraints are easy to break here. `firebase-sync` forwards the plain
   string and **never imports observability** (Rule 4). The adapter
   (`createFirestoreCanonStore` / `buildMatchOrCreatePorts`) adds the field at write
   time, so the pure-domain `CanonItem` never carries it.

6. **`traceContext` is transport only.** Domain logic never branches on it. A
   missing or malformed value degrades to a normal root trace and never fails a
   write or a trigger (Rule 10). Additive and back-compatible: old docs lack the
   field and stay valid under skip-invalid `.safeParse` reads. The bare
   `traceContext`-only write-back cannot loop the icon/embedding triggers — their
   idempotency guards key off `thumbnail` / `iconRequestedAt` / `embedding`, never
   `traceContext`.

7. **The whole mechanism is suppressed under `GENKIT_TELEMETRY_SERVER`** (local
   `pnpm dev:emulators`), so flows stay root-listed in the Genkit Dev UI. Callables
   and triggers alike — a CF-local `runTriggerWithTraceContext` wraps the helper on
   the trigger side. This env gate is what resolved the regression that originally
   parked propagation; do not remove it.
