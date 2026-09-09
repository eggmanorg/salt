import { failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import { ChefChatOutputSchema } from '@salt/domain/schemas';
import type {
  ChefChatInput,
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
// fragment as it arrives. The returned promise resolves to the full reply text
// once the stream is complete, or a Failure on error.
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
): Promise<ReadResult<string, DomainError>> {
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
    // `ChefChatOutputSchema` is `z.string()` again (#1310), so the only thing
    // this rejects is a function that is not returning prose.
    //
    // Deploy skew, and only for the minutes a rollout takes: a browser still on
    // the #1303 bundle parses this reverted function's bare string against the
    // object schema, fails, and shows one StorageError for that turn. Nothing is
    // written and re-sending fixes it. The dangerous direction — a client
    // writing an object into `message.text` — cannot happen against a function
    // returning a string; the documents #1303 already created are repaired on
    // READ by `unwrapWrappedReply` in `@salt/domain/schemas`.
    const parsed = ChefChatOutputSchema.safeParse(await data);
    if (!parsed.success) {
      return failure({ kind: 'StorageError', reason: 'corruption' });
    }
    return success(parsed.data);
  } catch (err) {
    return failure(classifyCallableError(err));
  }
}
