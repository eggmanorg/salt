/**
 * The characterization suite for `scripts/lib/bigqueryExtensionEnv.mjs` (#1472).
 *
 * The guard cannot characterise itself: the six real `.env` files are all valid,
 * so a rule quietly narrowed to nothing would sit green over them forever —
 * which is precisely the state the repo was in before this existed. So the
 * shapes are fed to the rule module directly, the way `rawPalette`,
 * `schemaCatchSites` and `unitTestSpec` do it. `CATCHES` are configurations the
 * audit MUST report on; `MISSES` are the near-misses it must stay silent about.
 *
 * Every fixture is audited against the REAL vendored `extension.yaml`, not a
 * hand-written stand-in. A stand-in would let the two tests that matter most —
 * `WILDCARD_IDS=yes` red and `WILDCARD_IDS=true` green — pass against a schema
 * someone wrote to make them pass.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditExtensionManifest,
  parseEnvFile,
  parseExtensionParams,
} from '../lib/bigqueryExtensionEnv.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INFRA = path.join(REPO_ROOT, 'infra', 'bigquery-export');

const vendoredName = readdirSync(path.join(INFRA, 'vendor')).find((file) =>
  file.endsWith('.extension.yaml'),
);
const { id, version, params } = parseExtensionParams(
  readFileSync(path.join(INFRA, 'vendor', vendoredName), 'utf8'),
);
const PINNED = { id, version };

/** The batch-observation instance as it stands on main, minus its comments. */
const BASE = `DATASET_LOCATION=us
DATABASE=(default)
DATABASE_REGION=nam5
COLLECTION_PATH=batches/{batchId}/observations
DATASET_ID=firestore_export
TABLE_ID=batchObservations
VIEW_TYPE=view
WILDCARD_IDS=true
USE_NEW_SNAPSHOT_QUERY_SYNTAX=yes
`;

const INSTANCE = 'bq-export-batch-observations';
const FILE_NAME = `infra/bigquery-export/extensions/${INSTANCE}.env`;

/** Audit a single `.env` body against a one-instance manifest on the pinned ref. */
const auditOne = (text, { instance = INSTANCE, manifestInstances = [INSTANCE] } = {}) =>
  auditExtensionManifest({
    manifest: {
      extensions: Object.fromEntries(
        manifestInstances.map((name) => [name, `firebase/${id}@${version}`]),
      ),
    },
    envFiles: [
      {
        name: `infra/bigquery-export/extensions/${instance}.env`,
        instance,
        parsed: parseEnvFile(text),
      },
    ],
    params,
    pinnedVersion: PINNED,
  });

describe('the #1424 regression', () => {
  it('reports WILDCARD_IDS=yes, naming the parameter and the values the extension accepts', () => {
    const problems = auditOne(BASE.replace('WILDCARD_IDS=true', 'WILDCARD_IDS=yes'));

    // Assert on the message, not only the count: a count-only assertion
    // survives this rule being replaced by a different one that happens to fire.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(FILE_NAME);
    expect(problems[0]).toContain('WILDCARD_IDS');
    expect(problems[0]).toContain('true');
    expect(problems[0]).toContain('false');
  });

  it('accepts WILDCARD_IDS=true and USE_NEW_SNAPSHOT_QUERY_SYNTAX=yes together', () => {
    // The inverse, and the one a careless implementation gets wrong. In the
    // extension manifest WILDCARD_IDS' options are unquoted (`value: true`) so
    // YAML yields BOOLEANS, while USE_NEW_SNAPSHOT_QUERY_SYNTAX's `yes`/`no`
    // stay STRINGS. A comparison that forgot to stringify passes the test above
    // and fails this one — with the two rules exactly inverted, and green.
    expect(auditOne(BASE)).toEqual([]);
  });
});

/** [name, `.env` body, a fragment the reported problem must contain] */
const CATCHES = [
  [
    'a misspelled parameter name',
    BASE.replace('WILDCARD_IDS=true', 'WILDCRD_IDS=true'),
    'WILDCRD_IDS',
  ],
  [
    'a select value outside its declared options',
    BASE.replace('VIEW_TYPE=view', 'VIEW_TYPE=table'),
    'VIEW_TYPE=table',
  ],
  [
    'a TABLE_ID the extension’s own regex rejects',
    BASE.replace('TABLE_ID=batchObservations', 'TABLE_ID=batch-observations'),
    'TABLE_ID=batch-observations',
  ],
  [
    'a COLLECTION_PATH the extension’s own regex rejects',
    BASE.replace(
      'COLLECTION_PATH=batches/{batchId}/observations',
      'COLLECTION_PATH=batches/{batchId}',
    ),
    'COLLECTION_PATH=batches/{batchId}',
  ],
  [
    'DATABASE_REGION absent — required, and the extension declares no default',
    BASE.replace('DATABASE_REGION=nam5\n', ''),
    'DATABASE_REGION',
  ],
  ['a line that is not KEY=VALUE', `${BASE}WILDCARD_IDS\n`, 'not a KEY=VALUE line'],
];

describe.each(CATCHES)('catches %s', (_name, text, fragment) => {
  it('reports it', () => {
    const problems = auditOne(text);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(fragment);
  });
});

/**
 * Near-misses. Each contains something that LOOKS like the shape a rule fires
 * on — that is the anti-vacuity floor: a "near-miss" with nothing suspicious in
 * it proves nothing about a check that matches suspicious things.
 */
const MISSES = [
  ['WILDCARD_IDS=yes inside a whole-line comment', `# never write WILDCARD_IDS=yes here\n${BASE}`],
  ['an indented comment', `${BASE}  # WILDCARD_IDS=yes\n`],
  ['blank lines and a trailing newline', `\n${BASE}\n\n`],
  ['a CRLF line ending', BASE.replace(/\n/g, '\r\n')],
  ['braces in COLLECTION_PATH', BASE],
  ['parentheses in DATABASE=(default)', BASE],
  [
    'a value that itself contains =',
    `${BASE}TRANSFORM_FUNCTION=https://europe-west2-x.cloudfunctions.net/t?v=2&mode=a=b\n`,
  ],
  [
    'whitespace around the = and after the value',
    BASE.replace('VIEW_TYPE=view', 'VIEW_TYPE= view '),
  ],
];

describe.each(MISSES)('stays silent on %s', (_name, text) => {
  it('reports nothing', () => {
    expect(auditOne(text)).toEqual([]);
  });
});

describe('the manifest and the .env files must agree', () => {
  it('reports an .env with no instance in firebase.json', () => {
    const problems = auditOne(BASE, { instance: 'bq-export-ghost' });
    expect(problems.join('\n')).toContain('bq-export-ghost');
    expect(problems.join('\n')).toContain('configures nothing');
  });

  it('reports an instance in firebase.json with no .env', () => {
    const problems = auditOne(BASE, { manifestInstances: [INSTANCE, 'bq-export-phantom'] });
    expect(problems.join('\n')).toContain('bq-export-phantom.env does not exist');
  });
});

describe('the vendored schema is asserted against the pin, not trusted to match it', () => {
  it('reports a ref bumped off the vendored version', () => {
    const problems = auditExtensionManifest({
      manifest: { extensions: { [INSTANCE]: `firebase/${id}@0.4.0` } },
      envFiles: [{ name: FILE_NAME, instance: INSTANCE, parsed: parseEnvFile(BASE) }],
      params,
      pinnedVersion: PINNED,
    });
    expect(problems.join('\n')).toContain('Re-vendor');
    expect(problems.join('\n')).toContain(`${id}@${version}`);
  });

  it('reports a ref pointing at a different extension entirely', () => {
    const problems = auditExtensionManifest({
      manifest: { extensions: { [INSTANCE]: `firebase/firestore-send-email@${version}` } },
      envFiles: [{ name: FILE_NAME, instance: INSTANCE, parsed: parseEnvFile(BASE) }],
      params,
      pinnedVersion: PINNED,
    });
    expect(problems.join('\n')).toContain('firestore-send-email');
  });

  it('reports a ref with no version at all', () => {
    const problems = auditExtensionManifest({
      manifest: { extensions: { [INSTANCE]: './local-copy' } },
      envFiles: [{ name: FILE_NAME, instance: INSTANCE, parsed: parseEnvFile(BASE) }],
      params,
      pinnedVersion: PINNED,
    });
    expect(problems.join('\n')).toContain('unreadable extension ref');
  });
});

describe('the vendored schema itself', () => {
  it('parses the parameters the rules depend on, with the true/false vs yes/no asymmetry intact', () => {
    // If either of these ever changes shape upstream, the two tests at the top
    // could both pass while checking nothing — so the shape is pinned here.
    expect(params.get('WILDCARD_IDS').options).toEqual(['false', 'true']);
    expect(params.get('USE_NEW_SNAPSHOT_QUERY_SYNTAX').options).toEqual(['yes', 'no']);
    expect(params.get('TABLE_ID').validationRegex).toBe('^[a-zA-Z0-9_]+$');
    expect(params.get('DATABASE_REGION').required).toBe(true);
    expect(params.get('DATABASE_REGION').hasDefault).toBe(false);
  });
});

describe('the six real files', () => {
  it('audit clean — the regression floor, so a later .env edit cannot land silently wrong', () => {
    const manifest = JSON.parse(readFileSync(path.join(INFRA, 'firebase.json'), 'utf8'));
    const envDir = path.join(INFRA, 'extensions');
    const envFiles = readdirSync(envDir)
      .filter((file) => file.endsWith('.env'))
      .sort()
      .map((file) => ({
        name: path.posix.join('infra/bigquery-export/extensions', file),
        instance: file.slice(0, -'.env'.length),
        parsed: parseEnvFile(readFileSync(path.join(envDir, file), 'utf8')),
      }));

    expect(envFiles).toHaveLength(6);
    expect(auditExtensionManifest({ manifest, envFiles, params, pinnedVersion: PINNED })).toEqual(
      [],
    );
  });
});
