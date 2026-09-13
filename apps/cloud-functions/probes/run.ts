// Probe runner CLI (issue #722).
//
//   pnpm probe auth-rules              # one journey against dev
//   pnpm probe all --target staging    # the whole sweep against staging
//   pnpm probe --domain planner        # every journey labelled `planner`
//
// Structured JSON on stdout, human-readable progress on stderr, non-zero exit
// on any failure — so an agent can pipe stdout straight into a triage step.

import { initAdmin, signIn } from './harness/auth.js';
import { isProbeTarget, PROBE_TARGETS, resolveEnv, type ProbeTarget } from './harness/env.js';
import { isProbeDomain, PROBE_DOMAINS, type ProbeDomain } from './harness/journey.js';
import { runProbe, type ProbeReport } from './harness/runner.js';
import { findJourney, JOURNEYS } from './journeys/index.js';

interface Args {
  readonly journeys: string[];
  readonly target: ProbeTarget;
}

const NAME_WIDTH = 22;
const DOMAIN_WIDTH = 10;

function usage(): string {
  const names = JOURNEYS.flatMap((journey) => {
    const line = `  ${journey.name.padEnd(NAME_WIDTH)} ${journey.domain.padEnd(DOMAIN_WIDTH)} ${journey.description}`;
    return journey.optIn === undefined
      ? [line]
      : [line, `  ${' '.repeat(NAME_WIDTH + DOMAIN_WIDTH + 1)} opt-in only — ${journey.optIn}`];
  });
  return [
    'Usage: pnpm probe <journey|all> [--target dev|staging] [--domain <domain>] [--include-opt-in]',
    '',
    `  ${'Journey'.padEnd(NAME_WIDTH)} ${'Domain'.padEnd(DOMAIN_WIDTH)} Covers`,
    ...names,
    `  ${'all'.padEnd(NAME_WIDTH)} ${'—'.padEnd(DOMAIN_WIDTH)} every journey above except the opt-in ones`,
    '',
    `Targets: ${PROBE_TARGETS.join(', ')} (default: dev). Production is not a target.`,
    `Domains: ${PROBE_DOMAINS.join(', ')}. --domain narrows the run to one of them;`,
    'it is a convenience for a person, and nothing selects journeys automatically.',
    '',
    'An opt-in journey has a consequence beyond cleaning up after itself — real',
    'money, or a real-world side effect. It is excluded from `all` unless',
    '--include-opt-in is given, and always runs when named explicitly.',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let target: ProbeTarget = 'dev';
  let domain: ProbeDomain | undefined;
  let includeOptIn = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--include-opt-in') {
      includeOptIn = true;
      continue;
    }

    if (arg === '--target' || arg === '-t') {
      const value = argv[i + 1];
      if (value === undefined || !isProbeTarget(value)) {
        throw new Error(`--target must be one of ${PROBE_TARGETS.join(', ')}`);
      }
      target = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--target=')) {
      const value = arg.slice('--target='.length);
      if (!isProbeTarget(value)) {
        throw new Error(`--target must be one of ${PROBE_TARGETS.join(', ')}`);
      }
      target = value;
      continue;
    }

    if (arg === '--domain' || arg === '-d') {
      const value = argv[i + 1];
      if (value === undefined || !isProbeDomain(value)) {
        throw new Error(`--domain must be one of ${PROBE_DOMAINS.join(', ')}`);
      }
      domain = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--domain=')) {
      const value = arg.slice('--domain='.length);
      if (!isProbeDomain(value)) {
        throw new Error(`--domain must be one of ${PROBE_DOMAINS.join(', ')}`);
      }
      domain = value;
      continue;
    }

    positional.push(arg);
  }

  if (positional.length === 0 && domain === undefined) throw new Error('no journey named');

  for (const name of positional) {
    if (name !== 'all' && findJourney(name) === undefined) {
      throw new Error(`unknown journey "${name}"`);
    }
  }

  // Naming a journey explicitly is itself the opt-in; a sweep filters, so a
  // routine run never silently bills for image generation. `--domain` on its
  // own is a sweep, not a naming — it narrows the set the filter already
  // produced, and so can never smuggle an opt-in journey into an unnamed run.
  const swept = positional.length === 0 || positional.includes('all');
  const selected = swept
    ? // `JOURNEYS` order — cheapest and most diagnostic first — is the sweep order.
      JOURNEYS.filter((journey) => includeOptIn || journey.optIn === undefined)
    : // Named journeys keep argv order, as they always have.
      positional.flatMap((name) => {
        const journey = findJourney(name);
        return journey === undefined ? [] : [journey];
      });

  const journeys = (
    domain === undefined ? selected : selected.filter((journey) => journey.domain === domain)
  ).map((journey) => journey.name);

  if (journeys.length === 0) {
    const suppressed = JOURNEYS.filter(
      (journey) => journey.domain === domain && journey.optIn !== undefined,
    ).map((journey) => journey.name);
    throw new Error(
      suppressed.length > 0
        ? `no journey to run: --domain ${String(domain)} matches only opt-in journeys (${suppressed.join(', ')}) — name one, or add --include-opt-in`
        : `no journey matches --domain ${String(domain)} in this run`,
    );
  }

  return { journeys, target };
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const env = resolveEnv(args.target);
  const admin = initAdmin(env);
  const identity = await signIn(env, admin);

  const reports: ProbeReport[] = [];
  for (const name of args.journeys) {
    const journey = findJourney(name);
    if (journey === undefined) continue;
    reports.push(
      await runProbe({ name: journey.name, env, admin, identity, body: journey.run.bind(journey) }),
    );
  }

  process.stdout.write(`${JSON.stringify({ reports }, null, 2)}\n`);

  const failed = reports.filter((report) => !report.ok);
  const leaked = reports.filter((report) => report.teardownErrors.length > 0);
  if (leaked.length > 0) {
    process.stderr.write(
      `\nWARNING: ${leaked.length} probe(s) could not clean up — check for leftover probe-* documents.\n`,
    );
  }
  process.stderr.write(
    `\n${reports.length - failed.length}/${reports.length} probes passed against ${env.target}.\n`,
  );

  if (failed.length > 0) process.exitCode = 1;
}

await main();
