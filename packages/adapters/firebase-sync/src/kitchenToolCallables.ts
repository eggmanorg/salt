import type { DomainError, ReadResult } from '@salt/shared-types';
import {
  PROPOSE_KITCHEN_TOOLS_CLIENT_TIMEOUT_MS,
  type ProposeKitchenToolsInput,
  type ProposeKitchenToolsOutput,
} from '@salt/domain/schemas';
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
    // Past the callable client's 70 s DEFAULT, which the flow's 55 s AI budget
    // plus a cold start can exceed — harmless if cut short, since nothing is
    // written, but it would report a failure for a call about to succeed. The
    // order against the function's deadline is at the constant.
    timeoutMs: PROPOSE_KITCHEN_TOOLS_CLIENT_TIMEOUT_MS,
  });
}
