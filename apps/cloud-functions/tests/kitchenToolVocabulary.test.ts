import { describe, expect, it } from 'vitest';
import {
  resolveKitchenTool,
  normaliseName,
  kitchenToolSlug,
  instanceNamedKitchenTools,
} from '@salt/domain';
import type { KitchenToolDoc } from '@salt/domain/schemas';

import { TOOLS } from '../scripts/kitchen-tool-vocabulary.mjs';
import { PRODUCTION_KIT_LABELS } from './support/productionKitLabels.js';

// Does the curated vocabulary actually name what our recipes ask for? (Issue
// #956.)
//
// The seed table is a hand-written list, and before this test the only way to
// know whether a row was pulling its weight was to read it and guess. That is how
// the vocabulary drifted: forty tools that named the objects a kitchen obviously
// has, against a library that had since asked for a rice cooker, a mandoline and
// a chinois — and, eleven times, a "large mixing bowl".
//
// So the table is measured, not reviewed, and it is measured THROUGH THE REAL
// RESOLVER. A second, test-flavoured notion of "does this match?" would let the
// table pass here and miss in the app, which is the one failure this file exists
// to make impossible. `resolveKitchenTool` is imported, never reimplemented.
//
// What it does NOT do is reach for Firestore. The labels are a committed snapshot
// (see the fixture's header) precisely so a red here means somebody changed the
// table, never that production moved overnight.

interface SeedTool {
  readonly id: string;
  readonly label: string;
  readonly matchers: readonly string[];
}

const SEED: readonly SeedTool[] = TOOLS as readonly SeedTool[];

/** The seed rows as the documents the seeder writes, which is what the resolver reads. */
const VOCABULARY: readonly KitchenToolDoc[] = SEED.map((tool) => ({
  id: tool.id,
  schemaVersion: 1,
  label: tool.label,
  matchers: [...tool.matchers],
  thumbnail: null,
  createdAt: '',
  updatedAt: '',
}));

// Labels the vocabulary is deliberately not drawing. EMPTY, and that is the
// point: every one of production's observed kit labels lands on a picture. A
// future label that genuinely should not be drawn goes here WITH A REASON beside
// it, so "we gave up on this one" can never be spelled the same way as "this
// still works".
const DELIBERATELY_UNRESOLVED: readonly string[] = [];

describe('the seeded kitchen-tool vocabulary', () => {
  it('names every kit label production has asked for', () => {
    const unresolved = PRODUCTION_KIT_LABELS.filter(
      ([label]) =>
        !DELIBERATELY_UNRESOLVED.includes(label) && resolveKitchenTool(label, VOCABULARY) === null,
    );
    // Reported as label+count rather than a bare boolean: a failure here is a
    // curation decision, and the person making it needs to see whether the gap is
    // one mention or eleven.
    expect(unresolved.map(([label, n]) => `${label} (x${n})`)).toEqual([]);

    // And the allow-list back the other way. An exemption whose label now
    // resolves — or that production stopped asking for — exempts nothing, and
    // says so nowhere: it just sits in the array reading like a live decision.
    // Nothing above can fail on it, because a dead entry only ever removes work
    // from the filter. This is the assertion that makes the list self-reporting,
    // and it is why the list can stay empty honestly rather than by nobody
    // looking.
    const stale = DELIBERATELY_UNRESOLVED.filter(
      (label) =>
        !PRODUCTION_KIT_LABELS.some(([l]) => l === label) ||
        resolveKitchenTool(label, VOCABULARY) !== null,
    );
    expect(stale).toEqual([]);
  });

  it('draws one object per real tool, not one per adjective', () => {
    const drawn = new Set(
      PRODUCTION_KIT_LABELS.map(([label]) => resolveKitchenTool(label, VOCABULARY)?.id),
    );
    // 88 spellings, 46 objects. The ceiling is what the defect was about: curating
    // this queue one row at a time would have minted a document and an AI-drawn
    // pictogram per SPELLING. Loosen it only with a measurement, never to make a
    // red go away.
    expect(drawn.size).toBeLessThanOrEqual(50);
    expect(drawn.size).toBeLessThan(PRODUCTION_KIT_LABELS.length / 1.5);
  });

  it('keeps the whole drawn vocabulary near the number of real kitchen objects', () => {
    // Every row is one Gemini image and one document. 64 = the 40 judged for #882
    // (twelve of them still speculative, kept on purpose) plus the 24 real objects
    // behind the 38 labels the original table could not name.
    expect(SEED.length).toBeLessThanOrEqual(65);
  });

  it('folds the whole bowl cluster onto one pictogram, minus the deliberate second bowl', () => {
    // The headline case, and the one prod's `large-mixing-bowl` document breaks by
    // shadowing: every adjective in front of "bowl" is the same drawing.
    for (const label of [
      'large mixing bowl',
      'mixing bowl',
      'medium mixing bowl',
      'large bowl',
      'serving bowl',
      'large serving bowl',
      'heatproof bowl',
      'large heatproof bowl',
      'pasta bowl',
      'bowl',
    ]) {
      expect(resolveKitchenTool(label, VOCABULARY)?.id, label).toBe('mixing-bowl');
    }
    // `Small bowl` is a second bowl ON PURPOSE — a ramekin is not a mixing bowl —
    // and longest-phrase-wins is what keeps it reachable.
    expect(resolveKitchenTool('small bowl', VOCABULARY)?.id).toBe('small-bowl');
  });

  it('keeps appliances that merely share a head noun apart', () => {
    // The reason the parent suggestion is advisory and the resolver has no
    // head-noun fallback: these four are not four sizes of one machine.
    expect(resolveKitchenTool('rice cooker', VOCABULARY)?.id).toBe('rice-cooker');
    expect(resolveKitchenTool('pressure cooker', VOCABULARY)?.id).toBe('pressure-cooker');
    expect(resolveKitchenTool('slow cooker', VOCABULARY)?.id).toBe('slow-cooker');
    expect(resolveKitchenTool('sous-vide precision cooker', VOCABULARY)?.id).toBe(
      'sous-vide-circulator',
    );
    expect(resolveKitchenTool('electric hand mixer', VOCABULARY)?.id).toBe('hand-mixer');
    expect(resolveKitchenTool('stand mixer', VOCABULARY)?.id).toBe('stand-mixer');
  });

  it('pins the blender cluster: stick blenders draw, jug/stand/plain blenders do not', () => {
    // Regression coverage for the PR #1052 review finding: `Stick blender` used to
    // carry a bare "blender" matcher, so ANY phrase containing the word — a jug
    // blender, a stand blender, a smoothie blender, even the bare noun on its own —
    // silently resolved to a stick-blender pictogram. That is the rule-1 failure
    // the cooker and mixer clusters above are already guarded against; this locks
    // the same guarantee onto blenders. Production has only ever asked for a stick
    // blender by three spellings, so a bare "blender" is deliberately left
    // UNRESOLVED rather than folded onto that row — see the comment on the
    // `stick-blender` entry for the reasoning.
    expect(resolveKitchenTool('stick blender', VOCABULARY)?.id).toBe('stick-blender');
    expect(resolveKitchenTool('immersion blender', VOCABULARY)?.id).toBe('stick-blender');
    expect(resolveKitchenTool('hand blender', VOCABULARY)?.id).toBe('stick-blender');
    // None of these name a stick blender, and none may resolve to one. (Some
    // still resolve to an unrelated tool through an incidental token match — e.g.
    // "jug blender" catches `Jug`'s bare "jug" — which is a property of the
    // resolver, not of the table: rule 2 itself is now enforced below, and the
    // 35 redundant matchers it once tolerated are gone. What THIS test guards is
    // that none of them silently becomes a stick blender.)
    expect(resolveKitchenTool('jug blender', VOCABULARY)?.id).not.toBe('stick-blender');
    expect(resolveKitchenTool('stand blender', VOCABULARY)?.id).not.toBe('stick-blender');
    expect(resolveKitchenTool('smoothie blender', VOCABULARY)?.id).not.toBe('stick-blender');
    expect(resolveKitchenTool('blender', VOCABULARY)).toBeNull();
  });

  it('keeps two other rule-1 splits from collapsing onto a near-duplicate row', () => {
    // `Salad spinner` and `Colander` are both round mesh-adjacent draining tools —
    // exactly the kind of pair a careless "fold it to make the coverage test pass"
    // edit would merge, and exactly the failure class finding 1 shipped as. Pinning
    // both sides means that edit fails loudly instead of shipping quiet.
    expect(resolveKitchenTool('salad spinner', VOCABULARY)?.id).toBe('salad-spinner');
    expect(resolveKitchenTool('colander', VOCABULARY)?.id).toBe('colander');
    expect(resolveKitchenTool('strainer', VOCABULARY)?.id).toBe('colander');
    // `Cake tin` and `Loaf tin` are the header's own named example of a same-head-
    // noun split ("cake tin vs loaf tin") — pin it the same way.
    expect(resolveKitchenTool('rectangular cake tin', VOCABULARY)?.id).toBe('cake-tin');
    expect(resolveKitchenTool('loaf tin', VOCABULARY)?.id).toBe('loaf-tin');
    expect(resolveKitchenTool('bread tin', VOCABULARY)?.id).toBe('loaf-tin');
  });

  it('gives every tool a distinct id', () => {
    const ids = SEED.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never spells one phrase twice, in a tool or across two', () => {
    // Two tools answering to the same normalised phrase is a coin toss decided by
    // table order, and a matcher repeating its own tool's label is dead weight the
    // admin page's `normaliseMatchers` would strip on the first edit — leaving the
    // seeded document and the edited one disagreeing about what the tool is called.
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const tool of SEED) {
      for (const phrase of [tool.label, ...tool.matchers]) {
        const key = normaliseName(phrase);
        expect(key, `${tool.id}: "${phrase}" normalises away entirely`).not.toBe('');
        const held = owner.get(key);
        if (held) collisions.push(`"${key}" on both ${held} and ${tool.id}`);
        else owner.set(key, tool.id);
      }
    }
    expect(collisions).toEqual([]);
  });

  // ─── The header's own rules, enforced (issue #956) ────────────────────────
  // `kitchen-tool-vocabulary.mjs` opens with four invariants stated as binding.
  // Three of them were checked by nothing, and one was broken 35 times in the
  // file that declares it — which trains the next editor to read the header as
  // decoration. These three tests are where those rules are now kept.

  it('gives every tool the id `kitchenToolSlug` would mint for its label', () => {
    // The id IS the Storage key (`kit-icons/{id}.webp`) and it is what the weekly
    // orphan sweep joins a drawing to a document by. A hand-shortened id here
    // passes every other assertion in this file, then slips past
    // `createKitchenTool`'s identical-slug `ConflictError` — because that command
    // mints `kitchenToolSlug(label)` while the seeder writes `tool.id` verbatim —
    // as a second document AND a second drawing. That is this issue's own defect,
    // re-entering through the table instead of the admin page.
    const mismatched = SEED.filter((tool) => tool.id !== kitchenToolSlug(tool.label)).map(
      (tool) => `${tool.id} should be ${kitchenToolSlug(tool.label)} (from "${tool.label}")`,
    );
    expect(mismatched).toEqual([]);
  });

  it('names the object, never the instance (rule 1)', () => {
    // Measured with the same pure query the prune script runs against production,
    // so a duplicate cannot be legal in the table and illegal in the collection.
    // `Small bowl` is the case that must NOT trip it: it contains `Mixing bowl`'s
    // matcher "bowl", not its label, and it is a deliberate second drawing.
    const instanceNamed = instanceNamedKitchenTools(VOCABULARY).map(
      ({ tool, parent }) => `${tool.id} is an instance of ${parent.id}`,
    );
    expect(instanceNamed).toEqual([]);

    // …and the assertion has teeth: the row production actually acquired is
    // caught. Proven against a fixture rather than by editing the real table,
    // which would leave this file passing for the wrong reason.
    const drifted: readonly KitchenToolDoc[] = [
      ...VOCABULARY,
      {
        id: 'large-mixing-bowl',
        schemaVersion: 1,
        label: 'Large mixing bowl',
        matchers: [],
        thumbnail: null,
        createdAt: '',
        updatedAt: '',
      },
    ];
    expect(
      instanceNamedKitchenTools(drifted).map(({ tool, parent }) => [tool.id, parent.id]),
    ).toEqual([['large-mixing-bowl', 'mixing-bowl']]);
  });

  it('carries no matcher that containment already covers (rule 2)', () => {
    // Rule 2's justification is a correctness one, not a style one: a redundant
    // matcher is dead weight that can also OUT-LENGTHEN a sibling and steal a
    // label from the tool that should win it. It was violated 35 times in the
    // file that declares it — 17 matchers containing their own tool's label, 18
    // covered by a shorter matcher on the same row — and removing all 35 changed
    // the resolution of none of the 88 fixture labels and left the drawing count
    // at 46. The rule is kept here rather than inside `normaliseMatchers`,
    // because that runs on every admin edit and would silently delete a phrase a
    // curator deliberately typed.
    //
    // A future entry needs a reason beside it, in the idiom of
    // `DELIBERATELY_UNRESOLVED` above.
    const DELIBERATELY_REDUNDANT: readonly string[] = [
      // Redundant under CONTAINMENT and load-bearing under the accessory rule
      // (issue #1465). `kitchenToolForKitLabel` refuses a single-word match for a
      // label that exactly names one of the manifest's accessories, and "Egg
      // Whisk" is one of the Magimix's — so the bare label "Whisk" no longer
      // answers for it and this phrase is what does. Rule 2's justification is
      // that a redundant matcher can out-length a sibling and steal a label; this
      // one can only ever win "egg whisk", which no other row claims.
      'whisk: egg whisk',
    ];

    const covers = (phrase: string, by: string) => ` ${phrase} `.includes(` ${by} `);
    // Every violation found, exempt or not. Filtering the allow-list out inside
    // the loop is what made a dead exemption invisible: it can only ever remove
    // a row from `redundant`, so no assertion could ever notice it.
    const violations = new Set<string>();
    const redundant: string[] = [];
    for (const tool of SEED) {
      const label = normaliseName(tool.label);
      const matchers = tool.matchers.map((raw) => ({ raw, phrase: normaliseName(raw) }));
      for (const { raw, phrase } of matchers) {
        const key = `${tool.id}: ${raw}`;
        const exempt = DELIBERATELY_REDUNDANT.includes(key);
        if (covers(phrase, label)) {
          violations.add(key);
          if (!exempt) {
            redundant.push(
              `${tool.id}: "${raw}" — its own label "${tool.label}" is already inside it`,
            );
          }
          continue;
        }
        // A shorter matcher on the same row already answers everything this one
        // does. Strictly shorter, so an exact repeat is the other hygiene test's
        // business and neither entry accuses the other.
        const sibling = matchers.find(
          (other) => other.phrase.length < phrase.length && covers(phrase, other.phrase),
        );
        if (sibling) {
          violations.add(key);
          if (!exempt) {
            redundant.push(`${tool.id}: "${raw}" — the shorter "${sibling.raw}" already covers it`);
          }
        }
      }
    }
    expect(redundant).toEqual([]);

    // The allow-list read back the other way, as above: an entry that no longer
    // names a live violation — its matcher edited, its row deleted, the rule
    // since satisfied — is dead weight that reads like a standing decision.
    expect(DELIBERATELY_REDUNDANT.filter((key) => !violations.has(key))).toEqual([]);
  });
});
