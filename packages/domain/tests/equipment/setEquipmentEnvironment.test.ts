import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@salt/shared-types';
import { setEquipmentEnvironment } from '@salt/domain';
import type { EquipmentManifest } from '@salt/domain';
import { EquipmentManifestSchema } from '../../src/schemas/equipmentManifest.js';
import type { EquipmentEnvironmentDoc } from '../../src/schemas/equipmentManifest.js';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-02-01T00:00:00.000Z';

function manifestWith(environment: EquipmentEnvironmentDoc | null): EquipmentManifest {
  return {
    schemaVersion: 1,
    updatedAt: NOW,
    items: [
      {
        id: 'eq-1',
        schemaVersion: 1,
        name: 'Curing chamber',
        accessories: [],
        rules: ['Wine fridge with a heat mat and a reptile fogger'],
        environment,
        updatedAt: NOW,
      },
    ],
  };
}

const CHAMBER: EquipmentEnvironmentDoc = {
  control: 'shared',
  minCelsius: 8,
  maxCelsius: 18,
  humidity: { precision: 'approximate', minPercent: 60, maxPercent: 85 },
  standing: { celsius: 12, relativeHumidityPercent: 75 },
};

function envOf(result: ReturnType<typeof setEquipmentEnvironment>) {
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  return result.value.items[0]!.environment;
}

describe('setEquipmentEnvironment', () => {
  it('stores a shared place with its standing setpoint and stamps updatedAt', () => {
    const result = setEquipmentEnvironment(manifestWith(null), {
      equipmentId: 'eq-1',
      environment: CHAMBER,
      now: LATER,
    });
    expect(envOf(result)).toEqual(CHAMBER);
    if (result.kind === 'ok') expect(result.value.items[0]!.updatedAt).toBe(LATER);
  });

  // ── The invariant this command exists to enforce (CLAUDE.md rule 12) ────────
  //
  // The schema carries no `.refine` coupling `control` to `standing` — one bad
  // item would fail the whole single-document manifest. So the claim "a
  // dedicated place carries no standing setpoint" is true of the WRITE PATH, and
  // these are what make it true rather than merely asserted.

  it('drops a standing setpoint offered for a DEDICATED place', () => {
    const result = setEquipmentEnvironment(manifestWith(null), {
      equipmentId: 'eq-1',
      environment: { ...CHAMBER, control: 'dedicated' },
      now: LATER,
    });
    expect(envOf(result)?.standing).toBeNull();
    // Everything else it was told survives — this normalises one field, it does
    // not reject the write.
    expect(envOf(result)?.minCelsius).toBe(8);
    expect(envOf(result)?.humidity).toEqual(CHAMBER.humidity);
  });

  it('drops the standing setpoint when a shared place is switched to dedicated', () => {
    // The second construction path: the stale setpoint arrives from the stored
    // document rather than from the caller.
    const result = setEquipmentEnvironment(manifestWith(CHAMBER), {
      equipmentId: 'eq-1',
      environment: { ...CHAMBER, control: 'dedicated' },
      now: LATER,
    });
    expect(envOf(result)?.standing).toBeNull();
  });

  it('refuses a temperature range that runs backwards', () => {
    const result = setEquipmentEnvironment(manifestWith(null), {
      equipmentId: 'eq-1',
      environment: { ...CHAMBER, minCelsius: 18, maxCelsius: 8 },
      now: LATER,
    });
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error).toEqual({
        kind: 'ValidationError',
        code: ErrorCode.INVALID_EQUIPMENT_ENVIRONMENT,
      });
    }
  });

  it('refuses a humidity range that runs backwards', () => {
    const result = setEquipmentEnvironment(manifestWith(null), {
      equipmentId: 'eq-1',
      environment: {
        ...CHAMBER,
        humidity: { precision: 'controlled', minPercent: 85, maxPercent: 60 },
      },
      now: LATER,
    });
    expect(result.kind).toBe('err');
  });

  it('accepts a single-point range (min equal to max)', () => {
    const result = setEquipmentEnvironment(manifestWith(null), {
      equipmentId: 'eq-1',
      environment: { ...CHAMBER, minCelsius: 12, maxCelsius: 12 },
      now: LATER,
    });
    expect(envOf(result)?.maxCelsius).toBe(12);
  });

  it('turns a place back into ordinary equipment with null', () => {
    const result = setEquipmentEnvironment(manifestWith(CHAMBER), {
      equipmentId: 'eq-1',
      environment: null,
      now: LATER,
    });
    expect(envOf(result)).toBeNull();
  });

  it('reports NotFound for equipment that does not exist', () => {
    const result = setEquipmentEnvironment(manifestWith(null), {
      equipmentId: 'nope',
      environment: CHAMBER,
      now: LATER,
    });
    expect(result.kind).toBe('err');
    if (result.kind === 'err') expect(result.error.kind).toBe('NotFound');
  });
});

describe('EquipmentManifestSchema — back-compat', () => {
  it('parses a document written before places existed, unchanged but for the default', () => {
    // `equipmentManifest/current` holds real production data. Every item in it
    // was written with no `environment` key at all.
    const stored = {
      schemaVersion: 1,
      updatedAt: NOW,
      items: [
        {
          id: 'eq-1',
          schemaVersion: 1,
          name: 'Magimix Cook Expert',
          accessories: [{ id: 'acc-1', name: 'Steam basket', owned: true, included: true }],
          rules: ['Never fill past two-thirds'],
          updatedAt: NOW,
        },
      ],
    };
    const parsed = EquipmentManifestSchema.safeParse(stored);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const item = parsed.data.items[0]!;
    expect(item.environment).toBeNull();
    expect(item.name).toBe('Magimix Cook Expert');
    expect(item.accessories).toHaveLength(1);
    expect(item.rules).toEqual(['Never fill past two-thirds']);
  });

  it('defaults a standing setpoint humidity that was never given', () => {
    const parsed = EquipmentManifestSchema.safeParse({
      schemaVersion: 1,
      updatedAt: NOW,
      items: [
        {
          id: 'eq-1',
          schemaVersion: 1,
          name: 'Curing chamber',
          updatedAt: NOW,
          environment: {
            control: 'shared',
            minCelsius: 8,
            maxCelsius: 18,
            standing: { celsius: 12 },
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const env = parsed.data.items[0]!.environment;
    expect(env?.humidity).toBeNull();
    expect(env?.standing?.relativeHumidityPercent).toBeNull();
  });

  it('rejects a humidity reading outside 0–100', () => {
    const parsed = EquipmentManifestSchema.safeParse({
      schemaVersion: 1,
      updatedAt: NOW,
      items: [
        {
          id: 'eq-1',
          schemaVersion: 1,
          name: 'Curing chamber',
          updatedAt: NOW,
          environment: {
            control: 'dedicated',
            minCelsius: 8,
            maxCelsius: 18,
            humidity: { precision: 'controlled', minPercent: 0, maxPercent: 140 },
          },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
