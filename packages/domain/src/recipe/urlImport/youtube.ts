// Recognise a YouTube VIDEO link among the addresses the URL import is handed
// (issue #1637). Pure string parsing — no WHATWG `URL`, no I/O — for the same
// reason `parseImportUrl` beside it is (Rule 1).
//
// A recognised link is imported by handing the video itself to Gemini, which
// fetches it from YouTube, instead of fetching and reading the page. Anything on
// a YouTube host that is not one video (a channel, a playlist, the home page, a
// watch page with no id) returns null and takes the ordinary page path.

import { parseImportUrl } from './ssrf.js';

export interface YouTubeVideo {
  // The 11-character video id.
  readonly videoId: string;
  // The one canonical address for the video, whichever form it arrived in. This
  // is what the model is given and what the recipe's source link points at.
  readonly watchUrl: string;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORT_LINK_HOST = 'youtu.be';

// Path segments that carry the id directly: `/shorts/<id>`, `/live/<id>`.
const ID_IN_PATH = new Set(['shorts', 'live']);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Everything after the authority: the path, then the query without its `?`.
const PATH_AND_QUERY_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*([^?#]*)(?:\?([^#]*))?/;

// Recognises `youtube.com/watch?v=`, `youtu.be/`, `m.youtube.com/watch?v=`,
// `youtube.com/shorts/` and `youtube.com/live/`, and normalises each to
// `https://www.youtube.com/watch?v=<id>`. Returns null for anything else.
export function parseYouTubeVideo(raw: string): YouTubeVideo | null {
  const parsed = parseImportUrl(raw);
  if (parsed === null) return null;
  const host = parsed.hostname.toLowerCase();
  const m = PATH_AND_QUERY_RE.exec(parsed.href);
  const segments = (m?.[1] ?? '').split('/').filter((s) => s !== '');
  const query = m?.[2] ?? '';

  let id: string | null = null;
  if (host === SHORT_LINK_HOST) {
    if (segments.length === 1) id = segments[0]!;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === 'watch') {
      id = queryParam(query, 'v');
    } else if (segments.length === 2 && ID_IN_PATH.has(segments[0]!)) {
      id = segments[1]!;
    }
  }

  if (id === null || !VIDEO_ID_RE.test(id)) return null;
  return { videoId: id, watchUrl: `https://www.youtube.com/watch?v=${id}` };
}

// The first value of `name` in a raw query string. No percent-decoding: a video
// id is plain URL-safe characters, and an encoded one fails VIDEO_ID_RE anyway.
function queryParam(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq >= 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return null;
}
