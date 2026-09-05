<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Button } from '@salt/ui-components';
  import { subscribeWeatherForecast, callRefreshWeatherForecast } from '@salt/firebase-sync';
  import type { WeatherForecast, WeatherDaySummary } from '@salt/domain/schemas';
  import { appSettings } from '../../lib/appSettingsService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { subscriptionErrorHandler } from '../../lib/errorReporting.js';

  // Weather forecast cache readout + refresh (issue #382, Phase 2). Minimal admin
  // control so the fetch+cache pipeline is independently testable: clicking
  // "Refresh" calls the refreshWeatherForecast CF (force=true so a manual refresh
  // always refetches), and this subscribes to weatherForecast/singleton to show
  // the last-updated timestamp and per-day values. The planner-day render lands
  // in a later phase — this is intentionally a bare table.

  let forecast = $state<WeatherForecast | null>(null);
  let corrupt = $state(false);
  let refreshing = $state(false);
  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = subscribeWeatherForecast(
      (f) => {
        forecast = f;
        corrupt = false;
      },
      subscriptionErrorHandler((err) => {
        // A corrupt cache doc surfaces here; flag it and keep the table empty.
        corrupt = err.kind === 'StorageError' && err.reason === 'corruption';
      }),
    );
  });

  onDestroy(() => {
    unsub?.();
    unsub = null;
  });

  const hasHomeLocation = $derived(Boolean($appSettings?.homeLocation));

  const lastUpdatedLabel = $derived.by(() => {
    if (!forecast?.fetchedAt) return null;
    return new Date(forecast.fetchedAt).toLocaleString();
  });

  // Sorted day rows for a stable table render.
  const dayRows = $derived.by((): Array<{ date: string; summary: WeatherDaySummary }> => {
    if (!forecast) return [];
    return Object.entries(forecast.days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, summary]) => ({ date, summary }));
  });

  async function onRefresh(): Promise<void> {
    refreshing = true;
    // force=true: a manual admin refresh bypasses the server-side <1h staleness
    // skip so the button always refetches.
    const result = await callRefreshWeatherForecast(true);
    refreshing = false;
    if (result.kind !== 'ok') {
      addToast('Failed to refresh the weather forecast.', 'destructive');
      return;
    }
    if (!result.value.homeLocationSet) {
      addToast('Set a home location first, then refresh the forecast.', 'destructive');
      return;
    }
    addToast('Weather forecast refreshed.', 'success');
  }
</script>

<div class="rounded-lg border p-4" data-testid="app-settings-weather">
  <h2 class="text-base font-medium">Weather forecast</h2>
  <p class="mt-0.5 text-sm text-muted-foreground">
    A ~14-day forecast for the home location, summarised for the 16:00–19:00 window each day. Used
    by the meal planner. Refresh refetches from Open-Meteo and updates the cache.
  </p>

  <div class="mt-3 flex items-center gap-3">
    <Button
      size="sm"
      onclick={() => void onRefresh()}
      disabled={refreshing || !hasHomeLocation}
      data-testid="app-settings-weather-refresh"
    >
      {refreshing ? 'Refreshing…' : 'Refresh'}
    </Button>
    {#if lastUpdatedLabel}
      <span class="text-sm text-muted-foreground" data-testid="app-settings-weather-updated">
        Last updated {lastUpdatedLabel}
      </span>
    {:else}
      <span class="text-sm text-muted-foreground" data-testid="app-settings-weather-empty">
        No forecast cached yet.
      </span>
    {/if}
  </div>

  {#if !hasHomeLocation}
    <p class="mt-2 text-sm text-amber-800" data-testid="app-settings-weather-no-location">
      Set a home location above to enable the forecast.
    </p>
  {/if}

  {#if corrupt}
    <p class="mt-2 text-sm text-destructive" data-testid="app-settings-weather-corrupt">
      The cached forecast document is invalid and is being ignored — refresh to rewrite it.
    </p>
  {/if}

  {#if dayRows.length > 0}
    <div class="mt-3 overflow-x-auto">
      <table class="w-full text-left text-sm" data-testid="app-settings-weather-table">
        <thead class="text-muted-foreground">
          <tr>
            <th class="py-1 pr-3 font-medium">Date</th>
            <th class="py-1 pr-3 font-medium">High / Low</th>
            <th class="py-1 pr-3 font-medium">Feels like</th>
            <th class="py-1 pr-3 font-medium">Humidity</th>
            <th class="py-1 pr-3 font-medium">Cloud</th>
            <th class="py-1 pr-3 font-medium">Rain</th>
          </tr>
        </thead>
        <tbody>
          {#each dayRows as row (row.date)}
            <tr class="border-t" data-testid="app-settings-weather-row-{row.date}">
              <td class="py-1 pr-3 font-mono text-xs">{row.date}</td>
              <td class="py-1 pr-3">{row.summary.tempHigh}° / {row.summary.tempLow}°C</td>
              <td class="py-1 pr-3">{row.summary.apparentTemp}°C</td>
              <td class="py-1 pr-3">{row.summary.humidity}%</td>
              <td class="py-1 pr-3">{row.summary.cloudCover}%</td>
              <td class="py-1 pr-3">{row.summary.precipitationChance}%</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
