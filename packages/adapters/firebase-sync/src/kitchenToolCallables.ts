import type { DomainError, ReadResult } from '@salt/shared-types';
import type { ProposeKitchenToolsInput, ProposeKitchenToolsOutput } from '@salt/domain/schemas';
import { callFunction } from './callFunction.js';

// proposeKitchenTools (issue #1458, Phase 2) — Salt's proposed answer for every
// word on /admin/kitchen-tools that the drawn vocabulary cannot name.
//
// THE ONLY CALLABLE THIS VOCABULARY HAS, and it reads. Every WRITE the
// kitchen-tools page performs is a plain client write with no function in front
// of it, deliberately (see `kitchenToolService.ts`'s commands block) — this one
// exists because an AI key cannot live in the browser, and it changes nothing
// about that: it returns a sentence for a person to press or ignore.
//
// NEVER throws (Rule 10). A failure crosses as a `Failure` and the caller does
// nothing with it: each row keeps the pure head-noun suggestion it was painted
// with, so a model that is down, slow or refusing costs the page nothing.
export async function callProposeKitchenTools(
  input: ProposeKitchenToolsInput,
): Promise<ReadResult<ProposeKitchenToolsOutput, DomainError>> {
  return callFunction<ProposeKitchenToolsInput, ProposeKitchenToolsOutput>({
    name: 'proposeKitchenTools',
    input,
    // Matches the function's declared 90 s (`cloud-functions/src/index.ts`),
    // which is in turn sized around the flow's 55 s `withAiTimeout`. Against the
    // callable client's 70 s DEFAULT the browser would give up first — harmless
    // here, since nothing is written and the page is already usable, but it
    // would report a failure for a call that was about to succeed.
    timeoutMs: 90_000,
  });
}
