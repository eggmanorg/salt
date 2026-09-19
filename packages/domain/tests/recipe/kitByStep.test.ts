import { describe, it, expect } from 'vitest';
import { kitByStep, newStep } from '@salt/domain';
import type { Step } from '@salt/domain';
import type { RecipeKitEntryDoc } from '@salt/domain/schemas';

// The contiguous-run rule (issue #882), which is the whole reason this query
// exists: a pan is drawn at the step it comes OUT, not at every step that uses
// it. Every case below is a shape a real recipe produces, and the ones about
// stale ids are the ones that keep an edited recipe honest.

// Six steps is enough for a five-long run and a gap on either side of it.
const STEPS: Step[] = ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'].map((id, i) =>
  newStep(id, `Step ${i + 1}`),
);

function entry(label: string, stepIds: string[]): RecipeKitEntryDoc {
  return { label, stepIds, equipment: null };
}

/** The labels drawn at one step, in the order the row would render them. */
function labelsAt(map: Map<string, RecipeKitEntryDoc[]>, stepId: string): string[] {
  return (map.get(stepId) ?? []).map((e) => e.label);
}

describe('kitByStep', () => {
  it('draws a five-consecutive-step run ONCE, at the step it comes out', () => {
    // Without this the method becomes a column of the same frying pan five times.
    const map = kitByStep([entry('frying pan', ['s-2', 's-3', 's-4', 's-5', 's-6'])], STEPS);

    expect(labelsAt(map, 's-2')).toEqual(['frying pan']);
    for (const later of ['s-3', 's-4', 's-5', 's-6']) {
      expect(map.get(later)).toBeUndefined();
    }
  });

  it('draws a GAPPED run twice — put down at 5, picked up again at 6', () => {
    const map = kitByStep([entry('mixing bowl', ['s-1', 's-6'])], STEPS);

    expect(labelsAt(map, 's-1')).toEqual(['mixing bowl']);
    expect(labelsAt(map, 's-6')).toEqual(['mixing bowl']);
    expect([...map.keys()]).toEqual(['s-1', 's-6']);
  });

  it('keeps two tools that start at the same step, in kit order', () => {
    const map = kitByStep(
      [entry('colander', ['s-3']), entry('potato masher', ['s-3', 's-4'])],
      STEPS,
    );

    expect(labelsAt(map, 's-3')).toEqual(['colander', 'potato masher']);
    expect(map.get('s-4')).toBeUndefined();
  });

  it('resolves out-of-order stepIds against RECIPE order', () => {
    // Nothing promises the model returned them sorted, and an unsorted list must
    // not invent a run boundary that is not there.
    const map = kitByStep([entry('roasting tin', ['s-4', 's-2', 's-3'])], STEPS);

    expect(labelsAt(map, 's-2')).toEqual(['roasting tin']);
    expect(map.get('s-3')).toBeUndefined();
    expect(map.get('s-4')).toBeUndefined();
  });

  it('drops a stepId whose step was deleted, and joins the run around it', () => {
    // An edit that removes a step re-runs no inference, so the document really
    // does carry ids pointing at nothing. The tool keeps the steps it still has.
    const map = kitByStep([entry('saucepan', ['s-1', 'deleted-step', 's-2'])], STEPS);

    expect(labelsAt(map, 's-1')).toEqual(['saucepan']);
    expect(map.get('s-2')).toBeUndefined();
  });

  it('makes a tool whose stepIds are ALL stale disappear entirely', () => {
    // Silently — the same rule guided plans apply to an orphaned step note.
    // Never re-attached to whichever step took the deleted one's position.
    const map = kitByStep([entry('tagine', ['gone-1', 'gone-2'])], STEPS);

    expect(map.size).toBe(0);
  });

  it('returns an empty map for an empty kit', () => {
    expect(kitByStep([], STEPS).size).toBe(0);
  });

  it('shows a kit entry with no stepIds NOWHERE', () => {
    // It still belongs on the "You'll need" strip — the strip lists the kit, this
    // query answers a different question, and "used at no particular step" has no
    // honest answer to it.
    const map = kitByStep([entry('oven glove', [])], STEPS);

    expect(map.size).toBe(0);
  });

  it('returns an empty map when the recipe has no steps at all', () => {
    expect(kitByStep([entry('frying pan', ['s-1'])], []).size).toBe(0);
  });

  it('collapses a duplicated stepId rather than drawing the tool twice', () => {
    const map = kitByStep([entry('whisk', ['s-2', 's-2'])], STEPS);

    expect(labelsAt(map, 's-2')).toEqual(['whisk']);
  });
});
