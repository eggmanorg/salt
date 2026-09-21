// The BigQuery export's configuration, made mechanical.
//
// `infra/bigquery-export/extensions/*.env` configures the six Firestore →
// BigQuery export instances, and the BigQuery changelog is the only history of
// what Salt's data used to be — nothing reconstructs it after the fact. An
// extension parameter the published extension does not recognise is NOT an
// install-time error: it is dropped and replaced by the declared default, and
// the install goes green. PR #1424 shipped `WILDCARD_IDS=yes` where the
// extension declares `true`/`false`; had it merged, every batch observation
// from that day on would have streamed with no reference to the run it came
// from, permanently. A person caught it. These functions are what make the
// safety claim in `bq-export-batch-observations.env:15-22` true rather than
// merely written down (CLAUDE.md rule 12).
//
// THE LIMIT, stated because it cannot be closed: this validates what the `.env`
// SAYS, against the schema the repo pins. A parameter OMITTED from an `.env`,
// whose extension default happens to be wrong for Salt, is invisible here —
// that is a judgement about intent, not a schema fact. Twelve-odd parameters
// are deliberately omitted across the six files today, so flagging absence
// wholesale would need an allowlist, and an allowlist is a thing people learn
// to append to. The one absence that IS a schema fault — a `required: true`
// parameter with no declared default — is caught, because the vendored yaml
// answers that question rather than a maintained list. What the defaults ought
// to be is recorded in infra/bigquery-export/README.md, not here.
//
// Also outside this file's reach, deliberately: whether the instance ids in
// `firebase.json` match what is actually installed on prod. That needs a live
// read of the project; nothing here may contact one.

import { parse as parseYaml } from 'yaml';

/**
 * Read the declared parameters out of a vendored `extension.yaml`.
 *
 * @param {string} yamlText
 * @returns {{ id: string, version: string, params: Map<string, {
 *   name: string, type: string, required: boolean, hasDefault: boolean,
 *   options: string[] | null, validationRegex: string | null }> }}
 */
export function parseExtensionParams(yamlText) {
  const doc = parseYaml(yamlText);
  const params = new Map();

  for (const spec of doc?.params ?? []) {
    const name = spec?.param;
    if (typeof name !== 'string') continue;
    params.set(name, {
      name,
      // `DATABASE` declares no `type:` at all in 0.3.3. The extension treats an
      // untyped parameter as a free string, so this does too — it carries no
      // `validationRegex` either, so there is nothing to check but presence.
      type: typeof spec.type === 'string' ? spec.type : 'string',
      required: spec.required === true,
      hasDefault: Object.hasOwn(spec, 'default'),
      options: Array.isArray(spec.options)
        ? // String() BOTH sides, here and at the comparison. This is
          // load-bearing, not defensive: `WILDCARD_IDS`'s options are written
          // unquoted (`value: true`) so YAML hands them back as BOOLEANS, while
          // `USE_NEW_SNAPSHOT_QUERY_SYNTAX`'s are `yes`/`no`, which YAML 1.2
          // keeps as STRINGS. An `.env` value is always a string. Compare
          // without stringifying and the check accepts `WILDCARD_IDS=yes` and
          // rejects `WILDCARD_IDS=true` — exactly inverted, and green. That
          // asymmetry between two adjacent parameters is what made #1424's
          // mistake plausible in the first place.
          spec.options.map((option) => String(option?.value))
        : null,
      validationRegex: typeof spec.validationRegex === 'string' ? spec.validationRegex : null,
    });
  }

  return {
    id: typeof doc?.name === 'string' ? doc.name : '',
    version: typeof doc?.version === 'string' ? doc.version : String(doc?.version ?? ''),
    params,
  };
}

/**
 * Read one `.env` file. Whole-line `#` comments and blank lines are skipped; a
 * key is everything before the FIRST `=`, so a value may contain `=` freely.
 * Values are trimmed, matching what the installer's dotenv reader does — a
 * leading space in `FOO= true` reaches the extension as `true`, so reporting it
 * as a bad value would be this check disagreeing with the thing it models.
 *
 * @param {string} text
 * @returns {{ values: Map<string, string>, malformed: { line: number, text: string }[] }}
 */
export function parseEnvFile(text) {
  const values = new Map();
  const malformed = [];

  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || /^\s*#/.test(line)) return;
    const eq = line.indexOf('=');
    if (eq === -1) {
      malformed.push({ line: index + 1, text: line.trim() });
      return;
    }
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  });

  return { values, malformed };
}

/** `firebase/firestore-bigquery-export@0.3.3` -> `{ id, version }`. */
const splitRef = (ref) => {
  const at = ref.lastIndexOf('@');
  if (at <= 0) return null;
  const publisherAndId = ref.slice(0, at);
  const slash = publisherAndId.lastIndexOf('/');
  if (slash <= 0) return null;
  return { id: publisherAndId.slice(slash + 1), version: ref.slice(at + 1) };
};

/**
 * @param {object} args
 * @param {{ extensions?: Record<string, string> }} args.manifest  parsed `firebase.json`
 * @param {{ name: string, instance: string, parsed: ReturnType<typeof parseEnvFile> }[]} args.envFiles
 * @param {Map<string, object>} args.params  from `parseExtensionParams`
 * @param {{ id: string, version: string }} args.pinnedVersion  the vendored yaml's own `name:`/`version:`
 * @returns {string[]} problems, empty when everything holds
 */
export function auditExtensionManifest({ manifest, envFiles, params, pinnedVersion }) {
  const problems = [];
  const instances = manifest?.extensions ?? {};

  // The vendored schema is asserted against the pin, never trusted to match it.
  // Bumping a ref without re-vendoring would leave the check validating against
  // a schema the install no longer uses — the same class of silent wrongness it
  // exists to stop, only now wearing a green tick.
  for (const [instance, ref] of Object.entries(instances)) {
    const parts = splitRef(ref);
    if (!parts) {
      problems.push(
        `firebase.json: instance "${instance}" has an unreadable extension ref "${ref}" — expected publisher/extension@version.`,
      );
      continue;
    }
    if (parts.id !== pinnedVersion.id || parts.version !== pinnedVersion.version) {
      problems.push(
        `firebase.json: instance "${instance}" pins "${ref}", but the vendored schema is ` +
          `${pinnedVersion.id}@${pinnedVersion.version}. Re-vendor infra/bigquery-export/vendor/ ` +
          `for the new version — re-vendoring is part of a version bump, not a follow-up to one.`,
      );
    }
  }

  // An orphan in either direction is a claim about what is installed that is
  // not true: a `.env` with no instance configures nothing, and an instance
  // with no `.env` installs on the extension's defaults throughout.
  const envByInstance = new Map(envFiles.map((file) => [file.instance, file]));
  for (const instance of Object.keys(instances)) {
    if (!envByInstance.has(instance)) {
      problems.push(
        `firebase.json declares instance "${instance}", but extensions/${instance}.env does not exist.`,
      );
    }
  }
  for (const file of envFiles) {
    if (!Object.hasOwn(instances, file.instance)) {
      problems.push(
        `${file.name}: no instance "${file.instance}" in firebase.json — the file configures nothing.`,
      );
    }
  }

  for (const file of envFiles) {
    for (const bad of file.parsed.malformed) {
      problems.push(`${file.name}:${bad.line}: not a KEY=VALUE line — "${bad.text}".`);
    }

    for (const [key, value] of file.parsed.values) {
      const spec = params.get(key);
      if (!spec) {
        problems.push(
          `${file.name}: "${key}" is not a parameter this extension declares. ` +
            `A key the extension does not recognise is ignored at install time, silently.`,
        );
        continue;
      }

      if (spec.options) {
        if (!spec.options.includes(String(value))) {
          problems.push(
            `${file.name}: ${key}=${value} is not one of the values the extension accepts — ` +
              `${spec.options.join(' / ')}. An unrecognised value installs as the default instead.`,
          );
        }
        continue;
      }

      if (spec.validationRegex && !new RegExp(spec.validationRegex).test(value)) {
        problems.push(
          `${file.name}: ${key}=${value} fails the extension's own validation ` +
            `${spec.validationRegex}.`,
        );
      }
    }

    // Absence is a fault only where the schema says so: required, and with no
    // default to fall back to. See THE LIMIT at the top of this file.
    for (const spec of params.values()) {
      if (spec.required && !spec.hasDefault && !file.parsed.values.has(spec.name)) {
        problems.push(
          `${file.name}: ${spec.name} is required and the extension declares no default for it, ` +
            `so it must be set here.`,
        );
      }
    }
  }

  return problems;
}
