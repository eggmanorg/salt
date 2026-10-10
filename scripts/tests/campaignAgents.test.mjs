// `/salt-campaign` spawns seven helper roles, and each role's model used to be
// a row in a table the coordinator had to remember to apply at every `Agent`
// call — enforced by nothing. #1586 moved each role into a project subagent
// under `.claude/agents/`, where the model is frontmatter the harness applies.
//
// What this test pins: every role has a definition, each definition names
// itself and carries the model the Behavior Contract of #1586 fixes, and the
// coordinator names every role it is meant to spawn. What it cannot pin: that
// the coordinator actually spawns them without a `model:` override — that is
// a run-time act of an agent reading prose, so the test holds only that the
// prose forbidding the override is still there.
//
// It also caps the command's size (#1586 Phase 2). The coordinator's prompt is
// re-sent on every one of a campaign's hundred-plus turns, and it grew from
// nothing to 85 KB one justified paragraph at a time; incident history now
// lives in docs/campaign-rationale.md, and this cap is what keeps it there.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (f) => readFileSync(path.join(repo, f), 'utf8');

const ROLES = {
  'campaign-extractor': 'haiku',
  'campaign-worker': 'opus',
  // Shared with /salt-review since #1590, hence not `campaign-`-prefixed.
  'pr-reviewer': 'opus',
  'campaign-fixer': 'sonnet',
  'campaign-sweeper': 'sonnet',
  'campaign-resolver': 'sonnet',
  // #1614: writing a spec is design work.
  'campaign-filer': 'opus',
};

/** The `key: value` lines between a file's leading `---` fences. */
const frontmatter = (src) => {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(
    m[1]
      .split('\n')
      .map((line) => line.match(/^(\w+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, k, v]) => [k, v.trim()]),
  );
};

describe('campaign agent definitions', () => {
  it.each(Object.entries(ROLES))('%s exists and runs on %s', (name, model) => {
    const file = `.claude/agents/${name}.md`;
    expect(existsSync(path.join(repo, file))).toBe(true);
    const fm = frontmatter(read(file));
    expect(fm.name).toBe(name);
    expect(fm.model).toBe(model);
    expect(fm.description).toBeTruthy();
    // A `#` after whitespace opens a YAML comment, so the harness silently cuts
    // the description there — the reviewer's once ended at "under".
    expect(fm.description).not.toMatch(/\s#/);
  });

  it.each(Object.keys(ROLES))('%s carries no tools restriction', (name) => {
    // A `tools:` list would drop the GitHub MCP tools a cloud session needs.
    expect(frontmatter(read(`.claude/agents/${name}.md`)).tools).toBeUndefined();
  });
});

describe('salt-campaign.md spawns them by name', () => {
  const src = read('.claude/commands/salt-campaign.md');

  it.each(Object.keys(ROLES))('names the %s subagent', (name) => {
    expect(src).toContain(`\`${name}\``);
  });

  it('forbids passing a model override on those spawns', () => {
    expect(src).toMatch(/never pass `model:`/);
    expect(src).not.toMatch(/Agent\(…, model: "(opus|sonnet)"\)/);
  });
});

// The desktop app's Code tab loads its own connectors into every helper, roughly
// doubling each one's starting context (docs/campaign-rationale.md → Models).
describe('salt-campaign.md records which session it runs in', () => {
  const src = read('.claude/commands/salt-campaign.md');

  it('checks CLAUDE_CODE_ENTRYPOINT and names the desktop value', () => {
    expect(src).toContain('printenv CLAUDE_CODE_ENTRYPOINT');
    expect(src).toContain('`claude-desktop`');
  });

  it('carries a Session: line in the ledger Plan block', () => {
    expect(src).toMatch(/^Session: /m);
  });
});

describe('salt-campaign.md stays a lean coordinator prompt', () => {
  it('is at most 40,000 bytes', () => {
    const bytes = readFileSync(path.join(repo, '.claude/commands/salt-campaign.md')).length;
    expect(bytes).toBeLessThanOrEqual(40_000);
  });
});

// Every campaign worker and every standalone /salt-run loads salt-run.md whole.
// #1589 moved its incident history to docs/campaign-rationale.md (`## salt-run.md`)
// and consolidated its cloud substitutions; this cap stops the file silently regrowing.
describe('salt-run.md stays a lean worker prompt', () => {
  it('is at most 30,000 bytes', () => {
    const bytes = readFileSync(path.join(repo, '.claude/commands/salt-run.md')).length;
    expect(bytes).toBeLessThanOrEqual(30_000);
  });
});

// #1612 Phase 1. About 70% of campaign cost is re-reading context on every call,
// and 91% of worker and fixer calls carried a single tool. These pin that each
// rule's sentence is still in the prompt that carries it. What they cannot pin:
// that an agent actually batches its reads, returns at its push, or skips the
// steward cadence — those are run-time acts of a model reading prose, checked
// only by reading a campaign's transcripts.
describe('campaign helpers batch independent reads (#1612)', () => {
  const BATCHING = /issue independent reads, searches and greps together in one message/i;

  it.each([
    '.claude/commands/salt-run.md',
    '.claude/agents/campaign-fixer.md',
    '.claude/agents/campaign-resolver.md',
    '.claude/agents/campaign-sweeper.md',
  ])('%s carries the batching sentence', (file) => {
    expect(read(file)).toMatch(BATCHING);
  });
});

describe('campaign-worker.md overrides salt-run.md step 9 item 5 (#1612)', () => {
  it('says the steward subscription does not apply to a worker', () => {
    const src = read('.claude/agents/campaign-worker.md');
    expect(src).toMatch(/step 9 item 5 does not apply to you/);
    // The reason is the backgrounded-command rule; the override must cite it.
    expect(src).toMatch(/Never end your turn with a backgrounded command still running/);
  });
});

describe('the sweeper returns at its push and the coordinator watches its CI (#1612)', () => {
  it('campaign-sweeper.md returns no CI field and does not wait', () => {
    const src = read('.claude/agents/campaign-sweeper.md');
    const ret = src.slice(src.lastIndexOf('Return:'));
    expect(ret).not.toMatch(/CI:/);
    expect(src).toMatch(/do not wait for its CI/);
  });

  it('salt-campaign.md → Sweep arms the CI watcher on the sweep PR', () => {
    const src = read('.claude/commands/salt-campaign.md');
    const sweep = src.slice(src.indexOf('\n## Sweep\n'), src.indexOf('\n## Finish\n'));
    expect(sweep).toContain('gh pr checks <pr> --watch --fail-fast');
    expect(sweep).not.toMatch(/`REJECTED`, `CI`/);
  });
});

// Decision 9 of #1612: the subagent prompt-cache TTL is deliberately left at
// 5 minutes. This pins the rationale entry and the absence of both controls in
// the repo. It cannot see a user-level `~/.claude/settings.json` or an
// environment variable set on the host — only what this repo configures.
describe('no helper prompt-cache TTL is raised (#1612)', () => {
  it('the rationale doc names both controls and the 5-minute idle condition', () => {
    const doc = read('docs/campaign-rationale.md');
    const entry = doc.slice(doc.indexOf("**Why no helper's prompt-cache TTL is raised**"));
    expect(doc).toContain("**Why no helper's prompt-cache TTL is raised**");
    expect(entry).toContain('`subagentPromptCacheTtl`');
    expect(entry).toContain('`cacheTtl`');
    expect(entry).toMatch(/idles for more than 5 minutes/);
  });

  it.each(Object.keys(ROLES))('%s sets no cacheTtl', (name) => {
    expect(read(`.claude/agents/${name}.md`)).not.toMatch(/cacheTtl/i);
  });

  it('.claude/settings.json sets no subagent prompt-cache TTL', () => {
    expect(read('.claude/settings.json')).not.toMatch(/cacheTtl/i);
  });
});

// #1612 Phase 2: one fresh worker per phase. These pin that the prose carrying
// each half of the loop is still there — the worker's return at its push, the
// coordinator's between-phase CI wait, the red-verdict dispatch and its limit.
// What they cannot pin: that a coordinator actually waits and dispatches this
// way, or that the handoff comment carries enough. The first campaign after
// merge is compared against the issue's Behavior Contract by hand.
describe('one fresh worker per phase (#1612)', () => {
  const worker = read('.claude/agents/campaign-worker.md');
  const campaign = read('.claude/commands/salt-campaign.md');
  const dispatch = campaign.slice(
    campaign.indexOf('\n## Dispatch\n'),
    campaign.indexOf('\n## Review\n'),
  );

  it('campaign-worker.md builds one phase and returns at its push', () => {
    expect(worker).toMatch(/You build exactly one phase/);
    expect(worker).toMatch(/then return, without waiting for CI/);
  });

  it('campaign-worker.md sends a red verdict to step 8 for the same phase', () => {
    expect(worker).toMatch(/A red verdict in your prompt/);
    expect(worker).toMatch(/your job is step 8 for that phase/);
    expect(worker).toMatch(/Build nothing further/);
  });

  it('campaign-worker.md returns the phase built and the next, and no CI claim', () => {
    const ret = worker.slice(worker.lastIndexOf('```\nISSUE: N'));
    expect(ret).toMatch(/^PHASE_BUILT: /m);
    expect(ret).toMatch(/^NEXT: /m);
    expect(ret).not.toMatch(/^CI: /m);
  });

  it('salt-campaign.md → Dispatch owns the between-phase CI wait and verdict', () => {
    expect(dispatch).toMatch(/\*\*One phase per worker\.\*\*/);
    expect(dispatch).toContain('gh pr checks <pr> --watch --fail-fast');
    expect(dispatch).toContain('node scripts/heavy-suites.mjs --branch <branch>');
  });

  it('a same-phase red dispatch does not spend the retry; a second red does', () => {
    expect(dispatch).toMatch(/a fresh worker for the \*\*same\*\* phase/);
    expect(dispatch).toMatch(/This does \*\*not\*\* spend the retry/);
    expect(dispatch).toMatch(/\*\*second consecutive `failed` on one phase\*\* is `BLOCKED`/);
  });

  it('the between-phase state is not `dispatched`, and resume handles it', () => {
    // The heartbeat reads only `dispatched` rows as live (campaignHeartbeat.mjs).
    expect(campaign).toMatch(/\| CI wait \|/);
    expect(campaign).toMatch(/A `CI wait` row: re-arm the CI watcher/);
    expect(campaign).toMatch(/a `CI wait` between phases keeps its slot/);
  });

  it('salt-run.md step 7 names the campaign path', () => {
    const src = read('.claude/commands/salt-run.md');
    const step7 = src.slice(src.indexOf('### 7. Handoff comment'), src.indexOf('### 8.'));
    expect(step7).toMatch(/On the campaign path it is also all the next phase inherits/);
  });
});

// #1614 Phase 1: the campaign takes engineering decisions itself, and files a
// follow-ups issue only when a question is left for Daniel. These pin that the
// prose routing each `[decide]` finding, and gating the follow-ups issue, is
// still in the prompts that carry it. What they cannot pin: that a coordinator
// actually routes a given finding this way, or that the fixer and sweeper
// apply the given choice rather than their own — run-time acts of a model
// reading prose, checked only by reading a campaign's ledger.
describe('the campaign decides engineering choices itself (#1614)', () => {
  const campaign = read('.claude/commands/salt-campaign.md');
  const review = campaign.slice(
    campaign.indexOf('\n### Fixing findings\n'),
    campaign.indexOf('\n## Merge queue\n'),
  );
  const finish = campaign.slice(campaign.indexOf('\n## Finish\n'));

  it('sends an in-footprint `[decide]` to the round-1 fixer and an outside one to `## Sweep`', () => {
    const line = review.split('\n').find((l) => l.startsWith('- **`[decide]`**'));
    expect(line).toMatch(/adopt the reviewer's recommended choice/);
    expect(line).toMatch(/In the footprint → the round-1 fixer/);
    expect(line).toMatch(/outside it → a `## Sweep` line carrying `decided: <the choice>`/);
  });

  it('names the five calls that stay with Daniel, and records engineering choices', () => {
    expect(campaign).toMatch(
      /\*\*Only five calls are Daniel's:\*\* a change to what a user sees or does; a spec-versus-clean-code fork \(no bodges\); a CLAUDE\.md rule change; a production data write or migration; a new dependency\./,
    );
    expect(campaign).toMatch(/report it only under \*\*Decisions taken\*\*/);
    expect(finish).toMatch(/\*\*Decisions taken:\*\* PR #2 — \[the finding\] → \[the choice\]/);
  });

  it('files the follow-ups issue only when a line is left for Daniel, each line a question', () => {
    expect(review).toMatch(/and only if something is\*\*/);
    expect(review).toMatch(/Nothing left → nothing filed\./);
    expect(review).toMatch(
      /\*\*Each line is a question for Daniel with what each answer costs him\*\*/,
    );
    expect(finish).toMatch(/only if a line is left for Daniel/);
    expect(campaign).not.toMatch(/File it however short/);
  });

  it('keeps the tick-and-close contract board-status.yml depends on', () => {
    expect(review).toMatch(
      /The body is a `- \[ \]` checklist, one line per item with its PR number/,
    );
    expect(review).toMatch(/ticks a line that NAMES a closed sub-issue/);
    // The form `board.mjs ticks` parses (prTicks), and the footer that prompts
    // a PR settling a line directly to write it — #1627 sat unticked without.
    expect(review).toMatch(/a merged PR's `Ticks #N: <words from the line>` quotes/);
    expect(review).toMatch(/End the body with that form, for a PR settling a line\./);
  });

  it("sends the sweep PR's `[decide]` findings to its round-1 fixer", () => {
    const sweep = campaign.slice(
      campaign.indexOf('\n## Sweep\n'),
      campaign.indexOf('\n## Finish\n'),
    );
    expect(sweep).toMatch(
      /`\[fold-in\]`, `\[sweep\]` \*\*and\*\* `\[decide\]` findings all go to its round-1 fixer/,
    );
  });

  it('campaign-fixer.md applies a `[decide]` line as a choice already made', () => {
    const src = read('.claude/agents/campaign-fixer.md');
    expect(src).toMatch(/plus any marked `\[fold-in\]` or `\[decide\]`/);
    expect(src).toMatch(/A `\[decide\]` line carries a choice already made: apply that choice/);
  });

  it('campaign-sweeper.md applies a `decided:` line as a choice already made', () => {
    const src = read('.claude/agents/campaign-sweeper.md');
    expect(src).toMatch(/carries `decided: <choice>` — a choice already made/);
    expect(src).toMatch(/apply that choice, and do not re-open it/);
  });
});

// #1614 Phase 2: adoption and its termination guard. These pin that the prose
// carrying each piece is still in the prompt that carries it — the guard and
// the command that answers it, the adopted row, the worker's DEFERRED field,
// the sweeper's reason words and the filer's non-interactive overrides. What
// they cannot pin: that a coordinator runs `--may-adopt` before it adopts,
// that it adopts at all, or that the filer's issue is any good. Those are
// run-time acts of a model reading prose. `adoptionVerdict` itself is tested in
// campaignHeartbeat.test.mjs; this file holds only that the instruction to ask
// it is there.
describe('the campaign adopts work, and the guard ends it (#1614)', () => {
  const campaign = read('.claude/commands/salt-campaign.md');
  const adopting = campaign.slice(
    campaign.indexOf('\n### Adopting work\n'),
    campaign.indexOf('\n## Merge queue\n'),
  );

  it('has an Adopting work section that runs the guard first, by command', () => {
    expect(adopting.length).toBeGreaterThan(0);
    expect(adopting).toMatch(
      /1\. \*\*Guard:\*\* `node scripts\/campaign-heartbeat\.mjs --may-adopt <issue> <ledger-body-file>`/,
    );
    expect(adopting).toMatch(/`ADOPT no` → follow-ups/);
  });

  it('states the guard for adopted and sweep PRs', () => {
    expect(adopting).toMatch(/\*\*an adopted issue's PR and the sweep PR never adopt\*\*/);
    expect(adopting).toMatch(/the ledger, for the sweep PR/);
  });

  it('files through the filer, and joins the run-set with an adopted row', () => {
    expect(adopting).toMatch(/a `campaign-filer`/);
    expect(adopting).toMatch(/`NEEDS_DANIEL: <line>` → that line on the follow-ups list/);
    expect(adopting).toMatch(/a conflict edge to the originating issue/);
    expect(adopting).toMatch(/`#n` added to the ledger title/);
    expect(adopting).toMatch(/Issue cell `#n adopted`/);
  });

  it('keeps one sweep per campaign for adopted work', () => {
    expect(adopting).toMatch(/until the sweep has run, then follow-ups — one sweep per campaign/);
  });

  it('routes the worker, fixer and sweeper rejects that adopt', () => {
    expect(campaign).toMatch(
      /\*\*`DEFERRED`\*\* — .*`footprint` or `ceiling` → \*\*Adopting work\*\*; `decision` parks/,
    );
    expect(campaign).toMatch(/A fixer's `choice` or `phases` reject → \*\*Adopting work\*\*/);
    expect(campaign).toMatch(/`ceiling`, `phases` or `choice` → \*\*Adopting work\*\*/);
  });

  it('attaches the ledger setting aside the issues born under it', () => {
    const finish = campaign.slice(campaign.indexOf('\n## Finish\n'));
    expect(finish).toMatch(/setting aside adopted ones \(under the ledger itself\)/);
    expect(finish).toMatch(/#h adopted \(PR #5\)/);
  });

  it('campaign-worker.md files nothing and returns DEFERRED', () => {
    const worker = read('.claude/agents/campaign-worker.md');
    expect(worker).toMatch(/\*\*Never file a follow-on issue yourself\.\*\*/);
    const ret = worker.slice(worker.lastIndexOf('```\nISSUE: N'));
    expect(ret).toMatch(
      /^DEFERRED: \[falsified premise → the test it failed: decision \| footprint \| ceiling — or NONE\]$/m,
    );
  });

  it('campaign-sweeper.md starts each reject with a reason word', () => {
    const src = read('.claude/agents/campaign-sweeper.md');
    for (const word of ['ceiling', 'phases', 'choice', 'fixed'])
      expect(src).toContain(`\`${word}\``);
    expect(src).toMatch(/REJECTED: \[line → <reason word>: why\]/);
  });

  it('campaign-filer.md is non-interactive and parents on the ledger', () => {
    const src = read('.claude/agents/campaign-filer.md');
    expect(src).toMatch(/Never `AskUserQuestion`/);
    expect(src).toMatch(/\*\*Parent: the ledger\.\*\*/);
    expect(src).toMatch(/check-spec-shape\.mjs/);
    expect(src).toMatch(/^FILED: #<n> /m);
    expect(src).toMatch(/^NEEDS_DANIEL: /m);
  });
});

// #1627: the fixer's rejects carry the sweeper's routing words, so the
// coordinator routes them by that word rather than by reading prose; and a
// finding already filed as `#d` is adopted as `#d`, not filed a second time.
// What these cannot pin: that the fixer picks the right word, or that the
// coordinator passes `#d` — run-time acts of a model reading prose.
describe('rejects route by a reason word, and a filed finding adopts itself (#1627)', () => {
  const campaign = read('.claude/commands/salt-campaign.md');

  it('campaign-fixer.md starts each reject with a reason word', () => {
    const src = read('.claude/agents/campaign-fixer.md');
    for (const word of ['ceiling', 'phases', 'choice', 'fixed', 'wrong', 'out-of-scope'])
      expect(src).toContain(`\`${word}\``);
    for (const word of ['ux', 'spec-vs-clean', 'rule', 'prod-data', 'dependency'])
      expect(src).toContain(`\`${word}\``);
    expect(src).toMatch(/REJECTED: \[finding → <reason word>: why\]/);
  });

  it('salt-campaign.md routes a fixer reject by its word', () => {
    expect(campaign).toMatch(/or a fixer's `ceiling` reject → a `## Sweep` line/);
    expect(campaign).toMatch(/`FIXED` findings and `fixed` rejects leave the list/);
  });

  it('passes an already-filed `#d` to the filer, which rewrites it in place', () => {
    const adopting = campaign.slice(
      campaign.indexOf('\n### Adopting work\n'),
      campaign.indexOf('\n## Merge queue\n'),
    );
    expect(adopting).toMatch(
      /any `#d` the line already names — rewritten in place, never filed twice/,
    );
    const filer = read('.claude/agents/campaign-filer.md');
    expect(filer).toMatch(/An already-filed `#d` is rewritten, never duplicated/);
    expect(filer).toMatch(/`gh issue edit d --body-file <file>` instead of `gh issue create`/);
  });
});
