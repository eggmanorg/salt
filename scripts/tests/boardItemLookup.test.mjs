// The lookup-by-number fallback: GitHub's `ProjectV2.items` scan lags a fresh
// add by 30+ minutes, so a number it misses is asked about from the issue's side
// before it counts as "not on the board". The GraphQL call is the injected
// `lookup`, stubbed here — the same arrangement as every other `board*` helper.

import { describe, expect, it, vi } from 'vitest';

import { findItem, itemOnProject, parseItem } from '../lib/boardItemLookup.mjs';

const PROJECT = 'PVT_board';

const node = (number, fields = {}) => ({
  id: `PVTI_${number}`,
  createdAt: '2026-09-23T10:00:00Z',
  content: { number, title: `issue ${number}`, state: 'OPEN', labels: { nodes: [] } },
  queue: { name: 'Low' },
  status: { name: 'Todo' },
  ...fields,
});

describe('findItem', () => {
  const scanned = [parseItem(node(1))];

  it('uses the scan when it has the number, and never asks again', () => {
    const lookup = vi.fn();
    expect(findItem(scanned, 1, lookup)?.id).toBe('PVTI_1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a number the scan missed but the issue-side lookup finds is ON the board', () => {
    const lookup = vi.fn(() =>
      itemOnProject([{ project: { id: PROJECT }, ...node(1561) }], PROJECT),
    );
    const item = findItem(scanned, 1561, lookup);
    expect(lookup).toHaveBeenCalledWith(1561);
    expect(item).toMatchObject({ id: 'PVTI_1561', number: 1561, queue: 'Low', status: 'Todo' });
  });

  it('a number both miss is still not on the board', () => {
    expect(findItem(scanned, 1561, () => itemOnProject([], PROJECT))).toBeNull();
  });
});

describe('itemOnProject', () => {
  it('ignores the same issue on another project', () => {
    expect(itemOnProject([{ project: { id: 'PVT_other' }, ...node(1561) }], PROJECT)).toBeNull();
  });

  it('returns the item in the shape the bulk scan does', () => {
    const n = node(1561);
    expect(itemOnProject([{ project: { id: PROJECT }, ...n }], PROJECT)).toEqual(parseItem(n));
  });

  it('a missing issue is a miss, not a throw', () => {
    expect(itemOnProject(undefined, PROJECT)).toBeNull();
  });
});
