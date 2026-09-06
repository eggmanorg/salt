import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { EquipmentEnvironmentDoc, EquipmentItemDoc } from '@salt/domain/schemas';

// "Temperature and humidity" on the equipment page (issue #1281). The Select for
// the control mode is deliberately never driven here: bits-ui's listbox is a
// focus trap in jsdom, and every branch that depends on the mode is reachable by
// seeding an item that already has it.

vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/equipmentService.js', () => ({
  setEquipmentEnvironmentFor: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import EquipmentEnvironmentSection from '../src/routes/equipment/EquipmentEnvironmentSection.svelte';
import { setEquipmentEnvironmentFor } from '../src/lib/equipmentService.js';
import { addToast } from '../src/lib/toastStore.js';

function item(environment: EquipmentEnvironmentDoc | null): EquipmentItemDoc {
  return {
    id: 'eq-1',
    schemaVersion: 1,
    name: 'Curing chamber',
    accessories: [],
    rules: [],
    environment,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const SHARED: EquipmentEnvironmentDoc = {
  control: 'shared',
  minCelsius: 8,
  maxCelsius: 18,
  humidity: { precision: 'approximate', minPercent: 60, maxPercent: 85 },
  standing: { celsius: 12, relativeHumidityPercent: 75 },
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('EquipmentEnvironmentSection', () => {
  it('offers only an invitation for equipment that is not a place', () => {
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    expect(screen.getByTestId('equipment-environment-describe')).toBeTruthy();
    expect(screen.queryByTestId('equipment-environment-summary')).toBeNull();
    // Nothing is typed in until the button is pressed — the promise that the
    // rest of the equipment list is untouched.
    expect(screen.queryByTestId('equipment-environment-save')).toBeNull();
  });

  it('summarises a described place, including what it is standing at', () => {
    render(EquipmentEnvironmentSection, { props: { item: item(SHARED) } });
    const summary = screen.getByTestId('equipment-environment-summary').textContent ?? '';
    expect(summary).toContain('8–18 °C');
    expect(summary).toContain('60–85% RH');
    expect(summary).toContain('currently held at 12 °C and 75%');
  });

  it('writes what was typed, and does not offer a standing setpoint on a dedicated place', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));

    // Default control is `dedicated`, so the standing fields are simply absent.
    expect(screen.queryByTestId('equipment-environment-standing-c')).toBeNull();

    await user.type(screen.getByTestId('equipment-environment-min-c'), '20');
    await user.type(screen.getByTestId('equipment-environment-max-c'), '50');
    await user.click(screen.getByTestId('equipment-environment-save'));

    await waitFor(() => expect(setEquipmentEnvironmentFor).toHaveBeenCalled());
    expect(setEquipmentEnvironmentFor).toHaveBeenCalledWith('eq-1', {
      control: 'dedicated',
      minCelsius: 20,
      maxCelsius: 50,
      humidity: null,
      standing: null,
    });
  });

  it('refuses a range with nothing in it rather than writing a silent zero', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));
    await user.click(screen.getByTestId('equipment-environment-save'));

    expect(screen.getByTestId('equipment-environment-error').textContent).toContain(
      'temperature range',
    );
    expect(setEquipmentEnvironmentFor).not.toHaveBeenCalled();
  });

  it('refuses a range that runs backwards', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));
    await user.type(screen.getByTestId('equipment-environment-min-c'), '50');
    await user.type(screen.getByTestId('equipment-environment-max-c'), '20');
    await user.click(screen.getByTestId('equipment-environment-save'));

    expect(screen.getByTestId('equipment-environment-error').textContent).toContain('at or above');
    expect(setEquipmentEnvironmentFor).not.toHaveBeenCalled();
  });

  it('keeps a shared place shared, with its standing setpoint, when re-saved unchanged', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(SHARED) } });
    await user.click(screen.getByTestId('equipment-environment-edit'));

    // The standing fields exist for exactly this mode, seeded from the document.
    expect(screen.getByTestId('equipment-environment-standing-c')).toBeTruthy();
    await user.click(screen.getByTestId('equipment-environment-save'));

    await waitFor(() => expect(setEquipmentEnvironmentFor).toHaveBeenCalledWith('eq-1', SHARED));
  });

  it('asks for a humidity range only once humidity is switched on, and saves it', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));

    expect(screen.queryByTestId('equipment-environment-min-rh')).toBeNull();
    await user.click(screen.getByRole('switch'));

    await user.type(screen.getByTestId('equipment-environment-min-c'), '8');
    await user.type(screen.getByTestId('equipment-environment-max-c'), '18');
    await user.type(screen.getByTestId('equipment-environment-min-rh'), '60');
    await user.type(screen.getByTestId('equipment-environment-max-rh'), '85');
    await user.click(screen.getByTestId('equipment-environment-save'));

    await waitFor(() => expect(setEquipmentEnvironmentFor).toHaveBeenCalled());
    expect(setEquipmentEnvironmentFor).toHaveBeenCalledWith('eq-1', {
      control: 'dedicated',
      minCelsius: 8,
      maxCelsius: 18,
      humidity: { precision: 'approximate', minPercent: 60, maxPercent: 85 },
      standing: null,
    });
  });

  it('refuses a humidity range that runs backwards', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));
    await user.click(screen.getByRole('switch'));
    await user.type(screen.getByTestId('equipment-environment-min-c'), '8');
    await user.type(screen.getByTestId('equipment-environment-max-c'), '18');
    await user.type(screen.getByTestId('equipment-environment-min-rh'), '85');
    await user.type(screen.getByTestId('equipment-environment-max-rh'), '60');
    await user.click(screen.getByTestId('equipment-environment-save'));

    expect(screen.getByTestId('equipment-environment-error').textContent).toContain('humidity');
    expect(setEquipmentEnvironmentFor).not.toHaveBeenCalled();
  });

  it('refuses a humidity range left empty', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));
    await user.click(screen.getByRole('switch'));
    await user.type(screen.getByTestId('equipment-environment-min-c'), '8');
    await user.type(screen.getByTestId('equipment-environment-max-c'), '18');
    await user.click(screen.getByTestId('equipment-environment-save'));

    expect(screen.getByTestId('equipment-environment-error').textContent).toContain('0–100%');
    expect(setEquipmentEnvironmentFor).not.toHaveBeenCalled();
  });

  it('refuses a shared place with no setting recorded, and a standing humidity out of range', async () => {
    const user = userEvent.setup();
    const noStanding: EquipmentEnvironmentDoc = { ...SHARED, standing: null };
    render(EquipmentEnvironmentSection, { props: { item: item(noStanding) } });
    await user.click(screen.getByTestId('equipment-environment-edit'));
    await user.click(screen.getByTestId('equipment-environment-save'));
    expect(screen.getByTestId('equipment-environment-error').textContent).toContain(
      'currently held at',
    );

    await user.type(screen.getByTestId('equipment-environment-standing-c'), '12');
    await user.type(screen.getByTestId('equipment-environment-standing-rh'), '140');
    await user.click(screen.getByTestId('equipment-environment-save'));
    expect(screen.getByTestId('equipment-environment-error').textContent).toContain(
      'between 0 and 100',
    );
    expect(setEquipmentEnvironmentFor).not.toHaveBeenCalled();
  });

  it('leaves the form on Cancel without writing anything', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));
    await user.type(screen.getByTestId('equipment-environment-min-c'), '20');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByTestId('equipment-environment-describe')).toBeTruthy();
    expect(setEquipmentEnvironmentFor).not.toHaveBeenCalled();
  });

  it('reports a refused clear rather than pretending it landed', async () => {
    vi.mocked(setEquipmentEnvironmentFor).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    } as never);
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(SHARED) } });
    await user.click(screen.getByTestId('equipment-environment-clear'));
    await waitFor(() => expect(addToast).toHaveBeenCalled());
  });

  it('turns a place back into ordinary equipment', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(SHARED) } });
    await user.click(screen.getByTestId('equipment-environment-clear'));
    await waitFor(() => expect(setEquipmentEnvironmentFor).toHaveBeenCalledWith('eq-1', null));
  });

  it('reports a refused write rather than pretending it landed', async () => {
    vi.mocked(setEquipmentEnvironmentFor).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    } as never);
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));
    await user.type(screen.getByTestId('equipment-environment-min-c'), '20');
    await user.type(screen.getByTestId('equipment-environment-max-c'), '50');
    await user.click(screen.getByTestId('equipment-environment-save'));

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    // Still in the form, so nothing typed is lost.
    expect(screen.getByTestId('equipment-environment-save')).toBeTruthy();
  });
});

describe('EquipmentEnvironmentSection — how a described place reads', () => {
  it('summarises a dedicated place as just its range', () => {
    const proofer: EquipmentEnvironmentDoc = {
      control: 'dedicated',
      minCelsius: 20,
      maxCelsius: 50,
      humidity: null,
      standing: null,
    };
    render(EquipmentEnvironmentSection, { props: { item: item(proofer) } });
    expect(screen.getByTestId('equipment-environment-summary').textContent).toContain('20–50 °C');
    expect(screen.getByText(/Dedicated/)).toBeTruthy();
  });

  it('marks a precisely-held humidity as controlled, without the approximate note', () => {
    const anova: EquipmentEnvironmentDoc = {
      control: 'dedicated',
      minCelsius: 25,
      maxCelsius: 250,
      humidity: { precision: 'controlled', minPercent: 0, maxPercent: 100 },
      standing: null,
    };
    render(EquipmentEnvironmentSection, { props: { item: item(anova) } });
    const summary = screen.getByTestId('equipment-environment-summary').textContent ?? '';
    expect(summary).toContain('0–100% RH');
    expect(summary).not.toContain('approximate');
  });

  it('omits a standing humidity nobody recorded', () => {
    const fridge: EquipmentEnvironmentDoc = {
      control: 'shared',
      minCelsius: 5,
      maxCelsius: 18,
      humidity: null,
      standing: { celsius: 14, relativeHumidityPercent: null },
    };
    render(EquipmentEnvironmentSection, { props: { item: item(fridge) } });
    const summary = screen.getByTestId('equipment-environment-summary').textContent ?? '';
    expect(summary).toContain('currently held at 14 °C');
    expect(summary).not.toContain('%');
  });

  it('shows a shared place its standing setpoint when it has none recorded', () => {
    const bare: EquipmentEnvironmentDoc = { ...SHARED, standing: null };
    render(EquipmentEnvironmentSection, { props: { item: item(bare) } });
    expect(screen.getByTestId('equipment-environment-summary').textContent).not.toContain(
      'currently held at',
    );
  });

  it('refuses words typed where a temperature belongs', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));
    await user.type(screen.getByTestId('equipment-environment-min-c'), 'warm');
    await user.type(screen.getByTestId('equipment-environment-max-c'), '50');
    await user.click(screen.getByTestId('equipment-environment-save'));

    expect(screen.getByTestId('equipment-environment-error')).toBeTruthy();
    expect(setEquipmentEnvironmentFor).not.toHaveBeenCalled();
  });

  it('records how closely a humidity is held', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));
    await user.click(screen.getByRole('switch'));

    await user.click(screen.getByTestId('equipment-environment-precision'));
    await user.click(await screen.findByRole('option', { name: 'Controlled' }));

    await user.type(screen.getByTestId('equipment-environment-min-c'), '25');
    await user.type(screen.getByTestId('equipment-environment-max-c'), '250');
    await user.type(screen.getByTestId('equipment-environment-min-rh'), '0');
    await user.type(screen.getByTestId('equipment-environment-max-rh'), '100');
    await user.click(screen.getByTestId('equipment-environment-save'));

    await waitFor(() => expect(setEquipmentEnvironmentFor).toHaveBeenCalled());
    expect(vi.mocked(setEquipmentEnvironmentFor).mock.calls[0]![1]!.humidity).toEqual({
      precision: 'controlled',
      minPercent: 0,
      maxPercent: 100,
    });
  });

  it('switches a place from dedicated to shared through the picker', async () => {
    const user = userEvent.setup();
    render(EquipmentEnvironmentSection, { props: { item: item(null) } });
    await user.click(screen.getByTestId('equipment-environment-describe'));

    await user.click(screen.getByTestId('equipment-environment-control'));
    await user.click(await screen.findByRole('option', { name: /Shared/ }));

    // The standing fields are what the mode is FOR, so their appearance is the
    // observable half of the switch.
    expect(screen.getByTestId('equipment-environment-standing-c')).toBeTruthy();
  });
});
