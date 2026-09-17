import { logger } from 'firebase-functions';

// Client-side deadline + single retry for outbound AI (Genkit/Gemini) calls.
// The Genkit flow promises have no built-in timeout, so a stalled upstream
// socket never rejects — it just hangs until the Cloud Functions runtime kills
// the whole invocation (~60s in the emulator) with a "socket hang up". This
// wrapper races each attempt against a timer so a stall surfaces as a normal
// rejection. The stall is per-connection (bimodal: a call either returns in a
// few seconds or hangs to the wall), so a single retry on a fresh call almost
// always recovers it before the adapter's catch maps the failure to a
// transient NetworkError (→ matchState 'failed').
//
// 20s exceeds a healthy generate call (slowest observed legit run was ~10s)
// while keeping the worst case (timeout + retry timeout = ~40s) under the 60s
// function timeout.
export const AI_CALL_TIMEOUT_MS = 20_000;
export const AI_CALL_RETRIES = 1;

// The house budget for a one-shot TEXT flow behind a CALLABLE: a single 55s
// attempt with no automatic retry. Used verbatim at every callable text flow
// that wants it, so the number lives here rather than being copied into each
// call (issue #915 — it was written out by hand at nine sites, and a comment at
// one of them already called it "house text-flow values").
//
// 55s rather than the 20s default: a pro-tier structured generation routinely
// runs past 20s, and a retry of a long call would not fit the 90–120s quota the
// callables using this are exported with. No retry: a human is watching a
// spinner and can press the button again.
//
// ── The boundary of that reasoning (issue #1418) ─────────────────────────
//
// Both halves above are about callables, and this comment used to claim more
// than that — it said the flows using it run in a 90–120s function quota, and
// that a trigger using it "treats a failure as 'not yet' and retries on the next
// write". Neither was true of the Firestore triggers: `onRecipeWritten` and
// `onEquipmentManifestWritten` are deployed with 300s, and `onRecipeWritten`'s
// kit branch is edge-triggered on a nonce, so a failure there re-fires for
// nobody until a human presses Redo kit. Four production recipes arrived with no
// kit in the thirteen days to 2026-09-17 because of it.
//
// So this constant's real scope is NARROWER than "every text flow": it is the
// budget for a flow whose host is a callable someone is sat watching. A flow
// whose only host is a 300s trigger takes `AI_TRIGGER_FLOW_TIMEOUT` below.
// Two callables ARE exported at 300s — `extractRecipeFromPhoto` and
// `drawEquipmentIcon` — and neither takes this budget: each keeps its own, for
// its own stated reasons. So the 90–120s range above describes the callables
// that actually use this constant, and is not a claim about callables generally.
//
// TWO SITES STILL ON THIS BUDGET ARE NOT PURELY CALLABLE, and are knowingly left
// so: `describeRecipeScene` and `describeEquipmentSubject` each run behind a 90s
// callable AND a 300s trigger. The wrapper must live in the file that calls the
// model (apps/cloud-functions/CLAUDE.md, sub-rule 1), so one flow-level budget
// cannot be right for both hosts, and the callable is the binding one. Their
// trigger-side runs therefore still give up at 55s. Issue #1418, Open Question 4
// — deliberately deferred, not overlooked.
//
// A site that deliberately wants different values (the image flows' 60s + 1
// retry, generateChatTitle's 15s) keeps its own literal — the constant is for
// the ones that agree, not a lid on the ones that do not.
export const AI_TEXT_FLOW_TIMEOUT = { timeoutMs: 55_000, retries: 0 } as const;

// ─── The trigger-driven budget, and the quota it is derived from ──────────────
//
// ONE place, so the AI deadline and the function quota cannot drift apart — the
// `proposeSchedule` shape (packages/domain/src/schemas/proposeSchedule.ts), and
// deliberately not `generateGuidedPlan`'s, which states the relationship in
// prose and pins nothing. `onRecipeWritten` imports the seconds below for its
// own `timeoutSeconds`, so there is a single number rather than two that agree
// today.
//
// WHAT AN IN-PROCESS DEADLINE IS FOR ON A TRIGGER, and what it is not for.
//
// It is not a cost control and it is not "limit the AI". `withAiTimeout` is a
// `Promise.race` with no `AbortController`, so nothing cancels the upstream
// request: the call runs to completion and is billed whatever we do. Giving up
// early cannot save a penny — it can only forfeit the answer the money already
// bought. That is not hypothetical: on both traced failures in issue #1418 the
// model finished and returned a well-formed kit naming the household's real
// appliances, and we threw it away.
//
// Its one legitimate job is to stop waiting slightly BEFORE the platform stops
// us. Cloud Run enforcing `timeoutSeconds` kills the invocation outright — no
// `logger.error`, no `reportServerError`, no chance to leave a mark on the
// document. So the deadline exists to turn a silent platform kill into a
// recorded failure, and nothing else.
//
// It follows that the number is DERIVED, not measured: the host's quota, less
// enough time to write the failure down. 30s for a log line, a PostHog report
// and at most a Firestore update is generous by an order of magnitude, and the
// three branches of `onRecipeWritten` record concurrently rather than in turn.
//
// The quota itself is NOT free to grow without limit: Firebase forcibly
// terminates an event-driven function at 540s, a platform maximum and not a
// default. 300s is what the trigger has claimed of that, and raising it wants a
// measurement showing the outer ceiling was actually reached — no failure to
// date is the outer clock firing.
//
// Pinned by `tests/aiBudgetVsFunctionQuota.test.ts`, which reads the options
// object the trigger is actually registered with rather than these constants, so
// a `timeoutSeconds` edited back to a literal goes red.
export const AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS = 300;
export const AI_TRIGGER_RECORDING_HEADROOM_MS = 30_000;

// No retry, and for a different reason from the callable budget's: one attempt
// now fills almost the whole quota, so a second could not fit inside it. The
// transient upstream 503 that a retry WOULD recover is real and is recorded in
// issue #1418 as separate work, not smuggled in here.
export const AI_TRIGGER_FLOW_TIMEOUT = {
  timeoutMs: AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS * 1000 - AI_TRIGGER_RECORDING_HEADROOM_MS,
  retries: 0,
} as const;

// A STREAMED answer is bounded by silence, not by total duration. A chef reply
// that keeps producing tokens for two minutes is healthy, and capping its total
// length would truncate a good answer; what is never healthy is a stream that
// stops delivering and never ends. So the deadline is the longest gap we accept
// BETWEEN chunks (and before the first one) — the same budget a non-streaming
// text flow gets for its whole call, which sits well inside the 120s quota the
// one streaming callable is exported with.
export const AI_STREAM_IDLE_TIMEOUT_MS = AI_TEXT_FLOW_TIMEOUT.timeoutMs;

export class AiTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'AiTimeoutError';
  }
}

interface WithAiTimeoutOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
}

async function raceWithTimeout<T>(label: string, op: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiTimeoutError(label, ms)), ms);
  });
  try {
    // The losing promise is left dangling on a stall — acceptable; the function
    // returns its result and the orphaned request settles or is reaped when the
    // worker is paused.
    return await Promise.race([op(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function withAiTimeout<T>(
  label: string,
  op: () => Promise<T>,
  { timeoutMs = AI_CALL_TIMEOUT_MS, retries = AI_CALL_RETRIES }: WithAiTimeoutOptions = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await raceWithTimeout(label, op, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        logger.warn(`${label}: AI call failed, retrying`, {
          attempt: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  throw lastErr;
}

/**
 * The streaming counterpart of `withAiTimeout`, for `ai.generateStream`.
 *
 * `withAiTimeout` cannot guard a stream. Wrapping the aggregated response
 * promise puts the deadline AFTER the drain loop, so a model that goes quiet
 * mid-stream never reaches it and holds the function for its whole quota —
 * exactly the hang that shipped in chefChat (issue #915, finding A5-001).
 *
 * This wraps the ITERATION instead: every `next()` races an idle timer, so the
 * first silence longer than `idleMs` — including before the first chunk —
 * rejects with the same `AiTimeoutError` the non-streaming path throws, and the
 * caller's existing catch reports it and fails the turn. A stream that keeps
 * delivering is never interrupted however long the answer runs, so nothing that
 * worked before stops working.
 *
 * No retry: a partial answer has already been relayed to the client, so
 * re-running the call would repeat text the reader has seen.
 */
export async function* withAiStreamTimeout<T>(
  label: string,
  stream: AsyncIterable<T>,
  idleMs: number = AI_STREAM_IDLE_TIMEOUT_MS,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    // As in raceWithTimeout: on a stall the losing `next()` is left dangling
    // rather than awaited closed. Asking a hung async generator to return()
    // queues behind that same pending next() and would re-create the hang this
    // exists to close.
    const next = await raceWithTimeout(label, () => iterator.next(), idleMs);
    if (next.done === true) return;
    yield next.value;
  }
}
