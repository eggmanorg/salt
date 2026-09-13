import type { ProbeContext } from './runner.js';

/**
 * The vocabulary a journey's `domain` is drawn from — one word per journey,
 * and the whole list, so `--domain` can validate against it and print it.
 *
 * This is metadata for a person, not a routing system (issue #1356). Nothing
 * selects journeys automatically from a changed source path: the full sweep
 * runs every time, because at ~60 s for the lot, selection buys nothing and a
 * stale mapping would silently narrow the gate. The label exists so someone
 * working on the planner can run `--domain planner` and skip the rest.
 *
 * Because nothing depends on a domain being *right*, it stays honest. Adding a
 * word here is cheap; giving one journey two words is not — a list of domains
 * per journey is the routing table creeping back in.
 */
export const PROBE_DOMAINS = ['auth', 'planner', 'shopping', 'chat', 'canon', 'cooking'] as const;
export type ProbeDomain = (typeof PROBE_DOMAINS)[number];

export function isProbeDomain(value: string): value is ProbeDomain {
  return (PROBE_DOMAINS as readonly string[]).includes(value);
}

/** One self-contained journey. Registered in `probes/journeys/index.ts`. */
export interface Journey {
  /** CLI name — `pnpm probe <name>`. */
  readonly name: string;
  readonly description: string;
  /**
   * The one area of the app this journey walks — `--domain <x>` runs the slice.
   * Required, not optional: an unlabelled journey is a gap, and the compiler
   * should be the one to say so.
   */
  readonly domain: ProbeDomain;
  /**
   * Set when a run has a consequence beyond reading and cleaning up after
   * itself — real money (image generation) or a real-world side effect (a push
   * notification to someone's actual phone). The value is the reason, shown in
   * `--help`; its presence excludes the journey from the default `all` sweep.
   * Naming the journey explicitly always runs it.
   */
  readonly optIn?: string;
  run(ctx: ProbeContext): Promise<void>;
}
