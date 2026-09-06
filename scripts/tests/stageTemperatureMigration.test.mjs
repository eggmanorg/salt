import { describe, it, expect } from 'vitest';
import {
  migrateStageNode,
  migrateStagesNode,
  needsWrite,
} from '../lib/stageTemperatureMigration.mjs';

// The raw Firestore REST shapes, written out as Firestore actually sends them —
// the whole point of the transform is that it never decodes them.

function stage(environment) {
  return { mapValue: { fields: { label: { stringValue: 'Bulk ferment' }, environment } } };
}

const NULL_ENV = { nullValue: 'NULL_VALUE' };

function legacy(celsiusNode) {
  return { mapValue: { fields: { celsius: celsiusNode } } };
}

describe('migrateStageNode', () => {
  it('lifts a bare celsius to the fixed variant and names no place', () => {
    const node = stage(legacy({ integerValue: '20' }));
    expect(migrateStageNode(node)).toBe('migrated');
    expect(node.mapValue.fields.environment.mapValue.fields).toEqual({
      temperature: {
        mapValue: { fields: { kind: { stringValue: 'fixed' }, celsius: { integerValue: '20' } } },
      },
      equipmentId: { nullValue: 'NULL_VALUE' },
    });
  });

  it('preserves the stored number TYPE rather than round-tripping through JS', () => {
    // A decode/re-encode would have to guess, and would silently turn a stored
    // double into an integer or the other way about.
    const node = stage(legacy({ doubleValue: 20.5 }));
    migrateStageNode(node);
    const temp = node.mapValue.fields.environment.mapValue.fields.temperature.mapValue.fields;
    expect(temp.celsius).toEqual({ doubleValue: 20.5 });
  });

  it('carries an existing humidity reading through untouched', () => {
    const node = stage({
      mapValue: {
        fields: {
          celsius: { integerValue: '12' },
          relativeHumidityPercent: { integerValue: '75' },
        },
      },
    });
    migrateStageNode(node);
    expect(node.mapValue.fields.environment.mapValue.fields.relativeHumidityPercent).toEqual({
      integerValue: '75',
    });
  });

  it('leaves an already-migrated stage completely alone (safe to re-run)', () => {
    const node = stage(legacy({ integerValue: '20' }));
    migrateStageNode(node);
    const after = JSON.stringify(node);
    expect(migrateStageNode(node)).toBe('already');
    expect(JSON.stringify(node)).toBe(after);
  });

  it('reports a stage whose environment has neither shape rather than guessing', () => {
    const node = stage({
      mapValue: { fields: { relativeHumidityPercent: { integerValue: '75' } } },
    });
    expect(migrateStageNode(node)).toBe('unreadable');
    expect(node.mapValue.fields.environment.mapValue.fields.temperature).toBeUndefined();
  });

  it('says nothing to do for a stage with no environment at all', () => {
    expect(migrateStageNode(stage(NULL_ENV))).toBe('none');
    expect(migrateStageNode(undefined)).toBe('none');
  });
});

describe('migrateStagesNode / needsWrite', () => {
  it('reports one outcome per stage, in order', () => {
    const stages = {
      arrayValue: {
        values: [stage(NULL_ENV), stage(legacy({ integerValue: '20' })), stage(NULL_ENV)],
      },
    };
    expect(migrateStagesNode(stages)).toEqual(['none', 'migrated', 'none']);
  });

  it('handles a document with no stages array', () => {
    expect(migrateStagesNode(undefined)).toEqual([]);
    expect(needsWrite([])).toBe(false);
  });

  it('asks for a write only when something actually changed', () => {
    expect(needsWrite(['none', 'already', 'unreadable'])).toBe(false);
    expect(needsWrite(['none', 'migrated'])).toBe(true);
  });
});
