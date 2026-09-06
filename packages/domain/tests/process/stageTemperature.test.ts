import { describe, it, expect } from 'vitest';
import { stageTemperatureText } from '../../src/index.js';

// One spelling of a stage temperature, for the four surfaces that render it
// (issue #1281).
describe('stageTemperatureText', () => {
  it('says a figure the recipe means exactly', () => {
    expect(stageTemperatureText({ kind: 'fixed', celsius: 240 })).toBe('240 °C');
  });

  it('says a range AS a range, never its midpoint', () => {
    // The property the discriminated union exists to protect. 22–26 must never
    // read as 24 anywhere, on any screen or in any prompt.
    expect(stageTemperatureText({ kind: 'range', minCelsius: 22, maxCelsius: 26 })).toBe(
      '22–26 °C',
    );
  });

  it('keeps a sub-zero figure', () => {
    expect(stageTemperatureText({ kind: 'fixed', celsius: -18 })).toBe('-18 °C');
  });
});
