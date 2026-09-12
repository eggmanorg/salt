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
//   a human and an agent triage through one mechanism. The cost is that no view
//   may carry a sort — a sorted view disables dragging and hides the order this
//   writes. See docs/issue-board.md.
//
// Needs a token with the `project` scope: the gh CLI's own login locally, or
// PROJECT_TOKEN in Actions (the Actions GITHUB_TOKEN cannot write projects).
//
// Usage:
//   node scripts/board.mjs add 1234 --queue Medium --class Defect --size S
//   node scripts/board.mjs set 1234 --status "In progress"
//   node scripts/board.mjs pr 5678 --status "In review"     # via the PR's Closes #N
//   node scripts/board.mjs parent 1234 --of 1129            # sub-issue link
//   node scripts/board.mjs parent 1234 --of 1129 --detach-from 900   # move it
//   node scripts/board.mjs release --sha <deployed sha>
//   node scripts/board.mjs check

import { execFileSync } from 'node:child_process';

import {
  isEpicTitle,
  isLedger,
  ledgerFullyReleased,
  ledgerRunSet,
  ledgerShouldAttachTo,
} from './lib/boardTitles.mjs';

const OWNER = 'eggmanorg';
const REPO = 'salt';
const PROJECT_NUMBER = 1;

const die = (msg) => {
  console.error(`board: ${msg}`);
  process.exit(1);
};

function gql(query) {
  let out;
  try {
    out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
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
        nodes{ id
          content{ ... on Issue { number title state } }
          queue:fieldValueByName(name:"Queue"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
          status:fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
          blockedBy:fieldValueByName(name:"Blocked by"){ ... on ProjectV2ItemFieldTextValue { text } } } } } } }`)
      .node.items;
    for (const n of page.nodes) {
      if (!n.content?.number) continue; // draft item — not an issue
      items.push({
        id: n.id,
        number: n.content.number,
        title: n.content.title,
        state: n.content.state,
        queue: n.queue?.name ?? null,
        status: n.status?.name ?? null,
        blockedBy: n.blockedBy?.text ?? '',
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    after = `"${page.pageInfo.endCursor}"`;
  }
  return items;
}

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

  const existing = loadItems(project).find((i) => i.number === number);
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

function cmdSet(project, [num, ...rest]) {
  const number = Number(num);
  if (!Number.isInteger(number))
    die('usage: board.mjs set <issue> [--queue X --class Y --size Z --status W]');
  const flags = parseFlags(rest);
  const item = loadItems(project).find((i) => i.number === number);
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
    `{ repository(owner:"${OWNER}",name:"${REPO}"){ pullRequest(number:${number}){ body } } }`,
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
  for (const issue of targets) {
    const item = items.find((i) => i.number === issue);
    if (!item) {
      console.log(`#${issue} is not on the board — skipped`);
      continue;
    }
    setSelect(project, item.id, 'Status', flags.status);
    console.log(`#${issue} → Status=${flags.status}  (PR #${number})`);
  }
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
    child: issue(number:${child}){ id title parent{ id number title } }
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

  // A closed issue is NOT by itself stale. An issue closes the moment its PR
  // merges, and it then has to STAY on the board at `Merged` — that is exactly
  // the set `board.mjs release` walks to find what a production deploy made
  // live. What is wrong is a closed issue that never reached the merge states:
  // either it was closed without shipping (won't-fix, duplicate) and belongs
  // off the board, or a PR closed it without the `Closes #N` that moves it, and
  // the automation is quietly missing work.
  //
  // A LEDGER IS IN THIS RULE, and used to be out of it (2026-09-12). The exemption a
  // ledger carries is QUEUE AND CLASS — it is not work and must not sit in a
  // work queue — and extending that to Status bought nothing while costing the
  // only check that could see the problem: 19 closed ledgers accumulated at no
  // Status, one per campaign ever run, showing up on the Workflow board as a
  // column of cards nobody could account for. A ledger closes when its campaign
  // finishes, and what a finished campaign means is that its work merged.
  const SHIPPING = new Set(['Merged', 'Released']);
  for (const item of items) {
    if (item.state !== 'CLOSED') continue;
    if (item.status === 'Released') {
      console.log(`  note: #${item.number} is Released — safe to remove from the board`);
    } else if (!SHIPPING.has(item.status)) {
      // The remedy differs for a ledger: it has no PR, so nothing automated
      // will ever move it. Its Status comes from the work its title names, and
      // `release` promotes it once all of that work is live.
      failures.push(
        isLedger(item.title)
          ? `#${item.number} is a closed campaign ledger at Status="${item.status ?? 'unset'}" — a ledger has no PR, so set it by hand from its run-set: \`board.mjs set ${item.number} --status Merged\` (or Released if every issue its title names is already Released)`
          : `#${item.number} is closed at Status="${item.status ?? 'unset'}" — it never reached Merged, so either it was closed without shipping (remove it) or its PR had no "Closes #${item.number}"`,
      );
    }
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

  // "No view may carry a sort" is the other half of having no rank field: a
  // sorted view disables dragging in it and renders a different order from the
  // one triage wrote. Group-by and sort-by cannot be SET through the API, but
  // they can be READ — so this is enforceable, and left as prose it would be
  // exactly the unguarded invariant CLAUDE.md rule 12 is about.
  const views = gql(`{ node(id:"${project.id}"){ ... on ProjectV2 {
    views(first:20){ nodes{ number name layout
      groupByFields(first:5){ nodes{ ... on ProjectV2FieldCommon { name } } }
      verticalGroupByFields(first:5){ nodes{ ... on ProjectV2FieldCommon { name } } }
      sortByFields(first:5){ nodes{ direction field{ ... on ProjectV2FieldCommon { name } } } } } } } } }`)
    .node.views.nodes;

  for (const v of views) {
    const sorts = v.sortByFields.nodes.map((s) => `${s.field.name} ${s.direction}`);
    if (sorts.length) {
      failures.push(
        `view ${v.number} "${v.name}" is sorted by ${sorts.join(', ')} — that hides the triage order and disables dragging`,
      );
    }
    // A board's columns ARE its grouping, which GitHub calls the column field.
    const group =
      v.layout === 'BOARD_LAYOUT'
        ? v.verticalGroupByFields.nodes.map((f) => f.name)
        : v.groupByFields.nodes.map((f) => f.name);
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

const [command, ...args] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') {
  console.log(`usage:
  board.mjs add <issue> [--queue X --class Y --size Z --status W]
  board.mjs set <issue> [--queue X --class Y --size Z --status W]
  board.mjs pr <pr> --status "In review"
  board.mjs parent <issue> --of <parent issue> [--detach-from <current parent>]
  board.mjs release --sha <deployed sha>
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
else if (command === 'pr') cmdPr(project, args);
else if (command === 'release') cmdRelease(project, args);
else if (command === 'check') cmdCheck(project);
else die(`unknown command "${command}" — expected add, set, pr, parent, release or check`);
