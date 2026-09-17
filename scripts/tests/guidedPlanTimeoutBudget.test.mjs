/**
 * Source guard for the guided plan's THREE-PART TIMEOUT BUDGET.
 *
 * Writing a guided plan is the slowest thing the app asks a model to do: a note
 * for every step of the recipe, so the latency scales with the length of the
 * method. Three separate deadlines sit in series over that one call, in three
 * files, in two packages:
 *
 *   flow      GUIDED_PLAN_TIMEOUT  apps/cloud-functions/src/flows/generateGuidedPlan.ts
 *   function  timeoutSeconds       apps/cloud-functions/src/index.ts
 *   client    timeoutMs            packages/adapters/firebase-sync/src/guidedPlanCallables.ts
 *
 * THE LOWEST OF THE THREE GOVERNS, and each is invisible from the other two. All
 * three comments say so in prose and — before this file — nothing enforced it.
 * That is the defect class hard rule 12 names: a safety property asserted in a
 * header comment and guaranteed by nothing.
 *
 * The failure it guards is not hypothetical and not symmetric:
 *
 *   • flow > function — the runtime kills the invocation mid-write, so the guard
 *     that exists to turn a stall into a clean error never fires and the caller
 *     gets a socket error instead.
 *   • client < function — the browser reports "Couldn't write the plan" while the
 *     function runs happily on and finishes a plan nobody will ever receive. This
 *     one has already shipped once (finding B2-010, when the client used the
 *     callable SDK's 70s default against a 90s function).
 *
 * It shipped as a total production outage in the other direction too: a 55s flow
 * budget against work measured at 47–103s meant EVERY attempt failed. So the
 * floor below is as load-bearing as the ordering — it is what stops a future edit
 * quietly returning the budget to a number smaller than the job.
 *
 * ── Why it lives in `scripts/tests` ──────────────────────────────────────────
 *
 * It belongs to neither package it checks. A copy in `apps/cloud-functions`
 * would have to reach the client's value through `../../../packages/…`, which is
 * UT-E4's path escape, pinned at 0 in every area; and it cannot get there by
 * specifier instead, because `cloud-functions` importing `firebase-sync` is a
 * Rule 2 layer violation that `depcruise` would reject outright. Splitting the
 * assertion in two — flow↔function here, client↔function there — would leave the
 * coupling unguarded at exactly the seam that broke. So the guard sits at the
 * repo level, beside the other cross-cutting guards, and reads all three as
 * BYTES. It imports nothing it checks, which is also why no layer rule applies.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

const FLOW_FILE = 'apps/cloud-functions/src/flows/generateGuidedPlan.ts';
const INDEX_FILE = 'apps/cloud-functions/src/index.ts';
const CLIENT_FILE = 'packages/adapters/firebase-sync/src/guidedPlanCallables.ts';

/** Numeric literals are written with `_` separators in this repo. */
const num = (raw) => Number(raw.replace(/_/g, ''));

function extract(label, src, re) {
  const captured = src.match(re)?.[1];
  // A miss means the declaration was renamed or restructured, NOT that the
  // budget is fine. Fail loudly rather than skipping the assertion — a guard
  // that silently stops looking is the #915 blind spot one level up.
  expect(captured, `${label}: could not find the declaration this guard reads`).toBeDefined();
  return num(captured ?? '');
}

const flowMs = extract(
  'flow',
  read(FLOW_FILE),
  /GUIDED_PLAN_TIMEOUT\s*=\s*\{[^}]*timeoutMs:\s*([\d_]+)/,
);

const indexSrc = read(INDEX_FILE);
const functionMs =
  extract(
    'function',
    // Scoped to the generateGuidedPlan export, so a neighbouring callable's
    // timeoutSeconds can never be read here by mistake.
    indexSrc.slice(indexSrc.indexOf('export const generateGuidedPlan = onCallGenkit(')),
    /timeoutSeconds:\s*([\d_]+)/,
  ) * 1000;

const clientMs = extract('client', read(CLIENT_FILE), /timeoutMs:\s*([\d_]+)/);

describe('guided plan: the three timeouts are one budget', () => {
  it('reads a real number out of each of the three files', () => {
    // Independent floor: if a regex above ever matched something degenerate, the
    // ordering assertions could pass vacuously on zeros.
    for (const [label, ms] of [
      ['flow', flowMs],
      ['function', functionMs],
      ['client', clientMs],
    ]) {
      expect(ms, `${label} timeout should be a positive number of ms`).toBeGreaterThan(0);
    }
  });

  it('gives the flow the smallest budget, so its guard fires before the runtime kills it', () => {
    expect(
      flowMs,
      `the flow must finish and return an error before the function is killed — ` +
        `raise timeoutSeconds in ${INDEX_FILE} alongside GUIDED_PLAN_TIMEOUT`,
    ).toBeLessThan(functionMs);
  });

  it('leaves the function real headroom over the flow for the Firestore read and the response hop', () => {
    // The flow reads the recipe before it calls the model and serialises a plan
    // after. A function timeout a hair above the flow's would be killed during
    // that work, which is the same failure the ordering above exists to stop.
    expect(functionMs - flowMs).toBeGreaterThanOrEqual(15_000);
  });

  it('never lets the browser give up while the function is still writing (finding B2-010)', () => {
    expect(
      clientMs,
      `the client must not abandon a call the function is still serving — ` +
        `raise timeoutMs in ${CLIENT_FILE} alongside timeoutSeconds`,
    ).toBeGreaterThanOrEqual(functionMs);
  });

  it('keeps the flow budget above the measured cost of a long recipe', () => {
    // Measured against gemini-pro-latest on production recipes: a 16-step recipe
    // took 47–67s and a 32-step one 103s. 120s is the floor those numbers imply;
    // the shipped value is higher again. Going under this is what took the
    // feature down in production, and it is the edit this line refuses.
    expect(
      flowMs,
      'a guided plan for a full-length recipe has been measured at 103s — ' +
        'a smaller budget fails every time, it does not fail occasionally',
    ).toBeGreaterThanOrEqual(120_000);
  });
});
