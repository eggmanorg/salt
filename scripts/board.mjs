#!/usr/bin/env node
// Read and write the issue board — "Salt — The Pass", org project #1.
//
// WHY THIS EXISTS — three things, and only the third needs a script at all.
//
// 1. IDS ARE NOT NAMES. Every project mutation takes opaque node ids
//    (`PVTSSF_…` for a field, another for each of its options), and there is no
//    id-free form. Pasting those into `.claude/commands/*.md` would put six
//    unreadable identifiers in four files, all of which rot silently the first
//    time a field is renamed or re-optioned — the failure being a mutation that
//    errors, or worse, one that writes to the wrong field. Everything here is
//    resolved BY NAME at call time, so the commands say `--queue Recommended`
//    and nothing anywhere stores an id.
//
// 2. LABELS NO LONGER CARRY PRIORITY OR CLASS. The `priority: *` and
//    `status: *` labels were retired when this board landed; `Queue`, `Class`,
//    `Size` and `Status` are the only home for those facts now. `/salt-defect`,
//    `/salt-spec` and `/salt-refactor` call `add` here instead of applying them, so
//    a new issue arrives on the board already triaged rather than needing a
//    second pass. See docs/issue-board.md.
//
// 3. A NEW ISSUE HAS A PLACE AND A PARENT, AND ONLY ONE OF THEM WAS WIRED.
//    `add` triaged an issue onto the board from the moment /salt-spec, /salt-defect and
//    /salt-refactor started calling it — but nothing anywhere could say what a
//    new issue BELONGS TO, so a parent link was only ever something a human
//    added afterwards. `parent` closes that half. A parent is NOT an epic: see
//    the `epic:` check below.
//
//    ASK GRAPHQL WHETHER AN ISSUE HAS A PARENT. The REST issue endpoint
//    (`gh api repos/{owner}/{repo}/issues/N`) reports `parent: null` for every
//    issue in this repo, sub-issues of #1202 included — so a REST sweep answers
//    "nothing is parented" with total confidence and is wrong. `issue.parent`
//    over GraphQL is the field that is actually populated, and it is what
//    `cmdParent` reads before it refuses to re-parent anything.
//
// 4. THE PROMOTION RULE NEEDS A CHECK, NOT A PROMISE. `Recommended` means
//    actionable AND proven, and an issue is not actionable if something in this
//    repo blocks it — so a Recommended item's in-repo blocker is itself
//    Recommended, sitting above it. That is an invariant (CLAUDE.md rule 12),
//    and an invariant nothing can falsify is decoration. `check` is what makes
//    it real: it parses the leading `#N` out of `Blocked by` and goes red when
//    the blocker is absent from Recommended or ordered below what it blocks.
//
// SEQUENCE IS POSITION, NOT A FIELD. There is deliberately no rank number:
//   triage is placement, and `updateProjectV2ItemPosition(…, afterId)` places an
//   item directly after a named one. That is the same order a drag produces, so
//   a human and an agent triage through one mechanism. The cost is that a view
//   GROUPED BY `Queue` may carry no sort — that order is the only one anything
//   writes, and a sort renders a different one. Nowhere else: a `Status` board's
//   columns are filled by events, not by triage, so sorting one hides nothing.
//   See docs/issue-board.md.
//
// Needs a token with the `project` scope: the gh CLI's own login locally, or
// PROJECT_TOKEN in Actions (the Actions GITHUB_TOKEN cannot write projects).
//
// Usage:
//   node scripts/board.mjs add 1234 --queue Medium --class Defect --size S
//   node scripts/board.mjs set 1234 --status "In progress"
//   node scripts/board.mjs start 1234                       # work started — see cmdStart
//   node scripts/board.mjs pr 5678 --status "In review"     # via the PR's Closes #N
//   node scripts/board.mjs parent 1234 --of 1129            # sub-issue link
//   node scripts/board.mjs parent 1234 --of 1129 --detach-from 900   # move it
//   node scripts/board.mjs release --sha <deployed sha>
//   node scripts/board.mjs rollup 1364                      # a closed issue → its checklist, and up
//   node scripts/board.mjs check

import { execFileSync } from 'node:child_process';

import { absentTargetVerdict, closedItemVerdict } from './lib/boardClosedState.mjs';
import { closedAboveOpenWorkMessage, openDescendants } from './lib/boardHierarchy.mjs';
import { BEFORE_WORK, startReason } from './lib/boardProgress.mjs';
import { NUDGE_MARKER, rollupTargets, tickTask, verdict } from './lib/boardRollup.mjs';
import {
  isEpicTitle,
  isLedger,
  ledgerFullyReleased,
  ledgerRunSet,
  ledgerShouldAttachTo,
} from './lib/boardTitles.mjs';
import { forbiddenSortMessage, viewGroupFields } from './lib/boardViews.mjs';
import { findItem, ITEM_SELECTION, itemOnProject, parseItem } from './lib/boardItemLookup.mjs';
import { notOnBoardMessage, showLines } from './lib/boardShow.mjs';
import { disabledWorkflowFailures } from './lib/boardWorkflows.mjs';
import { SPEC_LABEL } from './lib/specIssueShape.mjs';

const OWNER = 'eggmanorg';
const REPO = 'salt';
const PROJECT_NUMBER = 1;

const die = (msg) => {
  console.error(`board: ${msg}`);
  process.exit(1);
};

/**
 * `token` overrides the ambient one for this call alone.
 *
 * Only `rollup` passes it, and it has to: PROJECT_TOKEN is a fine-grained PAT
 * with WRITE on the org's projects and READ on issues, so the one command that
 * both moves a field and edits an issue cannot do it under a single token. The
 * workflow hands it the Actions GITHUB_TOKEN for the issue half.
 */
function gql(query, token, { notFoundIsNull = false } = {}) {
  let out;
  try {
    out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // Piped, not inherited, when a NOT_FOUND is expected — else gh's own
      // stderr line would print for a miss this function then swallows.
      ...(notFoundIsNull ? { stdio: ['ignore', 'pipe', 'pipe'] } : {}),
      env: token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : process.env,
    });
  } catch (err) {
    // `notFoundIsNull`: a number that is not an issue (a PR, or nothing) comes
    // back as NOT_FOUND alongside a null field — a miss for the caller to judge,
    // not a failure of the call.
    if (notFoundIsNull) {
      let body = null;
      try {
        body = JSON.parse(err.stdout);
      } catch {
        // not a GraphQL body — fall through to die
      }
      if (body?.data && body.errors?.every((e) => e.type === 'NOT_FOUND')) return body.data;
    }
    die(
      `gh failed — ${String(err.stderr || err.message)
        .trim()
        .slice(0, 400)}`,
    );
  }
  const body = JSON.parse(out);
  if (body.errors) die(`GraphQL — ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

/** The project, its fields and their options — resolved by name, never stored. */
function loadProject() {
  const p = gql(`{ organization(login:"${OWNER}"){ projectV2(number:${PROJECT_NUMBER}){
    id title
    fields(first:50){ nodes{
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { id name dataType options{ id name } } } } } } }`)
    .organization?.projectV2;
  if (!p)
    die(
      `project #${PROJECT_NUMBER} not found under ${OWNER} — is the token missing the project scope?`,
    );

  const nodes = p.fields.nodes.filter((f) => f?.name);
  const fields = new Map(nodes.map((f) => [f.name, f]));
  return {
    id: p.id,
    title: p.title,
    allFields: nodes,
    field(name) {
      const f = fields.get(name);
      if (!f) die(`no field named "${name}" — have: ${[...fields.keys()].join(', ')}`);
      return f;
    },
    option(fieldName, value) {
      const f = this.field(fieldName);
      const o = f.options?.find((x) => x.name.toLowerCase() === String(value).toLowerCase());
      if (!o)
        die(
          `"${value}" is not an option of ${fieldName} — have: ${(f.options ?? []).map((x) => x.name).join(', ')}`,
        );
      return o.id;
    },
  };
}

/** Every item, in board order, with the fields the checks and writes need. */
function loadItems(project) {
  const items = [];
  let after = 'null';
  for (;;) {
    const page = gql(`{ node(id:"${project.id}"){ ... on ProjectV2 {
      items(first:100, after:${after}){
        pageInfo{ hasNextPage endCursor }
        nodes{ ${ITEM_SELECTION} } } } } }`).node.items;
    for (const n of page.nodes) {
      const item = parseItem(n);
      if (item) items.push(item);
    }
    if (!page.pageInfo.hasNextPage) break;
    after = `"${page.pageInfo.endCursor}"`;
  }
  return items;
}

/**
 * One issue's item on this project, asked from the ISSUE's side. The fallback
 * for a number the `items` scan missed — that connection lags a fresh add by
 * 30+ minutes; see the header of `lib/boardItemLookup.mjs` for the boundary.
 */
function lookupItem(project, number) {
  const nodes = gql(
    `{ repository(owner:"${OWNER}",name:"${REPO}"){ issue(number:${number}){
    projectItems(first:20, includeArchived:false){ nodes{ project{ id } ${ITEM_SELECTION} } } } } }`,
    undefined,
    { notFoundIsNull: true },
  ).repository?.issue?.projectItems?.nodes;
  return itemOnProject(nodes, project.id);
}

/** The item for one issue number — the scan, then the targeted lookup. */
const itemFor = (project, number, items = loadItems(project)) =>
  findItem(items, number, (n) => lookupItem(project, n));

function setSelect(project, itemId, fieldName, value) {
  const optionId = project.option(fieldName, value);
  gql(`mutation{ updateProjectV2ItemFieldValue(input:{
    projectId:"${project.id}", itemId:"${itemId}", fieldId:"${project.field(fieldName).id}",
    value:{singleSelectOptionId:"${optionId}"}}){ projectV2Item{ id } } }`);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) die(`--${key} needs a value`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

// Flag name → project field name. `class` is a reserved word in the shell sense
// only; as a flag it reads correctly, so the mapping stays 1:1 and obvious.
const FLAG_FIELD = { queue: 'Queue', class: 'Class', size: 'Size', status: 'Status' };

function cmdAdd(project, [num, ...rest]) {
  const number = Number(num);
  if (!Number.isInteger(number))
    die('usage: board.mjs add <issue> [--queue X --class Y --size Z --status W]');
  const flags = parseFlags(rest);

  const issue = gql(
    `{ repository(owner:"${OWNER}",name:"${REPO}"){ issue(number:${number}){ id title } } }`,
  ).repository?.issue;
  if (!issue) die(`issue #${number} not found in ${OWNER}/${REPO}`);

  const existing = itemFor(project, number);
  const itemId = existing
    ? existing.id
    : gql(
        `mutation{ addProjectV2ItemById(input:{projectId:"${project.id}", contentId:"${issue.id}"}){ item{ id } } }`,
      ).addProjectV2ItemById.item.id;

  for (const [flag, field] of Object.entries(FLAG_FIELD)) {
    if (flags[flag]) setSelect(project, itemId, field, flags[flag]);
  }
  const set = Object.entries(FLAG_FIELD)
    .filter(([flag]) => flags[flag])
    .map(([flag, field]) => `${field}=${flags[flag]}`)
    .join(' ');
  console.log(
    `${existing ? 'updated' : 'added'} #${number} — ${set || 'no fields set'}  ${issue.title}`,
  );
}

function cmdShow(project, [num]) {
  const number = Number(num);
  if (!Number.isInteger(number)) die('usage: board.mjs show <issue>');
  const item = itemFor(project, number);
  if (!item) die(notOnBoardMessage(number));
  for (const line of showLines(item)) console.log(line);
}

function cmdSet(project, [num, ...rest]) {
  const number = Number(num);
  if (!Number.isInteger(number))
    die('usage: board.mjs set <issue> [--queue X --class Y --size Z --status W]');
  const flags = parseFlags(rest);
  const item = itemFor(project, number);
  if (!item) die(`#${number} is not on the board — use \`add\` first`);
  for (const [flag, field] of Object.entries(FLAG_FIELD)) {
    if (flags[flag]) setSelect(project, item.id, field, flags[flag]);
  }
  console.log(
    `set #${number} — ${Object.entries(flags)
      .map(([k, v]) => `${FLAG_FIELD[k] ?? k}=${v}`)
      .join(' ')}`,
  );
}

/**
 * Promote an issue to `In progress` when an EVENT has proved work started on it.
 *
 * WHY THIS IS NOT `set --status "In progress"`. That writes unconditionally, and
 * this runs from an `issues` webhook — every open and every body edit, for the
 * life of the issue. Firing one of those at an issue whose PR is already open
 * would drag it back out of `In review`, and the board would then disagree with
 * a fact GitHub itself established. So the promotion is guarded on BOTH sides:
 * `startReason` decides whether the issue looks started, and refuses to answer
 * yes for anything already past `Todo`.
 *
 * A NO-OP IS THE COMMON CASE and prints a line saying which guard stopped it.
 * Most edits to most issues move nothing, and a silent exit there is
 * indistinguishable from a write that was lost.
 *
 * NOT ON THE BOARD IS A SKIP, NOT A FAILURE. GitHub's own "add item to project"
 * workflow runs asynchronously, so an `issues.opened` run can reach here before
 * the item exists. Adding it here instead would put an item on the board with no
 * `Queue`, which is the state `check` exists to catch — and it self-heals
 * anyway, since anything this command cares about gets edited again (a ledger
 * within minutes: `/salt-campaign` rewrites its body on every transition).
 */
function cmdStart(project, [num]) {
  const number = Number(num);
  if (!Number.isInteger(number)) die('usage: board.mjs start <issue>');

  const issue = gql(
    `{ repository(owner:"${OWNER}",name:"${REPO}"){ issue(number:${number}){ title state body } } }`,
  ).repository?.issue;
  if (!issue) die(`issue #${number} not found in ${OWNER}/${REPO}`);

  const item = itemFor(project, number);
  if (!item) {
    console.log(`#${number} is not on the board yet — nothing to move`);
    return;
  }

  const reason = startReason({
    title: issue.title,
    state: issue.state,
    status: item.status,
    body: issue.body,
  });
  if (!reason) {
    console.log(
      `#${number} stays at Status="${item.status ?? 'unset'}" — ${
        issue.state !== 'OPEN'
          ? 'closed'
          : item.status
            ? `already at ${item.status}`
            : 'no ticked task, and not a campaign ledger'
      }`,
    );
    return;
  }

  setSelect(project, item.id, 'Status', 'In progress');
  console.log(`#${number} → Status=In progress — ${reason}`);
}

/**
 * Move whatever a pull request closes. `/salt-run` writes `Closes #N` into every PR
 * body, which is the only machine-readable link between a PR and its issue —
 * GitHub's own "linked issue" is derived from exactly this text.
 */
function cmdPr(project, [num, ...rest]) {
  const number = Number(num);
  if (!Number.isInteger(number)) die('usage: board.mjs pr <pr> --status "In review"');
  const flags = parseFlags(rest);
  if (!flags.status) die('board.mjs pr needs --status');

  const pr = gql(
    `{ repository(owner:"${OWNER}",name:"${REPO}"){ pullRequest(number:${number}){ body createdAt } } }`,
  ).repository?.pullRequest;
  if (!pr) die(`PR #${number} not found`);

  const closes = [
    ...pr.body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi),
  ].map((m) => Number(m[1]));
  const targets = [...new Set(closes)];
  if (targets.length === 0) {
    console.log(`PR #${number} closes no issue — nothing to move`);
    return;
  }

  const items = loadItems(project);
  // Resolved once per target, so a number the lagging scan missed is asked
  // about from the issue's side before it counts as absent.
  const found = new Map(targets.map((issue) => [issue, itemFor(project, issue, items)]));
  const absent = targets.filter((issue) => !found.get(issue));
  // Only asked for when something IS absent, which is the rare case — and it is
  // asked once for all of them rather than per target.
  const closedAt = absent.length === 0 ? new Map() : fetchClosedAt(absent);

  let missed = 0;
  for (const issue of targets) {
    const item = found.get(issue);
    if (!item) {
      // An absent target is not automatically a miss, and not automatically
      // fine either. `absentTargetVerdict` holds which is which and why.
      const verdict = absentTargetVerdict({
        number: issue,
        closedAt: closedAt.get(issue) ?? null,
        prNumber: number,
        prCreatedAt: pr.createdAt,
      });
      if (verdict.level === 'failure') {
        console.error(verdict.message);
        missed += 1;
      } else {
        console.log(verdict.message);
      }
      continue;
    }
    setSelect(project, item.id, 'Status', flags.status);
    console.log(`#${issue} → Status=${flags.status}  (PR #${number})`);
  }

  // EXIT NON-ZERO ON A REAL MISS. The moves that could be made have already been
  // made — this fails at the end, not instead. A board job that reports success
  // having moved nothing is worse than one that is visibly broken, which is the
  // same reasoning that made PROJECT_TOKEN fail loudly rather than skip.
  if (missed > 0) process.exitCode = 1;
}

/** `issue number → closedAt | null`, batched the way `fetchParents` is. */
function fetchClosedAt(numbers) {
  const out = new Map();
  for (let i = 0; i < numbers.length; i += 50) {
    const batch = numbers.slice(i, i + 50);
    const data = gql(
      `{ repository(owner:"${OWNER}",name:"${REPO}"){ ${batch
        .map((n) => `i${n}: issue(number:${n}){ closedAt }`)
        .join(' ')} } }`,
    ).repository;
    for (const n of batch) out.set(n, data[`i${n}`]?.closedAt ?? null);
  }
  return out;
}

/**
 * Production deploys a tagged commit, and `Merged` only means "on main" — so an
 * issue merged AFTER the tag was cut is on main but not live. The ancestry test
 * is what keeps `Released` honest: only a merge commit reachable from the
 * deployed sha actually shipped. Needs a checkout with full history.
 */
function cmdRelease(project, rest) {
  const flags = parseFlags(rest);
  if (!flags.sha) die('usage: board.mjs release --sha <deployed sha>');

  // A missing sha would make every ancestry test answer false, and this would
  // report "0 moved" — a silent no-op that looks exactly like a correct run on
  // a release that shipped nothing. Fail loudly instead: the usual cause is a
  // shallow checkout, and the fix is `fetch-depth: 0`.
  try {
    execFileSync('git', ['cat-file', '-e', `${flags.sha}^{commit}`], { stdio: 'ignore' });
  } catch {
    die(
      `${flags.sha} is not in this checkout — the ancestry test needs full history (fetch-depth: 0)`,
    );
  }

  const statuses = [];
  for (let after = 'null'; ;) {
    const page = gql(`{ node(id:"${project.id}"){ ... on ProjectV2 {
      items(first:100, after:${after}){
        pageInfo{ hasNextPage endCursor }
        nodes{ id
          content{ ... on Issue { number title
            closedByPullRequestsReferences(first:10, includeClosedPrs:true){ nodes{ merged mergeCommit{ oid } } } } }
          status:fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`)
      .node.items;
    statuses.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = `"${page.pageInfo.endCursor}"`;
  }

  let moved = 0;
  const promoted = new Set();
  for (const n of statuses) {
    if (n.status?.name !== 'Merged' || !n.content?.number) continue;
    const commits = (n.content.closedByPullRequestsReferences?.nodes ?? [])
      .filter((p) => p.merged && p.mergeCommit?.oid)
      .map((p) => p.mergeCommit.oid);
    const shipped = commits.some((oid) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', oid, flags.sha], { stdio: 'ignore' });
        return true;
      } catch {
        return false; // not reachable from the deployed tag, or the object is absent
      }
    });
    if (!shipped) continue;
    setSelect(project, n.id, 'Status', 'Released');
    promoted.add(n.content.number);
    console.log(`#${n.content.number} → Released`);
    moved += 1;
  }

  // A LEDGER HAS NO MERGE COMMIT, so the ancestry test above can never promote
  // one and it would sit at `Merged` forever while the campaign it tracks went
  // live. Its run-set is the honest substitute: the campaign is live exactly
  // when everything its title names is live. Run after the loop above, so a
  // ledger whose last work issue was promoted in THIS release is promoted in
  // the same pass rather than waiting for the next one.
  // `statuses` is the board as it was BEFORE this run, so what the loop above
  // just promoted has to be folded in by hand — otherwise a ledger whose last
  // work issue went live in this very release reads as still Merged and waits
  // a whole deploy for nothing.
  const statusOf = new Map(
    statuses
      .filter((n) => n.content?.number)
      .map((n) => [
        n.content.number,
        promoted.has(n.content.number) ? 'Released' : (n.status?.name ?? null),
      ]),
  );
  for (const n of statuses) {
    if (n.status?.name !== 'Merged' || !n.content?.number || !isLedger(n.content.title)) continue;
    if (!ledgerFullyReleased(ledgerRunSet(n.content.title), statusOf)) continue;
    setSelect(project, n.id, 'Status', 'Released');
    console.log(`#${n.content.number} → Released (campaign ledger, run-set all live)`);
    moved += 1;
  }

  console.log(`release: ${moved} issue(s) moved to Released from ${flags.sha.slice(0, 8)}`);
}

/**
 * Attach an issue to the one it belongs to, as a GitHub sub-issue.
 *
 * A PARENT IS NOT AN EPIC. Grouping and priority are different questions:
 * `#1122` and `#1202` each hold sub-issues while sitting in an ordinary band,
 * because their children are the phases of that same piece of work, not a
 * programme of separate ones. So this writes the link and touches no field —
 * the child keeps whatever `add` gave it.
 *
 * WHY IT REFUSES TO RE-PARENT UNASKED. `addSubIssue` takes `replaceParent`, and
 * this never passes it. An agent filing a follow-up cannot tell "unattached"
 * from "attached to something I cannot see", and silently moving a child out
 * from under a parent a human chose is the one mistake here that leaves no
 * trace. Re-running with the parent it already has is a no-op, which is what
 * makes a retried campaign step safe.
 *
 * SO RE-PARENTING NAMES WHAT IT DISPLACES. `--detach-from <current parent>` is
 * the inverse the link never had: it detaches the existing link and writes the
 * new one. It takes the parent's NUMBER rather than being a bare boolean
 * because the refusal above is about proof — naming the parent you are
 * displacing is evidence you saw it, and a number that does not match what the
 * issue actually holds is an error rather than a silent move. (`parseFlags` has
 * no boolean form either, and dies on a valueless flag.) Omit the flag and
 * nothing changes: the refusal is still the default.
 */
function cmdParent(rest0) {
  const [num, ...rest] = rest0;
  const child = Number(num);
  const flags = parseFlags(rest);
  const parent = Number(flags.of);
  if (!Number.isInteger(child) || !Number.isInteger(parent))
    die('usage: board.mjs parent <issue> --of <parent> [--detach-from <current parent>]');
  if (child === parent) die(`#${child} cannot be its own parent`);

  const detachRaw = flags['detach-from'];
  const detach = detachRaw === undefined ? undefined : Number(detachRaw);
  if (detachRaw !== undefined && !Number.isInteger(detach))
    die(`--detach-from takes the number of the parent being displaced, got "${detachRaw}"`);

  // `parent{ id }` as well as its number: `removeSubIssue` takes the node id of
  // the parent being detached, so reading only the number would mean a second
  // round trip to displace one.
  const r = gql(`{ repository(owner:"${OWNER}",name:"${REPO}"){
    child: issue(number:${child}){ id title state parent{ id number title } }
    parent: issue(number:${parent}){ id title } } }`).repository;
  if (!r?.child) die(`issue #${child} not found in ${OWNER}/${REPO}`);
  if (!r?.parent) die(`issue #${parent} not found in ${OWNER}/${REPO}`);

  const held = r.child.parent?.number;
  if (held === parent) {
    console.log(`#${child} is already under #${parent}  ${r.parent.title}`);
    return;
  }
  if (held !== undefined && detach === undefined)
    die(
      `#${child} is already a sub-issue of #${held} (${r.child.parent.title}) — ` +
        `re-parent it deliberately with --detach-from ${held}`,
    );
  if (detach !== undefined && detach !== held)
    die(
      held === undefined
        ? `--detach-from ${detach} does not match: #${child} has no parent`
        : `--detach-from ${detach} does not match: #${child} is a sub-issue of ` +
            `#${held} (${r.child.parent.title})`,
    );

  if (held !== undefined) {
    gql(
      `mutation{ removeSubIssue(input:{issueId:"${r.child.parent.id}", subIssueId:"${r.child.id}"}){ issue{ number } } }`,
    );
    console.log(`#${child} detached from #${held}  ${r.child.parent.title}`);
    // Detach and attach are two mutations, so a failure between them leaves the
    // child unparented. `gql` exits the process rather than throwing, so the
    // recovery line is armed here instead of caught around the call below.
    process.on('exit', (code) => {
      if (code !== 0)
        console.error(
          `board: #${child} is detached and now has no parent — ` +
            `restore it with: node scripts/board.mjs parent ${child} --of ${held}`,
        );
    });
  }

  gql(
    `mutation{ addSubIssue(input:{issueId:"${r.parent.id}", subIssueId:"${r.child.id}"}){ issue{ number } } }`,
  );
  console.log(`#${child} → sub-issue of #${parent}  ${r.parent.title}`);

  // NOTHING CLOSES WHILE WORK UNDER IT IS STILL OPEN, and attaching is the one
  // moment that breaks it with nobody doing anything wrong: a PR merges and
  // closes an issue, then a defect found afterwards is attached underneath. That
  // is how #1319 became a violation — it had shipped, and #1496 arrived later.
  //
  // FIXED HERE RATHER THAN WATCHED FOR (Daniel, 2026-09-21). The alternatives
  // were `check` alone — which leaves the family invisible in `Hierarchies` for
  // however long it takes somebody to run it, the exact failure the invariant
  // exists to end — and an event-driven reopen in `board-status.yml`, a second
  // automated writer of issue state. This is the writer that is already here:
  // the command making the link repairs what the link breaks, in one breath and
  // out loud.
  //
  // THE WHOLE CLOSED CHAIN, not the immediate parent. Every closed ancestor is
  // separately hiding the family and `check` fails on each one, so reopening
  // only the nearest would trade one failure for another.
  //
  // It never closes anything. Detaching a child can leave its old parent with
  // nothing open under it, and whether that parent is now finished is a
  // judgement no command here is entitled to make.
  const openAttached =
    r.child.state === 'OPEN' ? [child] : openDescendants(child, fetchSubIssueTree([child]));
  if (openAttached.length) {
    for (const a of fetchAncestors(parent)) {
      if (a.state !== 'CLOSED') continue;
      gql(`mutation{ reopenIssue(input:{issueId:"${a.id}"}){ issue{ number } } }`);
      console.log(
        `#${a.number} reopened — #${openAttached[0]} is open beneath it  ${a.title}\n` +
          `  (closed means "this and everything under it is finished"; its Status is untouched)`,
      );
    }
  }
}

/**
 * An issue and every ancestor above it, nearest first, with the node ids a
 * reopen needs.
 *
 * Nested rather than looped because the whole chain is one round trip that way,
 * and GitHub caps a sub-issue hierarchy at eight levels — so the nesting depth
 * here is the product's own limit, not a guess. A chain deeper than that cannot
 * exist; if one ever did, this would return the nearest eight and the rule's
 * under-report direction would hold.
 */
function fetchAncestors(number) {
  const nest = (depth) => (depth === 0 ? '' : ` parent{ id number title state${nest(depth - 1)} }`);
  const root = gql(
    `{ repository(owner:"${OWNER}",name:"${REPO}"){ issue(number:${number}){ id number title state${nest(8)} } } }`,
  ).repository?.issue;
  const out = [];
  for (let n = root; n; n = n.parent)
    out.push({ id: n.id, number: n.number, title: n.title, state: n.state });
  return out;
}

/**
 * `issue number → parent number | null`, for as many issues as you like.
 *
 * Aliased into batches rather than one query per issue: `check` asks about
 * every ledger plus every issue those ledgers name, which is well over a
 * hundred numbers on the live board. GraphQL only — `gh api
 * repos/{owner}/{repo}/issues/N` reports `parent: null` for every issue in this
 * repo, sub-issues included (:29).
 */
function fetchParents(numbers) {
  const out = new Map();
  for (let i = 0; i < numbers.length; i += 50) {
    const batch = numbers.slice(i, i + 50);
    const data = gql(
      `{ repository(owner:"${OWNER}",name:"${REPO}"){ ${batch
        .map((n) => `i${n}: issue(number:${n}){ number parent{ number } }`)
        .join(' ')} } }`,
    ).repository;
    for (const n of batch) out.set(n, data[`i${n}`]?.parent?.number ?? null);
  }
  return out;
}

/**
 * `issue number → { state, children }` for every issue at or beneath `roots`,
 * walked one LEVEL at a time so each level costs a handful of batched queries
 * rather than one query per node.
 *
 * GraphQL only, for the same reason `fetchParents` is (:29): `subIssues` has no
 * REST equivalent that answers correctly in this repo. The aliased batches of
 * 50 are that function's shape, reused deliberately.
 *
 * TWO CAPS, both of which mean a missed finding rather than a false one.
 * `subIssues(first:100)` takes a parent's first hundred children and no more —
 * the largest family here is #778's 22 — and an issue the query could not
 * resolve is left out of the map entirely, which `openDescendants` then walks
 * as a leaf. So the tree this returns is a floor on what exists, never a
 * complete picture of it.
 */
function fetchSubIssueTree(roots) {
  const tree = new Map();
  const fetched = new Set();
  let level = [...new Set(roots)];
  while (level.length) {
    const pending = level.filter((n) => !fetched.has(n));
    const next = new Set();
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      for (const n of batch) fetched.add(n);
      const data = gql(
        `{ repository(owner:"${OWNER}",name:"${REPO}"){ ${batch
          .map(
            (n) =>
              `i${n}: issue(number:${n}){ state subIssues(first:100){ nodes{ number state } } }`,
          )
          .join(' ')} } }`,
      ).repository;
      for (const n of batch) {
        const issue = data[`i${n}`];
        if (!issue) continue;
        const kids = issue.subIssues?.nodes ?? [];
        tree.set(n, { state: issue.state, children: kids.map((k) => k.number) });
        for (const k of kids) {
          // A placeholder, so a child's own state is known even if the walk
          // stops here; the level that fetches it overwrites this entry.
          if (!tree.has(k.number)) tree.set(k.number, { state: k.state, children: [] });
          if (!fetched.has(k.number)) next.add(k.number);
        }
      }
    }
    level = [...next];
  }
  return tree;
}

/**
 * The promotion rule, made mechanical: a Recommended issue blocked by another
 * issue in this repo is only actionable if that blocker is also Recommended and
 * ordered above it. `Blocked by` leads with the reference precisely so this can
 * read it — `#952 — reason` for in-repo, `upstream: reason` for anything else.
 */
function cmdCheck(project) {
  const items = loadItems(project);
  const order = new Map(items.map((it, i) => [it.number, i]));
  const recommended = new Set(items.filter((i) => i.queue === 'Recommended').map((i) => i.number));

  const failures = [];
  for (const item of items) {
    if (item.queue !== 'Recommended') continue;
    const ref = item.blockedBy.trim().match(/^#(\d+)/);
    if (!ref) continue; // no blocker, or an `upstream:` one — out of our hands
    const blocker = Number(ref[1]);
    if (!order.has(blocker)) {
      failures.push(`#${item.number} is blocked by #${blocker}, which is not on the board`);
    } else if (!recommended.has(blocker)) {
      failures.push(
        `#${item.number} is blocked by #${blocker}, which is not Recommended — promote it`,
      );
    } else if (order.get(blocker) > order.get(item.number)) {
      failures.push(`#${item.number} is blocked by #${blocker}, which is sequenced below it`);
    }
  }

  // The closed-at-a-shipping-status rule lives in `closedItemVerdict` — read its
  // header for what each outcome means and why the note/failure line is drawn
  // where it is. It is a pure function of the item so that every branch is
  // covered by a test rather than by whatever the live board happens to hold
  // today.
  for (const item of items) {
    if (item.state !== 'CLOSED') continue;
    const verdict = closedItemVerdict(item);
    if (verdict.level === 'failure') failures.push(verdict.message);
    else if (verdict.level === 'note') console.log(`  note: ${verdict.message}`);
  }

  // NOTHING CLOSES WHILE WORK UNDER IT IS STILL OPEN. The other closed-issue
  // rule, and independent of the one above: that asks whether a closed issue
  // reached a shipping Status, this asks whether it should be closed at all.
  //
  // It sits here rather than with the view rules because the thing it protects
  // is a view. `Hierarchies` filters on `sub-issues-progress`, which counts
  // DIRECT children, so a closed parent over an open GRANDCHILD reads 100% and
  // takes its whole family out of the only view that claims to show every
  // running thread. No view definition can express depth, so this is the only
  // place the claim can be pinned — see `boardHierarchy.mjs` for what the walk
  // can and cannot see, and `docs/issue-board.md` for what `closed` now means.
  //
  // The tree comes from a separate query for the same reason the ledger parents
  // below do: `loadItems` reads project fields, and `subIssues` is not one.
  const closedItems = items.filter((it) => it.state === 'CLOSED');
  if (closedItems.length > 0) {
    const tree = fetchSubIssueTree(closedItems.map((it) => it.number));
    for (const item of closedItems) {
      const message = closedAboveOpenWorkMessage(item, tree);
      if (message) failures.push(message);
    }
  }

  // A LEDGER IS IN PROGRESS FROM THE MOMENT IT OPENS. `/salt-campaign` opens one
  // to BE the running state of a campaign and closes it when the campaign
  // finishes, so there is no point in its life when it is waiting rather than
  // running — the closed rule above already insists it end at a shipping
  // status, and this is the same claim at the other end. `board-status.yml`
  // moves it on `issues.opened`; what this catches is the case that job cannot,
  // where the item reached the board after the run had already looked for it.
  for (const item of items) {
    if (item.state !== 'OPEN' || !isLedger(item.title)) continue;
    if (!BEFORE_WORK.has(item.status ?? null)) continue;
    failures.push(
      `#${item.number} is an open campaign ledger at Status="${item.status ?? 'unset'}" — a campaign is in progress from the moment its ledger exists: \`board.mjs start ${item.number}\``,
    );
  }

  // An epic is a container, not a work unit: it sits in the `Epic` band so it
  // never competes for sequence with the work it holds, and never carries a
  // priority its children already carry. Left as prose that is the unguarded
  // invariant CLAUDE.md rule 12 is about — the failure mode being `board.mjs
  // add <epic> --queue Medium`, which reads as ordinary work forever after.
  //
  // THE TEST IS THE TITLE, NOT THE SUB-ISSUES, and that is a correction. This
  // read "having sub-issues proves a container", which stopped being true the
  // moment a parent link became the ordinary way to group an issue with the
  // work it came out of: #1122 and #1202 each hold their own phase issues while
  // correctly sitting in a work band, and both were failing this check on live
  // data. Every epic this repo has ever had titles itself `epic:` (#778, #894,
  // #913, #941, #1129), so that is what is actually checkable — and unlike the
  // old form it also catches an epic with no children at all, which the "one
  // direction only" carve-out had to let through.
  for (const item of items) {
    if (item.state !== 'OPEN' || !isEpicTitle(item.title)) continue;
    if (item.queue === 'Epic') continue;
    failures.push(
      `#${item.number} is titled "epic:" but sits in Queue="${item.queue ?? 'unset'}" — an epic belongs in the Epic band, not among the work units`,
    );
  }

  // THE CONVERSE, AND IT IS A DIFFERENT LENS RATHER THAN THE SAME ONE TWICE. The
  // rule above and `spec-shape.yml`'s guard both key off the TITLE, so an epic
  // filed without the `epic` prefix is invisible to both — and that is the
  // dangerous direction: a container stamped `specced` is a container `/salt-run`
  // will pick up and build as one job (#1378). This one keys off the BAND, which
  // a person sets by hand and which the mis-titled epic still ends up in. It
  // also catches a stale label on an issue nobody has edited since the guard
  // shipped, because `spec-shape.yml` only re-checks an issue when it is edited.
  //
  // WHERE IT STOPS: it needs the item to be in `Epic` already. An epic that is
  // both mis-titled AND untriaged is caught by neither this nor the rule above —
  // it is caught by the untriaged rule below, which is the third lens and the
  // reason that one has no epic carve-out.
  for (const item of items) {
    if (item.state !== 'OPEN' || item.queue !== 'Epic') continue;
    if (!item.labels.includes(SPEC_LABEL)) continue;
    failures.push(
      `#${item.number} sits in Queue="Epic" but carries \`${SPEC_LABEL}\` — an epic is a container and must never be runnable: file its children as separate issues and give it no \`## Phases\` section`,
    );
  }

  // UNTRIAGED IS A STATE THE BOARD CANNOT SHOW YOU. GitHub's own "add item to
  // project" workflow puts every new issue on the board with every field empty,
  // and an item with no Queue appears in no queue view — so the pile that most
  // needs looking at is the one pile nothing surfaces. Nine agent-filed issues
  // sat there in a week before anyone noticed. `add --queue` is what fills it,
  // and this is what makes skipping that call visible.
  for (const item of items) {
    // THE one exemption a ledger still has: a coordination artefact must not
    // sit in a work queue. See isLedger, and the closed-status rule above for
    // the half that was wrongly exempted alongside it.
    if (item.state !== 'OPEN' || item.queue || isLedger(item.title)) continue;
    failures.push(
      `#${item.number} is on the board with no Queue — triage it with \`board.mjs set ${item.number} --queue <band>\``,
    );
  }

  // A CAMPAIGN IS REACHABLE FROM THE WORK IT RAN. Everything a campaign throws
  // off — follow-ups, re-specs, mid-run defects — attaches to its ledger, so a
  // ledger with no parent of its own puts all of it one hop from unreachable.
  // Epic #913 showed nine closed children and no sign that campaign #1266 had
  // run three of them and left #1269 behind. That was prose in four command
  // files and guaranteed by nothing, which is the defect class CLAUDE.md rule
  // 12 names; this is where it stops being prose.
  //
  // THE RULE'S REAL BOUNDARY. The run-set is what the ledger's TITLE names —
  // see `ledgerRunSet` — never every issue the campaign touched. A ledger whose
  // run-set shares no single parent passes in both directions, deliberately:
  // see `ledgerShouldAttachTo`. Open and closed alike are checked, because a
  // ledger closes when its campaign finishes and closed is where nearly every
  // orphan was.
  //
  // The parents come from a separate query because `loadItems` reads project
  // fields and `parent` is not one — and it must be GraphQL, since the REST
  // issue endpoint reports `parent: null` for every issue in this repo (:29).
  const ledgers = items.filter((it) => isLedger(it.title));
  if (ledgers.length > 0) {
    const wanted = new Set();
    for (const led of ledgers) {
      wanted.add(led.number);
      for (const n of ledgerRunSet(led.title)) wanted.add(n);
    }
    const parentOf = fetchParents([...wanted]);
    for (const led of ledgers) {
      const expected = ledgerShouldAttachTo(ledgerRunSet(led.title), parentOf);
      if (expected === null) continue;
      const held = parentOf.get(led.number) ?? null;
      if (held === expected) continue;
      failures.push(
        `#${led.number} is a campaign ledger whose issues all sit under #${expected}, but it ` +
          (held === null ? 'has no parent' : `hangs off #${held}`) +
          ` — attach it with \`board.mjs parent ${led.number} --of ${expected}` +
          (held === null ? '`' : ` --detach-from ${held}\``) +
          `, or everything the campaign filed is unreachable from #${expected}`,
      );
    }
  }

  // TWO OPTIONS CANNOT SHARE A NAME. Everything here resolves options by name
  // (see `option()`), so a field carrying the same name twice makes every write
  // pick the first match while a human drag may land on the second — the board
  // then shows two identical columns and the items silently split between them.
  // Status held two "Todo" options for exactly this reason. The comparison is
  // case-insensitive because `option()` is: "Todo" and "todo" resolve alike, so
  // a check that told them apart would pass on a board that is already broken.
  for (const f of project.allFields) {
    const seen = new Map();
    for (const o of f.options ?? []) {
      const key = o.name.toLowerCase();
      seen.set(key, [...(seen.get(key) ?? []), o.name]);
    }
    for (const names of seen.values()) {
      if (names.length > 1) {
        failures.push(
          `field "${f.name}" has ${names.length} options named ${names.map((n) => `"${n}"`).join(', ')} — writes resolve by name and take the first, so delete the duplicate with updateProjectV2Field`,
        );
      }
    }
  }

  // Group-by and sort-by cannot be SET through the API, but they can be READ —
  // so the no-sort rule is enforceable, and left as prose it would be exactly
  // the unguarded invariant CLAUDE.md rule 12 is about. What the rule says, how
  // narrow it is and why: `forbiddenSortMessage` in ./lib/boardViews.mjs.
  const views = gql(`{ node(id:"${project.id}"){ ... on ProjectV2 {
    views(first:20){ nodes{ number name layout
      groupByFields(first:5){ nodes{ ... on ProjectV2FieldCommon { name } } }
      verticalGroupByFields(first:5){ nodes{ ... on ProjectV2FieldCommon { name } } }
      sortByFields(first:5){ nodes{ direction field{ ... on ProjectV2FieldCommon { name } } } } } } } } }`)
    .node.views.nodes;

  // The pipeline's first rung is a GitHub built-in, not code — see
  // `disabledWorkflowFailures` for which are pinned and why only those.
  const workflows = gql(`{ organization(login:"${OWNER}"){ projectV2(number:${PROJECT_NUMBER}){
    workflows(first:20){ nodes{ name enabled } } } } }`).organization?.projectV2?.workflows?.nodes;
  for (const f of disabledWorkflowFailures(workflows)) failures.push(f);

  for (const v of views) {
    const sortFailure = forbiddenSortMessage(v);
    if (sortFailure) failures.push(sortFailure);
    const group = viewGroupFields(v);
    if (group.length === 0) {
      console.log(
        `  note: view ${v.number} "${v.name}" has no grouping set — set it in the UI, the API cannot`,
      );
    }
  }

  console.log(`${project.title}: ${items.length} items, ${recommended.size} Recommended`);
  if (failures.length === 0) {
    console.log('check: ok');
    return;
  }
  for (const f of failures) console.error(`check: ${f}`);
  process.exit(1);
}

/**
 * Roll a closed issue up to the checklist that asked for it — and on up.
 *
 * The gap this closes, and why no existing command could: `/salt-campaign` files
 * a `campaign follow-ups:` issue, hangs the issues that action its lines off it
 * as sub-issues, and deliberately leaves it open. Nothing after that owns it.
 * `/salt-run` closes the issue it ran and never looks at a parent; `check` reads
 * only Queue and Status. #1335 sat open with all three children closed and every
 * box unticked; #1370 was closed by hand the same way. See lib/boardRollup.mjs
 * for what this deliberately cannot see.
 *
 * ONE CLOSE RE-EVALUATES TWO KINDS OF ISSUE (`rollupTargets`): its sub-issue
 * parent, and every open campaign ledger whose title names it. The second is
 * how a PARKED campaign's ledger closes once the parked issue finally lands —
 * that issue is never attached beneath the ledger.
 *
 * AND IT CASCADES, IN THIS PROCESS (#1606). Two tokens, and the split is not
 * incidental: the ambient GH_TOKEN writes the project field (PROJECT_TOKEN in
 * Actions), and ISSUE_WRITE_TOKEN — the Actions GITHUB_TOKEN — writes the issue.
 * A GITHUB_TOKEN-authored close raises no further `issues` event, so a
 * follow-ups issue closed HERE never woke the ledger above it: #1485 closed
 * through this and #1466 was never asked. So every issue this closes is treated
 * as the next closed child and rolled up in turn, each hop applying the same
 * `verdict` — nothing closes that would not have closed had a person closed the
 * child. It stops at the first `wait` or `nudge`, at an issue with nothing to
 * re-evaluate, or after MAX_HOPS levels: GitHub nests sub-issues at most eight
 * deep, so the cap only bounds a chain that also runs sideways through ledgers.
 */
const MAX_HOPS = 8;

function cmdRollup(project, [num]) {
  const first = Number(num);
  if (!Number.isInteger(first)) die('usage: board.mjs rollup <closed issue>');
  const writeToken = process.env.ISSUE_WRITE_TOKEN || undefined;

  const closedHere = new Set();
  let queue = [first];
  for (let hop = 0; queue.length; hop++) {
    if (hop === MAX_HOPS) {
      console.log(
        `stopping after ${MAX_HOPS} levels of cascade — not rolled up: ` +
          queue.map((n) => `#${n}`).join(', '),
      );
      return;
    }
    const next = [];
    for (const child of queue) {
      for (const target of rollupTargetsOf(child)) {
        if (closedHere.has(target)) continue;
        if (rollupOne(project, child, target, writeToken)) {
          closedHere.add(target);
          next.push(target);
        }
      }
    }
    queue = next;
  }
}

/** `rollupTargets` for one closed issue, fetched live. */
function rollupTargetsOf(child) {
  const c = gql(`{ repository(owner:"${OWNER}",name:"${REPO}"){ issue(number:${child}){
    state parent{ number state title } } } }`).repository?.issue;
  if (!c) die(`issue #${child} not found in ${OWNER}/${REPO}`);
  if (c.state !== 'CLOSED') {
    console.log(`#${child} is not closed — nothing to roll up`);
    return [];
  }
  // Every open title with the WORD `campaign` in it, filtered by `rollupTargets`
  // — which drops `campaign follow-ups:` through `isLedger` and keeps only the
  // ledgers naming this child. The number cannot go in the query: GitHub's
  // search does not match `1588` against a title's `#1588`. The first hundred
  // are a floor, not a guarantee; five ledgers were open when this was written.
  const ledgers = gql(`{ search(type:ISSUE, first:100,
    query:"repo:${OWNER}/${REPO} is:issue is:open in:title campaign"){
    nodes{ ... on Issue { number state title } } } }`).search.nodes;
  const targets = rollupTargets(child, { parent: c.parent, ledgers });
  if (!targets.length)
    console.log(
      c.parent
        ? `#${child}'s parent #${c.parent.number} is already closed, and no open ledger names it`
        : `#${child} has no parent and no open ledger names it — nothing to roll up`,
    );
  return targets;
}

/** The open issues among `numbers`, fetched in one round trip. */
function openIssues(numbers) {
  if (!numbers.length) return [];
  const data = gql(
    `{ repository(owner:"${OWNER}",name:"${REPO}"){ ${numbers
      .map(
        (n) =>
          `i${n}: issueOrPullRequest(number:${n}){ ... on Issue{ state } ... on PullRequest{ state } }`,
      )
      .join(' ')} } }`,
    undefined,
    { notFoundIsNull: true },
  )?.repository;
  // A number the query could not resolve counts as OPEN: a run-set member this
  // cannot see must hold the ledger open, never let it close.
  return numbers.filter((n) => !['CLOSED', 'MERGED'].includes(data?.[`i${n}`]?.state));
}

/** Tick, judge and act on one parent. True when it closed it. */
function rollupOne(project, child, number, writeToken) {
  // Re-read here rather than trusting what found it: an earlier hop in this run
  // may have ticked it, and another run may have closed it.
  const parent = gql(`{ repository(owner:"${OWNER}",name:"${REPO}"){ issue(number:${number}){
    id number title state body } } }`).repository.issue;
  if (parent.state !== 'OPEN') {
    console.log(`#${number} is already closed`);
    return false;
  }
  const ledger = isLedger(parent.title);

  // Tick first, so the verdict below reads the body this run just wrote rather
  // than the one it was handed.
  let body = parent.body;
  const tick = tickTask(body, child);
  if (tick) {
    body = tick.body;
    gql(
      `mutation{ updateIssue(input:{id:"${parent.id}", body:${JSON.stringify(body)}}){ issue{ number } } }`,
      writeToken,
    );
    console.log(`#${parent.number} — ticked: ${tick.text.slice(0, 90)}`);
  } else {
    console.log(`#${parent.number} — no single unticked line names #${child}`);
  }

  // THE WHOLE SUBTREE, not the parent's own children. `rollup` closing a parent
  // over an open grandchild is the automated way to produce exactly the state
  // `check` now fails on, and this job runs on every `issues: closed` — so the
  // walk that feeds the check feeds the closer too, rather than each keeping
  // its own idea of what "nothing left open" means.
  const runSet = ledger ? ledgerRunSet(parent.title) : [];
  const v = verdict({
    title: parent.title,
    body,
    openBeneath: openDescendants(parent.number, fetchSubIssueTree([parent.number])),
    openRunSet: ledger ? openIssues(runSet) : undefined,
  });

  if (v.action === 'wait') {
    console.log(
      `#${parent.number} stays open — still open: ${v.open.map((n) => `#${n}`).join(', ')}`,
    );
    return false;
  }

  if (v.action === 'nudge') {
    const already = gql(
      `{ repository(owner:"${OWNER}",name:"${REPO}"){ issue(number:${parent.number}){
        comments(last:30){ nodes{ body } } } } }`,
    ).repository.issue.comments.nodes.some((n) => n.body.includes(NUDGE_MARKER));
    if (already) {
      console.log(`#${parent.number} — already nudged`);
      return false;
    }
    // Quoted, not repeated as live task items: a second interactive checklist on
    // the comment is a second place to tick, and only the body's counts.
    const lines = v.unticked.map((t) => `> ${t.text.trim().slice(0, 140)}`).join('\n');
    const note =
      `${NUDGE_MARKER}\n#${child} just closed and nothing is open beneath this one any more, ` +
      `but it is not being closed automatically — ${v.why}.\n\n` +
      (lines ? `Still unticked:\n\n${lines}\n\n` : '') +
      `Tick what has shipped and close this, or say what is outstanding. ` +
      `A line that names the issue actioning it (\`#1364\`) ticks itself when that issue closes.`;
    gql(
      `mutation{ addComment(input:{subjectId:"${parent.id}", body:${JSON.stringify(note)}}){ clientMutationId } }`,
      writeToken,
    );
    console.log(`#${parent.number} — nudged: ${v.why}`);
    return false;
  }

  // A closed board item must carry `Merged` or `Released` — `check` fails on one
  // that does not, and this issue never had a PR to move it there. A ledger is
  // promoted on to `Released` by `release`, from its run-set.
  const item = itemFor(project, parent.number);
  if (item && item.status !== 'Merged' && item.status !== 'Released') {
    setSelect(project, item.id, 'Status', 'Merged');
    console.log(`#${parent.number} → Status=Merged`);
  }

  const done = ledger
    ? `Closing — all ${runSet.length} issues this campaign's title names are closed, nothing is ` +
      `open beneath it` +
      (v.items ? `, and all ${v.items} of its task lines are ticked` : '') +
      `. The last to close was #${child}.`
    : `Closing — every one of the ${v.items} items on this list is ticked and every sub-issue is ` +
      `closed, the last being #${child}.`;
  gql(
    `mutation{ addComment(input:{subjectId:"${parent.id}", body:${JSON.stringify(done)}}){ clientMutationId } }`,
    writeToken,
  );
  gql(
    `mutation{ closeIssue(input:{issueId:"${parent.id}", stateReason: COMPLETED}){ issue{ number } } }`,
    writeToken,
  );
  console.log(
    ledger
      ? `#${parent.number} closed — ledger, run-set of ${runSet.length} all closed`
      : `#${parent.number} closed — ${v.items} items, every sub-issue closed`,
  );
  return true;
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') {
  console.log(`usage:
  board.mjs add <issue> [--queue X --class Y --size Z --status W]
  board.mjs set <issue> [--queue X --class Y --size Z --status W]
  board.mjs show <issue>
  board.mjs start <issue>
  board.mjs pr <pr> --status "In review"
  board.mjs parent <issue> --of <parent issue> [--detach-from <current parent>]
  board.mjs release --sha <deployed sha>
  board.mjs rollup <closed issue>
  board.mjs check`);
  process.exit(command ? 0 : 1);
}

// `parent` writes no project field, so it needs no project — and resolving one
// would make it fail on a token without the `project` scope for no reason.
if (command === 'parent') {
  cmdParent(args);
  process.exit(0);
}

const project = loadProject();
if (command === 'add') cmdAdd(project, args);
else if (command === 'set') cmdSet(project, args);
else if (command === 'show') cmdShow(project, args);
else if (command === 'start') cmdStart(project, args);
else if (command === 'pr') cmdPr(project, args);
else if (command === 'release') cmdRelease(project, args);
else if (command === 'rollup') cmdRollup(project, args);
else if (command === 'check') cmdCheck(project);
else
  die(
    `unknown command "${command}" — expected add, set, show, start, pr, parent, release, rollup or check`,
  );
