<script lang="ts">
  import {
    Button,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Switch,
    TextField,
  } from '@salt/ui-components';
  import type {
    EquipmentControl,
    EquipmentEnvironmentDoc,
    EquipmentItemDoc,
  } from '@salt/domain/schemas';
  import { setEquipmentEnvironmentFor } from '../../lib/equipmentService.js';
  import { addToast } from '../../lib/toastStore.js';

  /**
   * "Temperature and humidity" — describing an equipment item as a PLACE a stage
   * can happen in (issue #1281).
   *
   * ABSENT UNTIL ASKED FOR. Most kit is not a place, so an item with no
   * `environment` shows one sentence and one button, and nothing else on the
   * equipment page changes. Its own file rather than another 200 lines in
   * EquipmentEditPage.svelte, which is already 900.
   *
   * A DRAFT WITH AN EXPLICIT SAVE, unlike the rules and accessories above, which
   * write per keystroke-committed row. Six coupled numbers cannot be written one
   * at a time without the manifest passing through states nobody meant — a max
   * below its min, a humidity range half-typed — and every one of those is a
   * full-document `setDoc` under LWW.
   */
  interface Props {
    item: EquipmentItemDoc;
  }
  let { item }: Props = $props();

  // Numbers are held as STRINGS while editing: an empty box is a real state a
  // number cannot represent, and `Number('')` is 0, which would silently claim
  // this chamber reaches 0 °C.
  interface Draft {
    control: EquipmentControl;
    minCelsius: string;
    maxCelsius: string;
    doesHumidity: boolean;
    precision: 'approximate' | 'controlled';
    minPercent: string;
    maxPercent: string;
    standingCelsius: string;
    standingPercent: string;
  }

  function draftFrom(env: EquipmentEnvironmentDoc | null): Draft {
    return {
      control: env?.control ?? 'dedicated',
      minCelsius: env ? String(env.minCelsius) : '',
      maxCelsius: env ? String(env.maxCelsius) : '',
      doesHumidity: env?.humidity != null,
      precision: env?.humidity?.precision ?? 'approximate',
      minPercent: env?.humidity ? String(env.humidity.minPercent) : '',
      maxPercent: env?.humidity ? String(env.humidity.maxPercent) : '',
      standingCelsius: env?.standing ? String(env.standing.celsius) : '',
      standingPercent:
        env?.standing?.relativeHumidityPercent == null
          ? ''
          : String(env.standing.relativeHumidityPercent),
    };
  }

  let editing = $state(false);
  let draft = $state<Draft>(draftFrom(null));
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Re-seed when the user navigates between items, or when a concurrent write
  // lands from another device. Not while editing: that would eat what is typed.
  let seededFor = $state<string | null>(null);
  $effect(() => {
    if (editing) return;
    if (seededFor === item.id) return;
    seededFor = item.id;
    draft = draftFrom(item.environment);
  });

  function begin(): void {
    draft = draftFrom(item.environment);
    error = null;
    editing = true;
  }

  function num(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function save(): Promise<void> {
    const min = num(draft.minCelsius);
    const max = num(draft.maxCelsius);
    if (min === null || max === null) {
      error = 'Give the temperature range this reaches, in °C.';
      return;
    }
    if (max < min) {
      error = 'The top of the range must be at or above the bottom.';
      return;
    }
    let humidity: EquipmentEnvironmentDoc['humidity'] = null;
    if (draft.doesHumidity) {
      const minP = num(draft.minPercent);
      const maxP = num(draft.maxPercent);
      if (minP === null || maxP === null || minP < 0 || maxP > 100) {
        error = 'Give the humidity range this holds, 0–100%.';
        return;
      }
      if (maxP < minP) {
        error = 'The top of the humidity range must be at or above the bottom.';
        return;
      }
      humidity = { precision: draft.precision, minPercent: minP, maxPercent: maxP };
    }
    // A shared place is the ONLY one that carries a standing setpoint — the
    // domain command normalises it away for a dedicated one, and this is the
    // UI half of the same claim (see setEquipmentEnvironment.ts).
    let standing: EquipmentEnvironmentDoc['standing'] = null;
    if (draft.control === 'shared') {
      const celsius = num(draft.standingCelsius);
      if (celsius === null) {
        error = 'A shared place needs the temperature it is currently held at.';
        return;
      }
      const percent = num(draft.standingPercent);
      if (percent !== null && (percent < 0 || percent > 100)) {
        error = 'The standing humidity must be between 0 and 100%.';
        return;
      }
      standing = { celsius, relativeHumidityPercent: percent };
    }
    busy = true;
    const result = await setEquipmentEnvironmentFor(item.id, {
      control: draft.control,
      minCelsius: min,
      maxCelsius: max,
      humidity,
      standing,
    });
    busy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to save the temperature settings.', 'destructive');
      return;
    }
    error = null;
    editing = false;
  }

  async function clear(): Promise<void> {
    busy = true;
    const result = await setEquipmentEnvironmentFor(item.id, null);
    busy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to clear the temperature settings.', 'destructive');
      return;
    }
    editing = false;
    seededFor = null;
  }

  const summary = $derived.by(() => {
    const env = item.environment;
    if (!env) return null;
    const bits = [`${env.minCelsius}–${env.maxCelsius} °C`];
    if (env.humidity) {
      bits.push(
        `${env.humidity.minPercent}–${env.humidity.maxPercent}% RH${
          env.humidity.precision === 'controlled' ? '' : ' (approximate)'
        }`,
      );
    }
    if (env.control === 'shared' && env.standing) {
      bits.push(
        `currently held at ${env.standing.celsius} °C${
          env.standing.relativeHumidityPercent === null
            ? ''
            : ` and ${env.standing.relativeHumidityPercent}%`
        }`,
      );
    }
    return bits.join(' · ');
  });
</script>

<section class="flex flex-col gap-3" data-testid="equipment-environment">
  <p class="text-sm font-medium">Temperature and humidity</p>

  {#if !editing}
    {#if summary}
      <p class="text-sm" data-testid="equipment-environment-summary">
        {summary}
      </p>
      <p class="text-xs text-muted-foreground">
        {item.environment?.control === 'shared'
          ? 'Shared — it holds several things at once, so a bake records its setting rather than changing it.'
          : 'Dedicated — a bake dials it in for the job.'}
      </p>
      <div class="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onclick={begin}
          data-testid="equipment-environment-edit"
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onclick={clear}
          loading={busy}
          data-testid="equipment-environment-clear"
        >
          Not a place
        </Button>
      </div>
    {:else}
      <p class="text-xs text-muted-foreground">
        Only for the handful of things that hold a temperature — a proofer, a chamber, a fridge.
        Everything else needs nothing here, and a stage with no place named just sits at kitchen
        temperature. Describe what the thing is made of in Rules, below.
      </p>
      <div>
        <Button
          variant="outline"
          size="sm"
          onclick={begin}
          data-testid="equipment-environment-describe"
        >
          This holds a temperature
        </Button>
      </div>
    {/if}
  {:else}
    <div class="flex flex-col gap-3 rounded border border-border bg-card p-3">
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Who sets it</span>
        <Select
          value={draft.control}
          onValueChange={(v) => (draft.control = v as EquipmentControl)}
        >
          <SelectTrigger data-testid="equipment-environment-control">
            {draft.control === 'shared'
              ? 'Shared — I set it, bakes record it'
              : 'Dedicated — a bake sets it'}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dedicated">Dedicated — a bake sets it</SelectItem>
            <SelectItem value="shared">Shared — I set it, bakes record it</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex gap-2">
        <TextField
          bind:value={draft.minCelsius}
          label="Coldest (°C)"
          inputmode="decimal"
          class="flex-1"
          data-testid="equipment-environment-min-c"
        />
        <TextField
          bind:value={draft.maxCelsius}
          label="Warmest (°C)"
          inputmode="decimal"
          class="flex-1"
          data-testid="equipment-environment-max-c"
        />
      </div>

      <Switch
        checked={draft.doesHumidity}
        label="It does humidity"
        onCheckedChange={(checked) => (draft.doesHumidity = checked)}
      />

      {#if draft.doesHumidity}
        <div class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">How closely it holds it</span>
          <Select
            value={draft.precision}
            onValueChange={(v) => (draft.precision = v as 'approximate' | 'controlled')}
          >
            <SelectTrigger data-testid="equipment-environment-precision">
              {draft.precision === 'controlled' ? 'Controlled' : 'Roughly'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="approximate">Roughly</SelectItem>
              <SelectItem value="controlled">Controlled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex gap-2">
          <TextField
            bind:value={draft.minPercent}
            label="Driest (% RH)"
            inputmode="decimal"
            class="flex-1"
            data-testid="equipment-environment-min-rh"
          />
          <TextField
            bind:value={draft.maxPercent}
            label="Dampest (% RH)"
            inputmode="decimal"
            class="flex-1"
            data-testid="equipment-environment-max-rh"
          />
        </div>
      {/if}

      {#if draft.control === 'shared'}
        <div class="flex gap-2">
          <TextField
            bind:value={draft.standingCelsius}
            label="Held at (°C)"
            inputmode="decimal"
            class="flex-1"
            data-testid="equipment-environment-standing-c"
          />
          <TextField
            bind:value={draft.standingPercent}
            label="Held at (% RH)"
            inputmode="decimal"
            class="flex-1"
            data-testid="equipment-environment-standing-rh"
          />
        </div>
      {/if}

      {#if error}
        <p class="text-sm text-destructive" data-testid="equipment-environment-error">{error}</p>
      {/if}

      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onclick={() => (editing = false)} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onclick={save} loading={busy} data-testid="equipment-environment-save">
          Save
        </Button>
      </div>
    </div>
  {/if}
</section>
