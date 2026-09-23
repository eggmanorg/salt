import { z } from 'zod';
import { KitchenToolSchema } from './kitchenTool.js';

// proposeKitchenTools (issue #1458, Phase 2) — Salt's own answer to each word the
// drawn vocabulary cannot name.
//
// The rows are #1489 Phase 3's: `unresolvedKitLabels` says which words our own
// recipes and plans used that nothing draws, and each row already carries the
// pure head-noun suggestion from `suggestKitchenToolParent`. This flow adds a
// SENTENCE to those rows and nothing else. It writes nothing, it mints nothing,
// and there is no arm of it that a person does not press.
//
// ONE CALL FOR THE WHOLE QUEUE, not one per row, and that is the shape rather
// than an optimisation. The expensive manual judgement here is GROUPING — that
// "large mixing bowl", "mixing bowl" and "Large Bowls" are one object — and a
// model shown one word at a time cannot make it. It is also what keeps the cost
// of opening an admin page to a single `fast` call instead of a dozen.
//
// NOT THE CANON PIPELINE, in any direction (docs/canon-icons.md § "The fourth
// family"). No embeddings, no `findClosestMatch`, no arbitration, no
// `needs_approval` document. The vocabulary stays curated and closed: the model
// proposes, a person writes.
// The two deadlines the CF and the callable wrapper share, so they cannot drift
// (proposeSchedule's precedent). The AI budget is the CF's `AI_TEXT_FLOW_TIMEOUT`
// (55 s), and the order is load-bearing:
//
//   AI budget (55 s) < client (80 s) < function (90 s)
//
// The client outlasts the model call so a working answer is not abandoned, and
// must exceed the callable SDK's 70 s default, which is why the wrapper passes
// one at all. The function outlasts the client so it is never cut off from under
// a browser that is still listening.
export const PROPOSE_KITCHEN_TOOLS_TIMEOUT_SECONDS = 90;
export const PROPOSE_KITCHEN_TOOLS_CLIENT_TIMEOUT_MS = 80_000;

export const ProposeKitchenToolsInputSchema = z.object({
  // The words to answer for — the gap rows as the page has them. Sent verbatim
  // so the answers can be matched back to the rows they belong to.
  labels: z.array(z.string()),
  // The whole drawn vocabulary, as documents. The full `KitchenToolDoc` rather
  // than a trimmed `{ id, label, matchers }` projection because the server side
  // resolves the model's answer back through `resolveKitchenTool`, which takes
  // documents — and a projection would mean either a second matching rule or a
  // fabricated document to feed the first one. The caller already holds these.
  tools: z.array(KitchenToolSchema),
});

export type ProposeKitchenToolsInput = z.infer<typeof ProposeKitchenToolsInputSchema>;

/** The three answers a word can have. Nothing else is a proposal. */
export const KITCHEN_TOOL_PROPOSAL_KINDS = ['alias', 'new', 'not-kit'] as const;

// What the MODEL emits — flat and nullable, because a discriminated union is a
// poor thing to ask a model for and a bad thing to hand Genkit's JSON-schema
// generator. Everything here is untrusted: the trust boundary is
// `sanitiseKitchenToolProposals`, which is what turns this into the shape below.
export const KitchenToolProposalAISchema = z.object({
  /** The word being answered for, echoed back from `labels`. */
  label: z.string(),
  kind: z.enum(KITCHEN_TOOL_PROPOSAL_KINDS),
  /** For `alias`: the id of the tool it belongs to. Null otherwise. */
  toolId: z.string().nullable().default(null),
  /** For `new`: what the tool should be called. Null otherwise. */
  suggestedLabel: z.string().nullable().default(null),
});

export const ProposeKitchenToolsAIOutputSchema = z.object({
  proposals: z.array(KitchenToolProposalAISchema),
});

export type KitchenToolProposalAI = z.infer<typeof KitchenToolProposalAISchema>;

// What the CALLABLE returns — a discriminated union, so "an alias always names a
// tool" and "a new tool always has a name" are carried by the type rather than
// by a comment the renderer has to remember. Membership of `toolId` in the
// vocabulary that was sent is a separate claim and is pinned by test, not by
// this schema.
export const KitchenToolProposalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('alias'), label: z.string(), toolId: z.string() }),
  z.object({ kind: z.literal('new'), label: z.string(), suggestedLabel: z.string() }),
  z.object({ kind: z.literal('not-kit'), label: z.string() }),
]);

export const ProposeKitchenToolsOutputSchema = z.object({
  proposals: z.array(KitchenToolProposalSchema),
});

export type KitchenToolProposal = z.infer<typeof KitchenToolProposalSchema>;
export type ProposeKitchenToolsOutput = z.infer<typeof ProposeKitchenToolsOutputSchema>;
