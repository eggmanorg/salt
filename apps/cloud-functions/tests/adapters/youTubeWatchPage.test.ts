import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseYouTubeWatchPage } from '../../src/adapters/youTubeWatchPage.js';

// Issue #1637, Phase 2. `youtube-watch-page.html` is a real watch page fetched
// 2026-09-29 from a UK connection, trimmed to its three inline scripts that
// mention `ytInitialPlayerResponse` (in their original order) and with the player
// response cut down to `playabilityStatus` + `videoDetails` — which drops the
// stream URLs, and the requester's IP they carry.

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const WATCH_PAGE = fixture('youtube-watch-page.html');
const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeWatchPage', () => {
  it('reads the description and length off a real watch page', () => {
    const page = parseYouTubeWatchPage(WATCH_PAGE, ID);

    expect(page?.lengthSeconds).toBe(213);
    expect(page?.description).toMatch(/^The official video for “Never Gonna Give You Up”/);
  });

  it('answers null for a consent page, which carries no player response', () => {
    expect(parseYouTubeWatchPage(fixture('youtube-consent-page.html'), ID)).toBeNull();
  });

  it('answers null for a page truncated inside the player response', () => {
    const at = WATCH_PAGE.indexOf('"shortDescription"');
    expect(at).toBeGreaterThan(0);

    expect(parseYouTubeWatchPage(WATCH_PAGE.slice(0, at), ID)).toBeNull();
  });

  it('answers null for garbage', () => {
    expect(parseYouTubeWatchPage('\u0000<<not html>>{', ID)).toBeNull();
    expect(
      parseYouTubeWatchPage('var ytInitialPlayerResponse = {"videoDetails": 5};', ID),
    ).toBeNull();
    expect(parseYouTubeWatchPage('var ytInitialPlayerResponse = {not json};', ID)).toBeNull();
  });

  it('refuses a page served for a DIFFERENT video', () => {
    expect(parseYouTubeWatchPage(WATCH_PAGE, 'aaaaaaaaaaa')).toBeNull();
  });

  it('keeps whichever half is usable when the other is not', () => {
    const page = (details: object): string =>
      `<script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { videoId: ID, ...details } })};</script>`;

    expect(
      parseYouTubeWatchPage(page({ shortDescription: '200g flour', lengthSeconds: 'soon' }), ID),
    ).toEqual({
      description: '200g flour',
      lengthSeconds: null,
    });
    expect(parseYouTubeWatchPage(page({ lengthSeconds: '2700' }), ID)).toEqual({
      description: null,
      lengthSeconds: 2700,
    });
    expect(
      parseYouTubeWatchPage(page({ shortDescription: '  \n ', lengthSeconds: '60' }), ID),
    ).toEqual({
      description: null,
      lengthSeconds: 60,
    });
  });

  it('is not fooled by braces and quotes inside the description', () => {
    const description = 'Sauce {base} — "the good stuff" \\ }}} {';
    const html = `<script>var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: ID, shortDescription: description, lengthSeconds: '90' },
    })};var meta = {"x":1};</script>`;

    expect(parseYouTubeWatchPage(html, ID)).toEqual({ description, lengthSeconds: 90 });
  });
});
