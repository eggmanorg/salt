import type { DomainError, ReadResult } from '@salt/shared-types';
import type { GenerateGuidedPlanInput, GenerateGuidedPlanOutput } from '@salt/domain/schemas';
import { callFunction } from './callFunction.js';

// generateGuidedPlan (issue #751, Phase 1). Sends only the recipe ID — the flow
// reads the recipe server-side via the Admin SDK — and receives the WHOLE PLAN
// DOCUMENT the flow has just written to `guidedPlans/{recipeId}`.
//
// THE FLOW HAS ALREADY PERSISTED IT by the time this resolves (issue #1416), which
// is what makes the plan survive a phone that locks during the one-to-three-minute
// call. Nothing here writes, and the caller's job is to show what came back rather
// than to save it.
//
// NEVER throws (Rule 10): a failure crosses as a Failure so the editor can leave
// the plan the user already has untouched and say so.
export async function callGenerateGuidedPlan(
  input: GenerateGuidedPlanInput,
): Promise<ReadResult<GenerateGuidedPlanOutput, DomainError>> {
  return callFunction<GenerateGuidedPlanInput, GenerateGuidedPlanOutput>({
    name: 'generateGuidedPlan',
    input,
    // Matches the function's declared 210 s (`cloud-functions/src/index.ts`),
    // which is in turn sized around the flow's 180 s `withAiTimeout`. Against the
    // callable client's 70 s DEFAULT the browser would give up long before either
    // — the wrapper finding B2-010 was originally filed against, and the reason
    // this option is set at all.
    //
    // The three numbers are one budget and the LOWEST GOVERNS, so this cannot be
    // lowered on its own: a shorter client timeout does not make the function
    // stop, it just means the person is told it failed while it goes on writing a
    // plan nobody will receive. Why the budget is this large — the flow's latency
    // scales with the number of steps in the recipe — is at GUIDED_PLAN_TIMEOUT
    // in `cloud-functions/src/flows/generateGuidedPlan.ts`.
    timeoutMs: 210_000,
  });
}
