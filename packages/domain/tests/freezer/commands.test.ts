import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@salt/shared-types';
import {
  addFreezer,
  emptyFreezerConfig,
  removeFreezer,
  renameFreezer,
  setShelves,
} from '@salt/domain';
import type { FreezerConfig, FreezerIdGenerator } from '@salt/domain';
import { FreezerConfigSchema } from '@salt/domain/schemas';

// The freezer setup's four commands (issue #1682). Configuring the places at all
// exists so that "Garage" and "garage" cannot become two of them — so every
// refusal below also asserts the config came back untouched.

const NOW = '2026-10-12T09:00:00.000Z';
const NOW2 = '2026-10-12T10:00:00.000Z';

function makeIds(): FreezerIdGenerator {
  let seq = 0;
  return { newFreezerId: () => `fz-${++seq}` };
}

function configWith(freezers: FreezerConfig['freezers']): FreezerConfig {
  return { schemaVersion: 1, updatedAt: NOW, freezers };
}

const GARAGE = { id: 'fz-garage', name: 'Garage', shelves: ['A', 'B', 'C', 'D'] };
const KITCHEN = { id: 'fz-kitchen', name: 'Kitchen', shelves: ['Top', 'Bottom'] };

function ok<T>(r: { kind: string; value?: T }): T {
  expect(r.kind).toBe('ok');
  return r.value as T;
}

function validationCode(r: { kind: string; error?: unknown }): unknown {
  expect(r.kind).toBe('err');
  const error = r.error as { kind: string; code?: string };
  expect(error.kind).toBe('ValidationError');
  return error.code;
}

describe('emptyFreezerConfig', () => {
  it('is a config with no freezers, stamped with the time it was made, that the read schema accepts', () => {
    const config = emptyFreezerConfig(NOW);
    expect(config).toEqual({ schemaVersion: 1, updatedAt: NOW, freezers: [] });
    expect(FreezerConfigSchema.safeParse(config).success).toBe(true);
  });
});

describe('addFreezer', () => {
  it('appends a freezer with a minted id, its trimmed name and its shelves in order', () => {
    const config = ok(
      addFreezer(
        emptyFreezerConfig(NOW),
        { name: '  Garage ', shelves: [' A', 'B ', 'C', 'D'], now: NOW2 },
        makeIds(),
      ),
    );
    expect(config.freezers).toEqual([
      { id: 'fz-1', name: 'Garage', shelves: ['A', 'B', 'C', 'D'] },
    ]);
    expect(config.updatedAt).toBe(NOW2);
  });

  it('adds a freezer with no shelves when none are given', () => {
    const config = ok(addFreezer(configWith([GARAGE]), { name: 'Kitchen', now: NOW }, makeIds()));
    expect(config.freezers.map((f) => f.name)).toEqual(['Garage', 'Kitchen']);
    expect(config.freezers[1]?.shelves).toEqual([]);
  });

  it('mints the id from the generator, never from the name', () => {
    const config = ok(
      addFreezer(
        emptyFreezerConfig(NOW),
        { name: 'Garage', now: NOW },
        { newFreezerId: () => 'x9' },
      ),
    );
    expect(config.freezers[0]?.id).toBe('x9');
  });

  it.each([[''], ['   ']])('refuses a blank name (%j)', (name) => {
    const before = configWith([GARAGE]);
    const result = addFreezer(before, { name, now: NOW2 }, makeIds());
    expect(validationCode(result)).toBe(ErrorCode.INVALID_FREEZER_NAME);
    expect(before.freezers).toEqual([GARAGE]);
  });

  it('refuses a name another freezer already has, case-insensitively after trimming', () => {
    const result = addFreezer(configWith([GARAGE]), { name: ' garage ', now: NOW2 }, makeIds());
    expect(validationCode(result)).toBe(ErrorCode.DUPLICATE_FREEZER_NAME);
  });

  it('refuses a blank shelf label', () => {
    const result = addFreezer(
      emptyFreezerConfig(NOW),
      { name: 'Garage', shelves: ['A', '  '], now: NOW2 },
      makeIds(),
    );
    expect(validationCode(result)).toBe(ErrorCode.INVALID_SHELF_LABEL);
  });

  it('refuses a shelf label repeated within the freezer', () => {
    const result = addFreezer(
      emptyFreezerConfig(NOW),
      { name: 'Garage', shelves: ['A', 'B', 'a '], now: NOW2 },
      makeIds(),
    );
    expect(validationCode(result)).toBe(ErrorCode.DUPLICATE_SHELF_LABEL);
  });

  it('allows the same shelf label on two different freezers', () => {
    const config = ok(
      addFreezer(configWith([GARAGE]), { name: 'Kitchen', shelves: ['A'], now: NOW2 }, makeIds()),
    );
    expect(config.freezers[1]?.shelves).toEqual(['A']);
  });
});

describe('renameFreezer', () => {
  it('renames the freezer and keeps its id — stock will point at that id', () => {
    const config = ok(
      renameFreezer(configWith([GARAGE, KITCHEN]), { id: GARAGE.id, name: ' Shed ', now: NOW2 }),
    );
    expect(config.freezers[0]).toEqual({ ...GARAGE, name: 'Shed' });
    expect(config.freezers[1]).toEqual(KITCHEN);
    expect(config.updatedAt).toBe(NOW2);
  });

  it('lets a freezer keep its own name, or change only its case', () => {
    const config = ok(
      renameFreezer(configWith([GARAGE]), { id: GARAGE.id, name: 'GARAGE', now: NOW2 }),
    );
    expect(config.freezers[0]?.name).toBe('GARAGE');
  });

  it('refuses a blank name', () => {
    const result = renameFreezer(configWith([GARAGE]), { id: GARAGE.id, name: ' ', now: NOW2 });
    expect(validationCode(result)).toBe(ErrorCode.INVALID_FREEZER_NAME);
  });

  it("refuses another freezer's name, case-insensitively", () => {
    const result = renameFreezer(configWith([GARAGE, KITCHEN]), {
      id: KITCHEN.id,
      name: 'garage',
      now: NOW2,
    });
    expect(validationCode(result)).toBe(ErrorCode.DUPLICATE_FREEZER_NAME);
  });

  it('reports a freezer that is not there as NotFound, before judging the name', () => {
    const result = renameFreezer(configWith([GARAGE]), { id: 'gone', name: '', now: NOW2 });
    expect(result).toEqual({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'freezer', id: 'gone' },
    });
  });
});

describe('setShelves', () => {
  it('replaces the shelves, trimmed and in the order given', () => {
    const config = ok(
      setShelves(configWith([GARAGE, KITCHEN]), {
        id: GARAGE.id,
        shelves: ['D', ' C', 'B ', 'A', 'E'],
        now: NOW2,
      }),
    );
    expect(config.freezers[0]).toEqual({ ...GARAGE, shelves: ['D', 'C', 'B', 'A', 'E'] });
    expect(config.freezers[1]).toEqual(KITCHEN);
    expect(config.updatedAt).toBe(NOW2);
  });

  it('removes a shelf unconditionally, and may leave a freezer with none', () => {
    const config = ok(setShelves(configWith([GARAGE]), { id: GARAGE.id, shelves: [], now: NOW2 }));
    expect(config.freezers[0]?.shelves).toEqual([]);
  });

  it('refuses a blank label', () => {
    const result = setShelves(configWith([GARAGE]), {
      id: GARAGE.id,
      shelves: ['A', ''],
      now: NOW2,
    });
    expect(validationCode(result)).toBe(ErrorCode.INVALID_SHELF_LABEL);
  });

  it('refuses a repeated label', () => {
    const result = setShelves(configWith([GARAGE]), {
      id: GARAGE.id,
      shelves: ['A', 'B', ' b'],
      now: NOW2,
    });
    expect(validationCode(result)).toBe(ErrorCode.DUPLICATE_SHELF_LABEL);
  });

  it('reports a freezer that is not there as NotFound', () => {
    const result = setShelves(configWith([GARAGE]), { id: 'gone', shelves: ['A'], now: NOW2 });
    expect(result.kind === 'err' && result.error.kind).toBe('NotFound');
  });
});

describe('removeFreezer', () => {
  it('removes the freezer and its shelves, leaving the others in order', () => {
    const config = ok(removeFreezer(configWith([GARAGE, KITCHEN]), { id: GARAGE.id, now: NOW2 }));
    expect(config.freezers).toEqual([KITCHEN]);
    expect(config.updatedAt).toBe(NOW2);
  });

  it('reports a freezer that is not there as NotFound', () => {
    const result = removeFreezer(configWith([GARAGE]), { id: 'gone', now: NOW2 });
    expect(result).toEqual({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'freezer', id: 'gone' },
    });
  });
});
