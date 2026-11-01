import { describe, it, expect } from 'vitest';
import { formatBagNumber } from '@salt/domain';

describe('formatBagNumber', () => {
  it('pads to four digits', () => {
    expect(formatBagNumber(1)).toBe('0001');
    expect(formatBagNumber(42)).toBe('0042');
    expect(formatBagNumber(9999)).toBe('9999');
  });

  it('shows a number past four digits in full', () => {
    expect(formatBagNumber(12345)).toBe('12345');
  });
});
