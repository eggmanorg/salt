import { describe, it, expect } from 'vitest';
import { pickPlaceholder, PLACEHOLDER_MOODS, emptyRecipe } from '@salt/domain';
import type { PlaceholderMood, Recipe, RecipeKind } from '@salt/domain';
import type { WeatherDaySummary } from '@salt/domain/schemas';

// Which picture a note-only planner night gets (issue #652). The season leads
// because it is known for every day; a decisive forecast overrides it; the hash
// picks within the mood so a week varies and never reshuffles.

const HERO = { url: 'https://example.test/hero.webp', source: 'ai' } as const;

function entry(id: string, kind: RecipeKind, tags: string[] = []): Recipe {
  const base = emptyRecipe(id, '2026-01-01T00:00:00.000Z');
  return { ...base, kind, image: { ...HERO }, metadata: { ...base.metadata, tags } };
}

function placeholders(mood: PlaceholderMood, count: number): Recipe[] {
  return Array.from({ length: count }, (_, i) => entry(`ph-${mood}-${i}`, 'placeholder', [mood]));
}

// A summary at a given feels-like temperature, with the secondary signals sat
// squarely in the middle so only the temperature can decide anything. `rain` is
// the one dial a test may turn on its own — it drives the `wet` refinement.
function evening(apparentTemp: number, rain = 20): WeatherDaySummary {
  return {
    tempHigh: apparentTemp + 1,
    tempLow: apparentTemp - 1,
    apparentTemp,
    humidity: 65,
    cloudCover: 55,
    precipitationChance: rain,
  };
}

const LIBRARY = [...placeholders('bright', 5), ...placeholders('comfort', 5)];

// Which mood a returned id belongs to — the assertion every season/weather test
// actually cares about.
function moodOf(id: string | null): PlaceholderMood | null {
  if (id === null) return null;
  return id.includes('bright') ? 'bright' : 'comfort';
}

describe('pickPlaceholder — the mood constants', () => {
  it('exports exactly the two moods the library is built in', () => {
    expect([...PLACEHOLDER_MOODS]).toEqual(['bright', 'comfort']);
  });
});

describe('pickPlaceholder — season', () => {
  it('reads April through September as bright', () => {
    for (const month of ['04', '05', '06', '07', '08', '09']) {
      expect(moodOf(pickPlaceholder(LIBRARY, `2026-${month}-15`))).toBe('bright');
    }
  });

  it('reads October through March as comfort', () => {
    for (const month of ['10', '11', '12', '01', '02', '03']) {
      expect(moodOf(pickPlaceholder(LIBRARY, `2026-${month}-15`))).toBe('comfort');
    }
  });

  it('flips exactly at the boundary days, not near them', () => {
    // The four days the six/six split turns on. A boundary that drifted a month
    // would be invisible in the middle-of-the-month cases above.
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-03-31'))).toBe('comfort');
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-04-01'))).toBe('bright');
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-09-30'))).toBe('bright');
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-10-01'))).toBe('comfort');
  });
});

describe('pickPlaceholder — weather override', () => {
  it('a cold June evening overrides the season to comfort', () => {
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-06-15'))).toBe('bright');
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-06-15', evening(9)))).toBe('comfort');
  });

  it('a warm October evening overrides the season to bright', () => {
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-10-15'))).toBe('comfort');
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-10-15', evening(24)))).toBe('bright');
  });

  it('an unremarkable evening leaves the season standing, both ways', () => {
    // 17° with middling humidity, cloud and rain chance is the ambiguous band —
    // the forecast has no opinion, so the season keeps the one it had.
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-06-15', evening(17)))).toBe('bright');
    expect(moodOf(pickPlaceholder(LIBRARY, '2026-10-15', evening(17)))).toBe('comfort');
  });

  it('changes nothing when the forecast agrees with the season', () => {
    expect(pickPlaceholder(LIBRARY, '2026-06-15', evening(24))).toBe(
      pickPlaceholder(LIBRARY, '2026-06-15'),
    );
    expect(pickPlaceholder(LIBRARY, '2026-12-15', evening(4))).toBe(
      pickPlaceholder(LIBRARY, '2026-12-15'),
    );
  });
});

describe('pickPlaceholder — the empty set', () => {
  it('returns null before any placeholder has been built', () => {
    // The whole of this feature's behaviour until the library exists: the day
    // stays a block of text.
    expect(pickPlaceholder([], '2026-06-15')).toBeNull();
  });

  it('returns null when only the OTHER mood has entries', () => {
    // Deliberately does not fall back across moods — a summer evening would
    // rather stay a text block than wear a lamplit winter photograph.
    const brightOnly = placeholders('bright', 5);
    expect(pickPlaceholder(brightOnly, '2026-06-15')).not.toBeNull();
    expect(pickPlaceholder(brightOnly, '2026-12-15')).toBeNull();
  });

  it('ignores every other kind of entry, however it is tagged', () => {
    const decoys = [
      entry('r-1', 'recipe', ['bright']),
      entry('o-1', 'special', ['bright']),
      entry('c-1', 'cocktail', ['bright']),
    ];
    expect(pickPlaceholder(decoys, '2026-06-15')).toBeNull();
  });

  it('ignores a placeholder carrying neither mood tag', () => {
    expect(pickPlaceholder([entry('ph-untagged', 'placeholder', ['summer'])], '2026-06-15')).toBe(
      null,
    );
  });

  it('matches a mood tag regardless of case and surrounding space', () => {
    const sloppy = [entry('ph-sloppy', 'placeholder', ['  Bright '])];
    expect(pickPlaceholder(sloppy, '2026-06-15')).toBe('ph-sloppy');
  });
});

describe('pickPlaceholder — condition tags rank, they do not filter', () => {
  // Temperatures sit on `classifyEatingMood`'s poles in these tests so the MOOD is
  // pinned and only the condition under test is in play — otherwise a high rain
  // chance would itself drag the mood and confuse what is being asserted.

  // How often each picture wins across a long run of days, which is the only
  // honest way to assert on a ranking: any single day is just one hash.
  function tally(library: Recipe[], weather?: WeatherDaySummary): Map<string, number> {
    const counts = new Map<string, number>();
    // A full year of December-through-February keys, so a share is a share and not
    // the variance of a 28-day sample.
    for (let year = 2026; year <= 2035; year++) {
      for (const month of ['12', '01', '02']) {
        for (let day = 1; day <= 28; day++) {
          const dateKey = `${year}-${month}-${String(day).padStart(2, '0')}`;
          const picked = pickPlaceholder(library, dateKey, weather);
          if (picked !== null) counts.set(picked, (counts.get(picked) ?? 0) + 1);
        }
      }
    }
    return counts;
  }

  const TOTAL_DAYS = 10 * 3 * 28;

  it('a matching tag improves the odds without ever guaranteeing the pick', () => {
    const wet = entry('ph-comfort-wet', 'placeholder', ['comfort', 'wet']);
    const library = [...placeholders('comfort', 9), wet];

    const rainy = tally(library, evening(5, 80));
    const dry = tally(library, evening(5, 10));

    // It wins more often in the rain than out of it…
    expect(rainy.get('ph-comfort-wet') ?? 0).toBeGreaterThan(dry.get('ph-comfort-wet') ?? 0);
    // …but it does NOT own every rainy evening, and the whole library is still in
    // use. This is the property a filter-based design got wrong: one tagged
    // picture became the answer to every rainy day.
    expect(rainy.get('ph-comfort-wet') ?? 0).toBeLessThan(TOTAL_DAYS / 2);
    expect(rainy.size).toBe(10);
  });

  it('the more pictures carry a tag, the more often that kind shows up', () => {
    // The gradient the whole scheme exists for: make more of a kind and that kind
    // appears more, with no threshold to cross.
    const share = (wetCount: number): number => {
      const wets = Array.from({ length: wetCount }, (_, i) =>
        entry(`ph-comfort-wet-${i}`, 'placeholder', ['comfort', 'wet']),
      );
      const counts = tally([...placeholders('comfort', 9), ...wets], evening(5, 80));
      return [...counts].reduce((n, [id, c]) => (id.includes('wet') ? n + c : n), 0);
    };

    expect(share(1)).toBeLessThan(share(3));
    expect(share(3)).toBeLessThan(share(6));
  });

  it('scores every matching condition, so a closer match outranks a partial one', () => {
    const both = entry('ph-comfort-both', 'placeholder', ['comfort', 'wet', 'cold']);
    const one = entry('ph-comfort-one', 'placeholder', ['comfort', 'wet']);
    // A freezing, soaking, grey evening: tempHigh 2 → cold, rain 80 → wet.
    const counts = tally([both, one, ...placeholders('comfort', 9)], {
      ...evening(2, 80),
      tempHigh: 2,
      cloudCover: 90,
    });
    expect(counts.get('ph-comfort-both') ?? 0).toBeGreaterThan(counts.get('ph-comfort-one') ?? 0);
  });

  it('never lets conditions cross the mood boundary', () => {
    // A warm, wet August evening is bright AND wet — the case two moods alone
    // could not express. It must still never reach for a comfort picture.
    const library = [
      ...placeholders('bright', 5),
      entry('ph-bright-wet', 'placeholder', ['bright', 'wet']),
      entry('ph-comfort-wet', 'placeholder', ['comfort', 'wet']),
    ];
    for (let day = 1; day <= 28; day++) {
      const picked = pickPlaceholder(library, `2026-08-${String(day).padStart(2, '0')}`, {
        ...evening(24, 80),
        tempHigh: 24,
      });
      expect(picked).not.toBe('ph-comfort-wet');
    }
  });

  it('changes nothing when no picture carries the condition', () => {
    const library = placeholders('comfort', 5);
    expect(pickPlaceholder(library, '2026-12-15', evening(5, 80))).toBe(
      pickPlaceholder(library, '2026-12-15', evening(5, 10)),
    );
  });

  it('uses the WHOLE library when there is no forecast to weight by', () => {
    // Every picture weighs the same, so this is a plain uniform draw — and all
    // twelve must be reachable, not just a favoured few.
    const counts = tally(placeholders('comfort', 12));
    expect(counts.size).toBe(12);
  });
});

describe('pickPlaceholder — placeholders with no hero', () => {
  it('never picks a placeholder whose image is null', () => {
    // A failed generation leaves `image: null`, which parses perfectly well — so
    // without this guard the night would get a card with no photograph, which is
    // worse than the text it replaced.
    const heroless = { ...entry('ph-comfort-broken', 'placeholder', ['comfort']), image: null };
    expect(pickPlaceholder([heroless], '2026-12-15')).toBeNull();
  });

  it('picks from the rest of the mood when one entry is heroless', () => {
    const heroless = { ...entry('ph-comfort-broken', 'placeholder', ['comfort']), image: null };
    const library = [...placeholders('comfort', 5), heroless];
    const picked = pickPlaceholder(library, '2026-12-15');
    expect(picked).not.toBeNull();
    expect(picked).not.toBe('ph-comfort-broken');
  });

  it('does not let a heroless entry rank at all', () => {
    // The nastiest version: the broken document is the best-matching one, so it
    // would top the ranking and hand rainy nights a blank card.
    const heroless = {
      ...entry('ph-comfort-broken', 'placeholder', ['comfort', 'wet']),
      image: null,
    };
    const library = [...placeholders('comfort', 5), heroless];
    for (let day = 1; day <= 28; day++) {
      const picked = pickPlaceholder(library, `2026-12-${String(day).padStart(2, '0')}`, {
        ...evening(5, 80),
        tempHigh: 5,
      });
      expect(picked).not.toBeNull();
      expect(picked).not.toBe('ph-comfort-broken');
    }
  });
});

describe('pickPlaceholder — determinism', () => {
  it('gives the same day the same picture every time it is asked', () => {
    const first = pickPlaceholder(LIBRARY, '2026-06-15');
    for (let i = 0; i < 20; i++) {
      expect(pickPlaceholder(LIBRARY, '2026-06-15')).toBe(first);
    }
  });

  it('does not depend on the order the caller holds the recipes in', () => {
    const shuffled = [...LIBRARY].reverse();
    expect(pickPlaceholder(shuffled, '2026-06-15')).toBe(pickPlaceholder(LIBRARY, '2026-06-15'));
  });

  it('varies across a week rather than repeating one picture', () => {
    const week = [
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21',
    ];
    const picked = week.map((day) => pickPlaceholder(LIBRARY, day));
    // Seven days over a five-image set must collide somewhere — what matters is
    // that the week reads as varied rather than as one photograph repeated.
    expect(new Set(picked).size).toBeGreaterThanOrEqual(4);
    expect(picked.every((id) => id !== null)).toBe(true);
  });

  it('is pure — does not mutate the list it is given', () => {
    const list = [...LIBRARY];
    pickPlaceholder(list, '2026-06-15');
    expect(list).toEqual(LIBRARY);
  });
});
