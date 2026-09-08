<script lang="ts">
  import { Thermometer, ThermometerSun, Droplets, Cloud, Umbrella } from '@lucide/svelte';
  import { Tooltip, TooltipTrigger, TooltipContent } from '@salt/ui-components';
  import { temperatureBand, type TemperatureBand } from '@salt/domain';
  import type { WeatherDaySummary } from '@salt/domain/schemas';
  import { BAND_CLASS } from './temperatureBandClass.js';

  // Compact, glanceable evening-forecast cue for one in-window planner day (issue
  // #382, Phase 3). The PARENT gates rendering — this component is only mounted for
  // concrete dated days inside the forecast window (it is never given a template
  // weekday). All POLICY (heat bands, eat-mood) lives in the pure domain
  // (temperatureBand / classifyEatingMood); this view only maps the returned enum
  // to a glyph/label/colour-class (CLAUDE.md Rule 1).
  //
  // NOTE: the eat-mood meal recommendation cue is intentionally NOT rendered for
  // now — the `classifyEatingMood` rules are under review. The domain classifier
  // and its tests are kept; re-wire it here (see the marker below) once the rules
  // are settled.
  interface Props {
    weather: WeatherDaySummary;
    testid?: string;
  }
  let { weather, testid }: Props = $props();

  // The colour is driven by the window HIGH — the warmest, most salient part of the
  // evening window (documented in temperatureBand). cool blues → warm oranges/reds.
  const band = $derived<TemperatureBand>(temperatureBand(weather.tempHigh));

  // Eat-mood recommendation cue is disabled while the rules are under review. To
  // restore it, re-import `classifyEatingMood` / `EatingMood` from `@salt/domain`,
  // derive `mood` here, and add back the MOOD_PRESENTATION map + the marked span
  // in the template below:
  //   const mood = $derived<EatingMood>(classifyEatingMood(weather));
  //   const MOOD_PRESENTATION: Record<EatingMood, { glyph: string; label: string }> = {
  //     'hot-comfort': { glyph: '🍲', label: 'Comfort food' },
  //     neutral: { glyph: '🍽️', label: 'Anything goes' },
  //     'cold-fresh': { glyph: '🥗', label: 'Fresh & light' },
  //   };

  // One row entry per metric: glyph + value + a short explanation. `key` doubles as
  // the testid suffix, so the temperature entry keeps its existing `${testid}-temp`
  // hook. `label` is the accessible name; `hint` is the one-line tooltip. Order is
  // unchanged.
  const metrics = $derived([
    {
      key: 'temp',
      icon: Thermometer,
      value: `${weather.tempHigh}° / ${weather.tempLow}°`,
      class: `font-medium ${BAND_CLASS[band]}`,
      label: 'Temperature',
      hint: 'The high and low evening temperature',
    },
    {
      key: 'feels',
      icon: ThermometerSun,
      value: `${weather.apparentTemp}°`,
      class: '',
      label: 'Feels like',
      hint: 'What the temperature feels like',
    },
    {
      key: 'humidity',
      icon: Droplets,
      value: `${weather.humidity}%`,
      class: '',
      label: 'Humidity',
      hint: 'How humid the air is',
    },
    {
      key: 'cloud',
      icon: Cloud,
      value: `${weather.cloudCover}%`,
      class: '',
      label: 'Cloud cover',
      hint: 'How much cloud cover there is',
    },
    {
      key: 'rain',
      icon: Umbrella,
      value: `${weather.precipitationChance}%`,
      class: '',
      label: 'Chance of rain',
      hint: 'The chance of rain',
    },
  ]);

  // Tooltips open on hover (desktop, via pointer) and on tap (touch). bits-ui won't
  // open on a touch pointer and closes on tap, so open state is controlled here and
  // the trigger's onclick toggles it — it stays put until tapped again or dismissed
  // (tap elsewhere → trigger blur → close). `disableCloseOnTriggerClick` stops the
  // tap from auto-closing; `ignoreNonKeyboardFocus` stops the focus a tap incurs
  // from opening it and racing the click toggle (the first-tap flash). Keyboard Tab
  // still opens it (real focus). Single key = only one open at a time.
  let openKey = $state<string | null>(null);
</script>

<div
  class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
  data-testid={testid}
>
  {#each metrics as m (m.key)}
    {@const Icon = m.icon}
    <Tooltip
      open={openKey === m.key}
      onOpenChange={(o) => {
        if (o) openKey = m.key;
        else if (openKey === m.key) openKey = null;
      }}
      delayDuration={150}
      disableCloseOnTriggerClick
      ignoreNonKeyboardFocus
    >
      <TooltipTrigger
        class={`flex items-center gap-1 rounded-sm ${m.class}`}
        aria-label={`${m.label}: ${m.value}`}
        data-testid={testid ? `${testid}-${m.key}` : undefined}
        onclick={() => (openKey = openKey === m.key ? null : m.key)}
      >
        <Icon class="h-3.5 w-3.5" aria-hidden="true" />
        <span class="tabular-nums">{m.value}</span>
      </TooltipTrigger>
      <TooltipContent>{m.hint}</TooltipContent>
    </Tooltip>
  {/each}

  <!-- Eat-mood meal recommendation cue goes here — disabled while the
       classifyEatingMood rules are under review (see the script block above). -->
</div>
