/**
 * Source guard: W3C Baggage propagation stays OFF in Cloud Functions.
 *
 * `enableFirebaseTelemetry()` hands Genkit's NodeSDK `propagator: undefined`, so
 * `BasicTracerProvider.register()` builds the global composite propagator from
 * `OTEL_PROPAGATORS`, whose OTel default is `tracecontext,baggage`. That puts
 * `W3CBaggagePropagator.extract()` on the INBOUND path of every callable, via
 * `runWithExtractedTraceContext(request.rawRequest.headers, …)` — and
 * `@opentelemetry/core` < 2.8.0 allocates unboundedly there when fed an oversized
 * `baggage` header (CVE-2026-54285 / GHSA-8988-4f7v-96qf, dependabot alert #79).
 * A client controls its own request headers, so that is a remote memory-exhaustion
 * reachable from any authenticated caller.
 *
 * The patch ships only in the OTel 2.x suite, which is blocked upstream on Genkit
 * adopting it (#300 — and `.github/dependabot.yml` suppresses the major for that
 * reason). So index.ts removes the REACHABILITY instead of the vulnerable code:
 * it pins `OTEL_PROPAGATORS=tracecontext` before the provider is registered.
 * Nothing in this repo reads or writes baggage, and every propagation path we rely
 * on — the two `runWith*TraceContext` helpers, `activeTraceparent()`, Genkit's HTTP
 * auto-instrumentation — is W3C tracecontext only.
 *
 * Until this file, that mitigation was ONE line guarded by a comment (CLAUDE.md
 * rule 12: an invariant you state, you make mechanical). Deleting it, reordering it
 * after `enableFirebaseTelemetry()`, or adding `baggage` back to the value would
 * silently re-open the CVE with every test still green.
 *
 * Deliberately a SOURCE scan: importing index.ts would drag in firebase-functions
 * module init, and the ORDER of two statements is exactly what a runtime assertion
 * on the resulting env var cannot see.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');
const entrypoint = join(srcDir, 'index.ts');

/** Every `.ts` under `src`, walked — never a hand-kept list. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

// Strip comments so the prose ABOUT the mitigation never satisfies the guard, and
// so a mention of `baggage` in a comment never fails it.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// `process.env['OTEL_PROPAGATORS'] ||= '…'` — any assignment form, any quoting.
const ASSIGNMENT =
  /process\.env\[\s*['"`]OTEL_PROPAGATORS['"`]\s*\]\s*(?:\|\|=|\?\?=|=)\s*['"`]([^'"`]*)['"`]/;
const TELEMETRY_BOOT = /\benableFirebaseTelemetry\s*\(/;

function propagatorsOf(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

describe('W3C Baggage propagation is disabled in Cloud Functions', () => {
  const code = stripComments(readFileSync(entrypoint, 'utf8'));

  it('index.ts pins OTEL_PROPAGATORS', () => {
    expect(
      ASSIGNMENT.test(code),
      'src/index.ts must assign process.env.OTEL_PROPAGATORS — without it OTel ' +
        "defaults to 'tracecontext,baggage' and CVE-2026-54285 becomes reachable.",
    ).toBe(true);
  });

  it('pins it to a value that excludes baggage', () => {
    const value = ASSIGNMENT.exec(code)?.[1] ?? '';
    const names = propagatorsOf(value);

    expect(names).not.toContain('baggage');
    // An empty value disables propagation entirely and would break distributed
    // tracing; tracecontext is what every path in this repo actually uses.
    expect(names).toContain('tracecontext');
  });

  it('pins it BEFORE enableFirebaseTelemetry() builds the composite', () => {
    const assignedAt = code.search(ASSIGNMENT);
    const bootAt = code.search(TELEMETRY_BOOT);

    expect(bootAt, 'enableFirebaseTelemetry() call not found in src/index.ts').toBeGreaterThan(-1);
    expect(
      assignedAt,
      'OTEL_PROPAGATORS must be set before enableFirebaseTelemetry() — the ' +
        'composite propagator is built during that call and reads the env var once.',
    ).toBeLessThan(bootAt);
  });

  it('no file under src re-enables baggage', () => {
    const offenders = walk(srcDir)
      .map((file) => ({ file, code: stripComments(readFileSync(file, 'utf8')) }))
      .filter(({ code: source }) => {
        const value = ASSIGNMENT.exec(source)?.[1];
        return value !== undefined && propagatorsOf(value).includes('baggage');
      })
      .map(({ file }) => relative(srcDir, file));

    expect(offenders).toEqual([]);
  });
});
