<script lang="ts">
  import { Button, TextField } from '@salt/ui-components';
  import type { HomeLocation, GeocodingResult } from '@salt/domain/schemas';
  import { searchLocations, reverseGeocode, browserTimezone } from '../../lib/geocodingService.js';
  import LocationMapField from './LocationMapField.svelte';
  import {
    appSettings,
    isLoadingAppSettings,
    setHomeLocation,
    resetHomeLocation,
  } from '../../lib/appSettingsService.js';
  import { addToast } from '../../lib/toastStore.js';

  // Family home location (issue #382). Search an address or postcode via
  // OpenStreetMap Nominatim and pick a result, fine-tune by dragging the map pin
  // (or clicking the map), or enter coordinates by hand. The chosen-but-unsaved
  // location is held as a `draft`; "Save location" persists { latitude, longitude,
  // timezone, label } onto the app-settings doc. No weather is fetched here.

  const saved = $derived<HomeLocation | null>($appSettings?.homeLocation ?? null);

  // The location currently being composed (from a search pick, a map drag, or
  // manual entry) but not yet saved. Null means "show the saved location".
  let draft = $state<HomeLocation | null>(null);

  // Where the map centres / drops its pin: the draft, else the saved location,
  // else a sensible default so the map is never blank.
  const DEFAULT_CENTER = { latitude: 51.5074, longitude: -0.1278 }; // London
  const pinLat = $derived(draft?.latitude ?? saved?.latitude ?? DEFAULT_CENTER.latitude);
  const pinLng = $derived(draft?.longitude ?? saved?.longitude ?? DEFAULT_CENTER.longitude);

  function sameLocation(a: HomeLocation, b: HomeLocation): boolean {
    return (
      a.latitude === b.latitude &&
      a.longitude === b.longitude &&
      a.timezone === b.timezone &&
      a.label === b.label
    );
  }

  // The draft is worth saving when it exists and differs from what's stored.
  const canSaveDraft = $derived(!!draft && (!saved || !sameLocation(draft, saved!)));

  // ── Geocoding search ────────────────────────────────────────────────────────
  let query = $state('');
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let results = $state<GeocodingResult[]>([]);

  async function onSearch(): Promise<void> {
    const q = query.trim();
    if (!q) return;
    searching = true;
    searchError = null;
    results = [];
    try {
      results = await searchLocations(q);
      if (results.length === 0) {
        searchError = 'No matches — try a different address/postcode, or drop the pin on the map.';
      }
    } catch {
      searchError = 'Location search failed. Check your connection, or drop the pin on the map.';
    } finally {
      searching = false;
    }
  }

  // Picking a result stages it as the draft (not an immediate save) so the admin
  // can fine-tune it on the map before committing.
  function onPick(r: GeocodingResult): void {
    draft = r.location;
    results = [];
    searchError = null;
  }

  // ── Map fine-tuning ─────────────────────────────────────────────────────────
  // Dragging the pin / clicking the map updates the draft coordinates, then
  // reverse-geocodes to refresh the label. Optimistic: set the coords immediately
  // with a coordinate label, then upgrade the label if the lookup succeeds.
  async function onMapChange(latitude: number, longitude: number): Promise<void> {
    const base = draft ?? saved;
    const timezone = base?.timezone || browserTimezone();
    draft = {
      latitude,
      longitude,
      timezone,
      label: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
    };
    try {
      const label = await reverseGeocode(latitude, longitude);
      // Only apply if the pin hasn't moved again while we were waiting.
      if (label && draft && draft.latitude === latitude && draft.longitude === longitude) {
        draft = { ...draft, label };
      }
    } catch {
      // Keep the coordinate label; reverse geocoding is best-effort.
    }
  }

  // ── Manual entry fallback ───────────────────────────────────────────────────
  let manualLat = $state('');
  let manualLng = $state('');
  let manualTimezone = $state('');
  let manualLabel = $state('');

  function onUseManual(): void {
    const lat = Number(manualLat.trim());
    const lng = Number(manualLng.trim());
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      addToast('Latitude must be a number between -90 and 90.', 'destructive');
      return;
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      addToast('Longitude must be a number between -180 and 180.', 'destructive');
      return;
    }
    const timezone = manualTimezone.trim() || browserTimezone();
    const label = manualLabel.trim() || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    draft = { latitude: lat, longitude: lng, timezone, label };
  }

  // ── Save / clear ────────────────────────────────────────────────────────────
  let saving = $state(false);

  async function onSaveDraft(): Promise<void> {
    if (!draft) return;
    saving = true;
    const result = await setHomeLocation(draft);
    saving = false;
    if (result.kind !== 'ok') {
      addToast('Failed to save the home location.', 'destructive');
    } else {
      addToast('Home location saved.', 'success');
      // Saved value now drives the readout + map; drop the draft.
      draft = null;
      results = [];
      searchError = null;
    }
  }

  async function onReset(): Promise<void> {
    saving = true;
    const result = await resetHomeLocation();
    saving = false;
    if (result.kind !== 'ok') {
      addToast('Failed to clear the home location.', 'destructive');
    } else {
      addToast('Home location cleared.', 'success');
      draft = null;
    }
  }

  const busy = $derived($isLoadingAppSettings || saving);
</script>

<div class="rounded-lg border p-4" data-testid="app-settings-home-location">
  <h2 class="text-base font-medium">Home location</h2>
  <p class="mt-0.5 text-sm text-muted-foreground">
    The family's home location, used to anchor location-dependent features like the weather
    forecast. Search for an address or postcode, drag the pin on the map to fine-tune, or enter
    coordinates by hand.
  </p>

  {#if saved}
    <p class="mt-2 text-sm" data-testid="app-settings-home-location-saved">
      Saved location:
      <code class="rounded bg-muted px-1 py-0.5 text-xs">{saved.label}</code>
      <span class="text-muted-foreground">
        ({saved.latitude.toFixed(4)}, {saved.longitude.toFixed(4)} · {saved.timezone})
      </span>
    </p>
  {:else}
    <p class="mt-2 text-sm text-muted-foreground" data-testid="app-settings-home-location-unset">
      No home location set.
    </p>
  {/if}

  <!-- Search -->
  <div class="mt-3 flex items-end gap-2">
    <div class="flex-1">
      <TextField
        label="Search address or postcode"
        type="search"
        placeholder="e.g. 10 Downing Street, or SW1A 2AA"
        bind:value={query}
        disabled={busy || searching}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void onSearch();
          }
        }}
        data-testid="app-settings-home-location-search-input"
      />
    </div>
    <Button
      size="sm"
      onclick={() => void onSearch()}
      disabled={busy || searching || !query.trim()}
      data-testid="app-settings-home-location-search"
    >
      {searching ? 'Searching…' : 'Search'}
    </Button>
  </div>

  {#if searchError}
    <p class="mt-2 text-sm text-destructive" data-testid="app-settings-home-location-search-error">
      {searchError}
    </p>
  {/if}

  {#if results.length > 0}
    <ul class="mt-2 flex flex-col gap-1" data-testid="app-settings-home-location-results">
      {#each results as r (r.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 rounded-md border p-2 text-left text-sm hover:bg-muted disabled:opacity-50"
            onclick={() => onPick(r)}
            disabled={busy}
            data-testid="app-settings-home-location-result-{r.id}"
          >
            <span class="min-w-0 truncate">{r.label}</span>
            <span class="shrink-0 text-xs text-muted-foreground">
              {r.location.latitude.toFixed(2)}, {r.location.longitude.toFixed(2)}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Map: drag the pin or click to fine-tune. -->
  <div class="mt-3">
    <LocationMapField
      latitude={pinLat}
      longitude={pinLng}
      onChange={(lat, lng) => void onMapChange(lat, lng)}
      testid="app-settings-home-location-map"
    />
    <p class="mt-1 text-xs text-muted-foreground">
      Drag the pin or click the map to set the exact spot.
    </p>
  </div>

  <!-- Selected (unsaved) location + Save -->
  {#if draft}
    <div
      class="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3"
      data-testid="app-settings-home-location-draft"
    >
      <p class="min-w-0 text-sm">
        Selected:
        <code class="rounded bg-muted px-1 py-0.5 text-xs">{draft.label}</code>
        <span class="text-muted-foreground">
          ({draft.latitude.toFixed(4)}, {draft.longitude.toFixed(4)} · {draft.timezone})
        </span>
      </p>
      <Button
        size="sm"
        onclick={() => void onSaveDraft()}
        disabled={busy || !canSaveDraft}
        data-testid="app-settings-home-location-save"
      >
        Save location
      </Button>
    </div>
  {/if}

  <!-- Manual entry fallback -->
  <details class="mt-3" data-testid="app-settings-home-location-manual">
    <summary class="cursor-pointer text-sm font-medium">Enter coordinates manually</summary>
    <div class="mt-2 flex flex-col gap-2">
      <div class="flex gap-2">
        <div class="flex-1">
          <TextField
            label="Latitude"
            placeholder="e.g. 51.5085"
            bind:value={manualLat}
            disabled={busy}
            data-testid="app-settings-home-location-manual-lat"
          />
        </div>
        <div class="flex-1">
          <TextField
            label="Longitude"
            placeholder="e.g. -0.1257"
            bind:value={manualLng}
            disabled={busy}
            data-testid="app-settings-home-location-manual-lng"
          />
        </div>
      </div>
      <TextField
        label="Timezone (IANA)"
        description="Defaults to this browser's timezone if left blank."
        placeholder="e.g. Europe/London"
        bind:value={manualTimezone}
        disabled={busy}
        data-testid="app-settings-home-location-manual-tz"
      />
      <TextField
        label="Label"
        description="A friendly name for this place. Defaults to the coordinates if left blank."
        placeholder="e.g. Home"
        bind:value={manualLabel}
        disabled={busy}
        data-testid="app-settings-home-location-manual-label"
      />
      <div>
        <Button
          size="sm"
          variant="outline"
          onclick={() => onUseManual()}
          disabled={busy}
          data-testid="app-settings-home-location-manual-use"
        >
          Use these coordinates
        </Button>
      </div>
    </div>
  </details>

  {#if saved}
    <div class="mt-3">
      <Button
        variant="outline"
        size="sm"
        onclick={() => void onReset()}
        disabled={busy}
        data-testid="app-settings-home-location-reset"
      >
        Clear home location
      </Button>
    </div>
  {/if}
</div>
