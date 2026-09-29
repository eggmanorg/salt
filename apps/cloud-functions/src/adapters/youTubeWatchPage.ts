import { z } from 'genkit';

// Read a YouTube watch page for the two things the video import wants from it
// (issue #1637, Phase 2): the creator's written description, where cooks often
// put the exact amounts, and the video's length, so an over-long video can be
// refused before any model call.
//
// Both live in the `ytInitialPlayerResponse` object YouTube assigns in an inline
// `<script>`. This must run on the RAW page: the HTML fallback's noise stripper
// deletes every `<script>` wholesale.
//
// UNTRUSTED input and a third-party shape (a trust boundary): the object is
// located by a dependency-free scan, `JSON.parse`d defensively and validated with
// Zod (`safeParse`), like jsonLdRecipe. Internal to cloud-functions under the
// #932 carve-out for third-party response parsers. Never throws: a consent wall,
// a shape change or a truncated page all answer null, and the caller carries on
// with the video alone.

export interface YouTubeWatchPage {
  // The creator's description, or null when it is absent or blank.
  readonly description: string | null;
  // The video's length, or null when the page does not state a usable one.
  readonly lengthSeconds: number | null;
}

// Only the two fields read, plus the id they must belong to. Each read field
// degrades to null on its own, so a page with a description but an odd length
// (or the reverse) still yields the half it has.
const PlayerResponseSchema = z.object({
  videoDetails: z.object({
    videoId: z.string(),
    shortDescription: z
      .string()
      .transform((s) => (s.trim().length > 0 ? s : null))
      .nullish()
      .catch(null),
    lengthSeconds: z.string().regex(/^\d+$/).transform(Number).nullish().catch(null),
  }),
});

const ASSIGNMENT_RE = /\bytInitialPlayerResponse\s*=\s*\{/g;

// Parse the page served for `videoId`. The id check matters because the page
// arrives after redirects: a watch page for some OTHER video must not lend this
// one its description or its length.
export function parseYouTubeWatchPage(html: string, videoId: string): YouTubeWatchPage | null {
  for (const m of html.matchAll(ASSIGNMENT_RE)) {
    const json = balancedObjectAt(html, m.index + m[0].length - 1);
    if (json === null) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      continue;
    }
    const parsed = PlayerResponseSchema.safeParse(raw);
    if (!parsed.success) continue;
    const details = parsed.data.videoDetails;
    if (details.videoId !== videoId) return null;
    return {
      description: details.shortDescription ?? null,
      lengthSeconds: details.lengthSeconds ?? null,
    };
  }
  return null;
}

// The JSON object text starting at `start` (a `{`), found by counting braces
// outside string literals. Null when the text ends first — a truncated page.
function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
