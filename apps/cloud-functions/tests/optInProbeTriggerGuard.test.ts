/**
 * Source guard for issue #1356's one rule that money and someone's phone depend
 * on: **`--include-opt-in` never appears in a merge-triggered workflow.**
 *
 * Three probe journeys have a consequence beyond cleaning up after themselves —
 * `canon-icon` generates a pictogram, `recipe-import` generates a recipe hero,
 * `cook-timer` sends a real push notification to a real phone. `pnpm probe all`
 * excludes them; `--include-opt-in` is what lifts that exclusion.
 *
 * The failure mode being guarded is not "the flag exists". It is a sweep that
 * bills for images and buzzes a family member's phone BECAUSE SOMEONE MERGED A
 * PULL REQUEST — unbounded, unpredictable and many times a day. A run on a
 * weekly schedule or on a published release is bounded, predictable and chosen,
 * and it is the only way those journeys get exercised at all. So the rule is
 * narrower than "never", and this test is exactly as narrow: it fails only when
 * the flag appears under `push`, `pull_request`, `merge_group`, or a
 * `workflow_run` of CI.
 *
 * Without this test that rule is a sentence in a runbook, and the absolute it
 * replaced ("never in CI") was at least self-enforcing by being absolute.
 * `aiTimeoutGuard.test.ts` is the pattern: a scan of bytes on disk, never an
 * import, and the file set is DERIVED from the directory rather than listed.
 *
 * Its boundary, stated rather than left as an unqualified absolute: it reads a
 * workflow's OWN `on:` block. A workflow triggered only by `workflow_call` and
 * invoked from a merge-triggered one would carry no merge trigger of its own and
 * would slip past. No workflow in this repo uses `workflow_call`, and a reusable
 * workflow that ran the probe sweep would be a deliberate act; if one is ever
 * added, this guard has to follow the call edge.
 *
 * Deliberately regex over raw text rather than a YAML parse. `yaml` is present
 * in this workspace only as a transitive dependency — the hazard the comment in
 * `probes/tsconfig.json` documents, where a lockfile reshuffle removed a type
 * reference nothing declared — and a guard that a dependency bump can silently
 * disable is not a guard. The question is a substring question anyway.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows');

const OPT_IN_FLAG = '--include-opt-in';

/**
 * A merge trigger: something that fires because code landed, with no person
 * choosing the moment. `workflow_run` counts only when it chains off CI —
 * deploy-staging.yml does exactly that, and its probe job is the one this rule
 * exists for.
 */
const MERGE_TRIGGERS = ['push', 'pull_request', 'pull_request_target', 'merge_group'];

interface Workflow {
  readonly file: string;
  readonly text: string;
}

/** Every workflow file, walked — never a hand-kept list. */
const workflows: Workflow[] = readdirSync(workflowsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
  .map((entry) => ({
    file: entry.name,
    text: readFileSync(join(workflowsDir, entry.name), 'utf8'),
  }));

/**
 * The `on:` block, as raw text: everything from the `on:` line to the next
 * top-level key. Comments are stripped first, so prose about a trigger never
 * counts as one — this file's own header would otherwise match every word.
 */
function triggerBlock(text: string): string {
  const withoutComments = text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n');
  const start = withoutComments.search(/^on:/m);
  if (start === -1) return '';
  const rest = withoutComments.slice(start + 3);
  const end = rest.search(/^[A-Za-z_]/m);
  return end === -1 ? rest : rest.slice(0, end);
}

function isMergeTriggered(text: string): boolean {
  const block = triggerBlock(text);
  if (MERGE_TRIGGERS.some((trigger) => new RegExp(`^\\s*${trigger}:`, 'm').test(block)))
    return true;
  // A `workflow_run` chained off CI fires on exactly the same event a push does,
  // one workflow later.
  return /^\s*workflow_run:/m.test(block) && /workflows:\s*\[?\s*['"]?CI/.test(block);
}

function usesOptIn(text: string): boolean {
  return text
    .split('\n')
    .some((line) => !/^\s*#/.test(line) && line.replace(/\s+#.*$/, '').includes(OPT_IN_FLAG));
}

describe('probes: --include-opt-in never runs because a pull request merged', () => {
  it('scans the real workflow directory', () => {
    // Two floors, so neither an empty walk nor a trigger matcher that stopped
    // matching can leave this suite quietly asserting nothing.
    expect(workflows.length).toBeGreaterThan(5);
    expect(
      workflows.filter((w) => isMergeTriggered(w.text)).map((w) => w.file).length,
      'no workflow looks merge-triggered — the trigger matcher has stopped matching',
    ).toBeGreaterThan(0);
  });

  it('finds the flag in the workflows that are allowed to use it', () => {
    // The other half of the floor: if nothing uses the flag at all, the rule
    // below is vacuously true and the costly journeys are running nowhere.
    const users = workflows.filter((w) => usesOptIn(w.text)).map((w) => w.file);
    expect(users, 'no workflow runs the opt-in journeys at all').not.toHaveLength(0);
    expect(users.every((file) => !isMergeTriggered(readWorkflow(file)))).toBe(true);
  });

  it('no merge-triggered workflow passes --include-opt-in', () => {
    const offenders = workflows
      .filter((w) => isMergeTriggered(w.text) && usesOptIn(w.text))
      .map((w) => w.file);

    expect(
      offenders,
      `${offenders.join(', ')} runs the probe sweep with ${OPT_IN_FLAG} on a merge trigger. ` +
        'Those journeys generate a real image and send a real push every run — they belong ' +
        'on a chosen rhythm (probe-staging-weekly.yml, or release: published), never on a merge.',
    ).toHaveLength(0);
  });
});

function readWorkflow(file: string): string {
  return workflows.find((w) => w.file === file)?.text ?? '';
}
