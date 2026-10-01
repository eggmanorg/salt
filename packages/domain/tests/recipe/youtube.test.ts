import { describe, it, expect } from 'vitest';
import { parseYouTubeVideo } from '@salt/domain';

const ID = 'dQw4w9WgXcQ';
const WATCH = `https://www.youtube.com/watch?v=${ID}`;

describe('parseYouTubeVideo', () => {
  it.each([
    ['a watch link', `https://www.youtube.com/watch?v=${ID}`],
    ['a watch link with no www', `https://youtube.com/watch?v=${ID}`],
    [
      'a watch link whose v is not the first parameter',
      `https://www.youtube.com/watch?t=42&v=${ID}&list=PL1`,
    ],
    ['a short link', `https://youtu.be/${ID}`],
    ['a short link with a share tracker', `https://youtu.be/${ID}?si=abcDEF123`],
    ['a mobile watch link', `https://m.youtube.com/watch?v=${ID}`],
    ['a Short', `https://www.youtube.com/shorts/${ID}`],
    [
      'a Short with a trailing slash and tracker',
      `https://youtube.com/shorts/${ID}/?feature=share`,
    ],
    ['a live link', `https://www.youtube.com/live/${ID}`],
    ['an upper-case host', `https://WWW.YouTube.com/watch?v=${ID}`],
    ['a link with a fragment', `https://www.youtube.com/watch?v=${ID}#comments`],
    ['a query with a valueless parameter first', `https://www.youtube.com/watch?feature&v=${ID}`],
  ])('recognises %s and normalises it to the watch URL', (_label, url) => {
    expect(parseYouTubeVideo(url)).toEqual({ videoId: ID, watchUrl: WATCH });
  });

  it('stays linear on a pathological run of fragment marks (CodeQL js/polynomial-redos)', () => {
    const hostile = `https://www.youtube.com/watch?v=${ID}${'#\n'.repeat(50_000)}`;
    const start = Date.now();
    parseYouTubeVideo(hostile);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it.each([
    ['a channel', 'https://www.youtube.com/@SomeChef'],
    ['a legacy channel', 'https://www.youtube.com/channel/UC1234567890abcdefghij'],
    ['a playlist', 'https://www.youtube.com/playlist?list=PL1234567890'],
    ['the home page', 'https://www.youtube.com/'],
    ['a watch page with no id', 'https://www.youtube.com/watch?list=PL1'],
    ['a watch page with a malformed id', 'https://www.youtube.com/watch?v=short'],
    ['an id with a stray character', `https://youtu.be/${ID}!`],
    ['a short link with no id', 'https://youtu.be/'],
    ['a Shorts path with nothing after it', 'https://www.youtube.com/shorts/'],
    ['a look-alike host', `https://youtube.com.evil.example/watch?v=${ID}`],
    ['a different video site', `https://vimeo.com/${ID}`],
    ['an ordinary recipe page', 'https://example.com/recipes/ragu'],
    ['garbage', 'not a url'],
  ])('returns null for %s', (_label, url) => {
    expect(parseYouTubeVideo(url)).toBeNull();
  });
});
