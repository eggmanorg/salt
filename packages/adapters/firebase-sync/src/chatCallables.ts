import { failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import { ChefChatOutputSchema } from '@salt/domain/schemas';
import type {
  ChefChatInput,
  ChefChatOutput,
  GenerateChatTitleInput,
  GenerateChatTitleOutput,
} from '@salt/domain/schemas';
import { classifyCallableError } from './callableErrors.js';
import { callableRef, callFunction } from './callFunction.js';

export async function callGenerateChatTitle(
  userMessage: string,
  assistantResponse: string,
): Promise<ReadResult<string, DomainError>> {
  return callFunction<GenerateChatTitleInput, GenerateChatTitleOutput>({
    name: 'generateChatTitle',
    input: { userMessage, assistantResponse },
  });
}

// Streams the chef's reply chunk-by-chunk. onChunk is called for each text
// fragment as it arrives. The returned promise resolves to the finished turn —
// the whole reply text plus what the chef declared it offered (#1299) — or a
// Failure on error.
//
// Note the asymmetry, and that it is deliberate: the CHUNKS are still strings.
// Only the resolved value carries the declaration, so the streaming render is
// exactly what it was.
//
// THE ONE WRAPPER THAT IS STILL HAND-WRITTEN, and it takes only the transport
// from `callableRef`. `callFunction` awaits one answer; this awaits a sequence,
// and the drain loop below is the whole point of the function — chunks reach the
// caller AS THEY ARRIVE, which is what a reader needs to see. A helper that hid
// the loop would save four lines and cost the only interesting thing here.
// Region, name and the absent timeout still come from the one place.
export async function streamChefChat(
  input: ChefChatInput,
  onChunk: (chunk: string) => void,
): Promise<ReadResult<ChefChatOutput, DomainError>> {
  try {
    // `chefChat` declares 120 s (`cloud-functions/src/index.ts:559`). The
    // callable client's default is 70, and this is a STREAM: the browser used to
    // abandon a long reply mid-flow, so the user watched an answer stop
    // half-written.
    const fn = callableRef<ChefChatInput, unknown, string>('chefChat', 120_000);
    const { stream, data } = await fn.stream(input);
    for await (const chunk of stream) {
      onChunk(chunk);
    }
    // A callable's answer arrives as `unknown`, which is a type-laundering
    // boundary by the Zod conventions — so it is parsed rather than cast, and
    // maps to StorageError for the reason `imagePromptCallables.ts` states: a
    // shape mismatch is a corruption, not a network blip, and is reported.
    //
    // `offered` carries `.default([])`, so a turn where the chef declared
    // nothing parses fine. What does NOT parse is a browser on a new bundle
    // talking to a Cloud Function deployed before #1299, which returns a bare
    // string — a deploy-skew window of minutes, and one the user is told about
    // rather than shown a reply assembled out of `undefined`.
    //
    // THE OTHER SKEW DIRECTION IS THE DANGEROUS ONE, and nothing here can reach
    // it: a browser on the PRE-#1299 bundle does not run this code at all, does
    // not parse, and writes the whole `{ text, offered }` object into
    // `message.text`. That document is caught on READ, by `MessageSchema` in
    // `@salt/domain/schemas` — see the comment on `unwrapWrappedReply` there for
    // why it has to be the read path and why it has to live in the domain.
    const parsed = ChefChatOutputSchema.safeParse(await data);
    if (!parsed.success) {
      return failure({ kind: 'StorageError', reason: 'corruption' });
    }
    return success(parsed.data);
  } catch (err) {
    return failure(classifyCallableError(err));
  }
}
