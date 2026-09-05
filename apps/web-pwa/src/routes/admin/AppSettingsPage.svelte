<script lang="ts">
  import { Button } from '@salt/ui-components';
  import { goBack } from '../../lib/nav.js';
  import {
    AI_MODEL_DEFAULTS,
    AI_MODEL_ROLES,
    AI_FLOW_ROLES,
    AI_FLOW_IDS,
    type AiModelRole,
    type AiFlowId,
  } from '@salt/domain/schemas';
  import AdminGuard from './AdminGuard.svelte';
  import ModelComboField from './ModelComboField.svelte';
  import HomeLocationField from './HomeLocationField.svelte';
  import WeatherForecastField from './WeatherForecastField.svelte';
  import {
    catalogByRole,
    isCatalogLoading,
    isCatalogUnavailable,
    ensureCatalog,
    refreshCatalog,
  } from '../../lib/aiModelCatalogService.js';
  import {
    appSettings,
    effectiveModels,
    effectiveFlowModels,
    isLoadingAppSettings,
    isAppSettingsCorrupt,
    setModelRole,
    resetModelRole,
    setFlowOverride,
    resetFlowOverride,
  } from '../../lib/appSettingsService.js';
  import { addToast } from '../../lib/toastStore.js';

  // Admin AI model settings (Phase 1). One free-text field per role; each
  // defaults to today's exact production model literal, so clearing a field (or
  // a missing/corrupt doc) falls back to the default. Changes take up to ~3
  // minutes to propagate (the CF resolver caches for 180s).
  //
  // Phase 2 adds an "Advanced: per-flow overrides" section: an optional override
  // for a single flow that takes precedence over its role's model. Same
  // field/save/reset pattern as the role cards.

  // Each card carries ONE hand-written sentence about what the tier is FOR — the
  // thing that makes the setting decidable — and nothing about which jobs use
  // it. The job list is generated below from the registry (issue #935): the
  // enumeration that used to live in this prose had fallen behind on four of the
  // five cards, because it was a second copy of something the registry already
  // knew.
  type RoleMeta = { role: AiModelRole; title: string; description: string };
  const ROLE_META: RoleMeta[] = [
    {
      role: 'fast',
      title: 'Fast model',
      description:
        'Everyday quality at everyday cost — the workhorse tier, for jobs that read something whole and hand back a short, structured answer.',
    },
    {
      role: 'lite',
      title: 'Lite model',
      description:
        'The cheapest and quickest tier, for mechanical jobs where the answer is already in the words in front of it and a small quality trade-off is worth the saving.',
    },
    {
      role: 'pro',
      title: 'Pro model',
      description:
        'The most capable and the slowest, for jobs where the quality of the judgement is the whole point and the volume is low enough to pay for it.',
    },
    {
      role: 'embedding',
      title: 'Embedding model',
      description:
        'Turns text into a vector so that wording which means the same thing scores as similar. It writes nothing — this is what matching runs on.',
    },
    {
      role: 'image',
      title: 'Image model',
      description:
        'Draws pictures instead of writing text. The costliest call per use, which is why a picture is generated once and stored rather than re-drawn.',
    },
  ];

  // Local edit buffer per role, seeded from the saved value (or empty so the
  // placeholder shows the default). Re-seeds whenever the saved doc changes.
  let drafts = $state<Record<AiModelRole, string>>({
    fast: '',
    lite: '',
    pro: '',
    embedding: '',
    image: '',
  });
  let saving = $state<Record<AiModelRole, boolean>>({
    fast: false,
    lite: false,
    pro: false,
    embedding: false,
    image: false,
  });

  $effect(() => {
    const s = $appSettings;
    for (const role of AI_MODEL_ROLES) {
      // Only mirror an explicit, non-default saved value into the field; leave
      // it blank when it equals the default so the placeholder communicates
      // "defaulting to X".
      const saved = s?.[role];
      drafts[role] = saved && saved !== AI_MODEL_DEFAULTS[role] ? saved : '';
    }
  });

  async function onSave(role: AiModelRole): Promise<void> {
    saving[role] = true;
    const result = await setModelRole(role, drafts[role]);
    saving[role] = false;
    if (result.kind !== 'ok') {
      addToast('Failed to save the model setting.', 'destructive');
    } else {
      addToast('Model setting saved. It may take up to ~3 minutes to take effect.', 'success');
    }
  }

  async function onReset(role: AiModelRole): Promise<void> {
    saving[role] = true;
    drafts[role] = '';
    const result = await resetModelRole(role);
    saving[role] = false;
    if (result.kind !== 'ok') {
      addToast('Failed to reset the model setting.', 'destructive');
    } else {
      addToast('Reset to default.', 'success');
    }
  }

  // ─── Phase 2: per-flow overrides ────────────────────────────────────────────
  // Human-readable label per flow id; the role is derived from AI_FLOW_ROLES.
  const FLOW_LABELS: Record<AiFlowId, string> = {
    arbitrateCanon: 'Canon arbitration',
    arbitrateProductForm: 'Product-form arbitration',
    authorRecipe: 'Recipe author (librarian)',
    chefChat: 'Chef Chat',
    describeEquipmentSubject: 'Equipment description (pictogram art direction)',
    describeRecipeScene: 'Recipe scene brief (hero art direction)',
    embedText: 'Embed text',
    estimateRecipeTimes: 'Recipe time re-estimate (phase strip + timing summary)',
    extractRecipeFromUrl: 'Recipe import from URL',
    extractRecipeFromPhoto: 'Recipe import from photo',
    extractProcessStages: 'Process stages (bread, ferments, cures)',
    generateGuidedPlan: 'Guided plan (prep list + step notes)',
    generateCanonIcon: 'Canon icon generation',
    generateEquipmentIcon: 'Equipment pictogram generation',
    generateKitchenToolIcon: 'Kitchen tool pictogram generation',
    generateRecipeImage: 'Recipe hero image generation',
    generateChatTitle: 'Chat title generation',
    identifyEquipment: 'Equipment identification',
    identifyRecipeKit: 'Recipe kit identification (what to get out)',
    parseEntry: 'Entry parsing',
    parseRecipeIngredients: 'Recipe ingredient parsing',
    populateEquipmentEntry: 'Equipment entry population',
    proposeSchedule: 'Schedule proposal (out of the oven at…)',
  };

  // Flow ids grouped by role, so the Advanced section mirrors the role cards.
  const FLOWS_BY_ROLE: { role: AiModelRole; flows: AiFlowId[] }[] = AI_MODEL_ROLES.map((role) => ({
    role,
    flows: AI_FLOW_IDS.filter((flowId) => AI_FLOW_ROLES[flowId] === role),
  })).filter((g) => g.flows.length > 0);

  // The jobs on a role, for its card — the same grouping the Advanced section
  // renders, so the two cannot disagree and neither can fall behind the
  // registry: adding a key to `AI_FLOW_ROLES` makes the compiler demand a
  // `FLOW_LABELS` entry (the map is `Record<AiFlowId, string>`), and that entry
  // is what appears here.
  //
  // The boundary of that: this lists the flows in the registry, which is every
  // job that resolves its model through `resolveModel`/`flowModel`. A CF flow
  // that hardcoded a model literal instead would run without appearing on any
  // card, and nothing here would notice — the same boundary the registry's own
  // completeness note states.
  //
  // The OTHER direction — a job listed here that the app never runs — used to
  // have no guard at all, and `categoriseRecipe` sat on the Fast card for months
  // as a job with no callable, no trigger and no client caller (#1249). It now
  // has one: `apps/cloud-functions/tests/ai/registryIsDeployed.test.ts` asserts
  // every registry id resolves its model in a file reachable by static import
  // from `apps/cloud-functions/src/index.ts`, i.e. inside the deployed bundle —
  // and it credits the id's resolution to the FLOW that names it (a
  // `defineIconFlow` descriptor counts for the three icon families that resolve
  // through a variable), not merely any file that happens to read the id, so a
  // read-only surface like `getImagePrompt.ts` cannot stand in for a retired
  // flow. Its boundary in turn: reachability is not invocation, so a flow
  // imported by index.ts but wired to no callable or trigger would still pass.
  //
  // Joined with a middot rather than a comma because several labels contain one
  // ("Process stages (bread, ferments, cures)") — with commas the reader cannot
  // tell where one job ends and the next begins.
  const jobsFor = (role: AiModelRole): string =>
    (FLOWS_BY_ROLE.find((g) => g.role === role)?.flows ?? [])
      .map((flowId) => FLOW_LABELS[flowId])
      .join(' · ');

  const initialFlowDrafts = (): Record<AiFlowId, string> =>
    Object.fromEntries(AI_FLOW_IDS.map((id) => [id, ''])) as Record<AiFlowId, string>;
  const initialFlowSaving = (): Record<AiFlowId, boolean> =>
    Object.fromEntries(AI_FLOW_IDS.map((id) => [id, false])) as Record<AiFlowId, boolean>;

  let flowDrafts = $state<Record<AiFlowId, string>>(initialFlowDrafts());
  let flowSaving = $state<Record<AiFlowId, boolean>>(initialFlowSaving());
  // Whether the Advanced section is expanded. Auto-opens when any override is
  // already set so an admin lands on existing config.
  let showAdvanced = $state(false);

  $effect(() => {
    const s = $appSettings;
    let anyOverride = false;
    for (const flowId of AI_FLOW_IDS) {
      // Mirror only an explicitly-set override into the field; leave it blank
      // (placeholder shows the inherited role model) when no override exists.
      const saved = s?.perFlow?.[flowId];
      flowDrafts[flowId] = saved ?? '';
      if (saved) anyOverride = true;
    }
    if (anyOverride) showAdvanced = true;
  });

  async function onSaveFlow(flowId: AiFlowId): Promise<void> {
    flowSaving[flowId] = true;
    const result = await setFlowOverride(flowId, flowDrafts[flowId]);
    flowSaving[flowId] = false;
    if (result.kind !== 'ok') {
      addToast('Failed to save the flow override.', 'destructive');
    } else {
      addToast('Flow override saved. It may take up to ~3 minutes to take effect.', 'success');
    }
  }

  async function onResetFlow(flowId: AiFlowId): Promise<void> {
    flowSaving[flowId] = true;
    flowDrafts[flowId] = '';
    const result = await resetFlowOverride(flowId);
    flowSaving[flowId] = false;
    if (result.kind !== 'ok') {
      addToast('Failed to clear the flow override.', 'destructive');
    } else {
      addToast('Override cleared — flow now follows its role.', 'success');
    }
  }

  // True when a flow currently has an explicit override in the saved doc.
  const flowHasOverride = $derived.by(() => {
    const perFlow = $appSettings?.perFlow;
    const out = {} as Record<AiFlowId, boolean>;
    for (const flowId of AI_FLOW_IDS) {
      out[flowId] = Boolean(perFlow?.[flowId]);
    }
    return out;
  });

  const lastUpdatedLabel = $derived.by(() => {
    const s = $appSettings;
    if (!s?.updatedAt) return null;
    const when = new Date(s.updatedAt).toLocaleString();
    return s.updatedBy ? `Last changed by ${s.updatedBy} on ${when}` : `Last changed on ${when}`;
  });

  // ─── Phase 3: live model catalog ────────────────────────────────────────────
  // Lazily load the capability-filtered Gemini catalog so each field's combobox
  // can suggest currently-available models. Best-effort: if it fails the
  // comboboxes degrade to free-text (allowCustom), so the page never blocks.
  $effect(() => {
    void ensureCatalog();
  });

  async function onRefreshCatalog(): Promise<void> {
    await refreshCatalog();
    if ($isCatalogUnavailable) {
      addToast('Could not refresh the model catalog — free-text entry still works.', 'destructive');
    } else {
      addToast('Model catalog refreshed.', 'success');
    }
  }
</script>

<AdminGuard>
  <div class="flex flex-col gap-4 p-4 sm:p-6" data-testid="admin-app-settings">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Application settings</h1>
        <p class="text-sm text-muted-foreground">
          Family and environment settings for Salt: home location, weather, and the AI models used
          by each flow.
        </p>
      </div>
      <Button size="sm" onclick={() => goBack('/admin')}>Back to admin</Button>
    </div>

    {#if lastUpdatedLabel}
      <p class="text-xs text-muted-foreground" data-testid="app-settings-audit">
        {lastUpdatedLabel}
      </p>
    {/if}

    <HomeLocationField />

    <WeatherForecastField />

    <!-- AI models — model selection for this environment. The home location and
         weather above are general application settings; everything below this
         heading configures the Gemini models the AI flows use. -->
    <div class="mt-2 flex items-start justify-between gap-3" data-testid="app-settings-ai-section">
      <div>
        <h2 class="text-lg font-semibold">AI models</h2>
        <p class="text-sm text-muted-foreground">
          Choose the Gemini model for each AI role in <strong>this environment only</strong> (dev, staging
          and production each have their own).
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onclick={() => void onRefreshCatalog()}
        disabled={$isCatalogLoading}
        data-testid="app-settings-refresh-catalog"
      >
        {$isCatalogLoading ? 'Refreshing…' : 'Refresh models'}
      </Button>
    </div>

    {#if $isCatalogUnavailable && !$isCatalogLoading}
      <div
        class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        data-testid="app-settings-catalog-unavailable"
      >
        The live model catalog is unavailable, so the dropdowns are empty — you can still type a
        model name by hand. Use "Refresh models" to try again.
      </div>
    {/if}

    <div
      class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      data-testid="app-settings-propagation-note"
    >
      Changes take up to ~3 minutes to propagate to running flows (each function caches the selected
      model for up to 180 seconds). Leave a field blank to use the default shown.
    </div>

    {#if $isAppSettingsCorrupt}
      <div
        class="rounded-md border border-destructive-container bg-destructive-container p-3 text-sm text-destructive-container-foreground"
        data-testid="app-settings-corrupt-warning"
      >
        The saved settings document is invalid and is being ignored — all roles are running on their
        defaults. Saving any field below will replace it with a valid document.
      </div>
    {/if}

    <div class="flex flex-col gap-4">
      {#each ROLE_META as meta (meta.role)}
        <div class="rounded-lg border p-4" data-testid="app-settings-role-{meta.role}">
          <h2 class="text-base font-medium">{meta.title}</h2>
          <p class="mt-0.5 text-sm text-muted-foreground">{meta.description}</p>
          <p
            class="mt-1 text-sm text-muted-foreground"
            data-testid="app-settings-role-jobs-{meta.role}"
          >
            <span class="font-medium">Used by:</span>
            {jobsFor(meta.role)}
          </p>

          <p class="mt-2 text-sm" data-testid="app-settings-effective-{meta.role}">
            Effective model:
            <code class="rounded bg-muted px-1 py-0.5 text-xs">{$effectiveModels[meta.role]}</code>
            {#if $effectiveModels[meta.role] === AI_MODEL_DEFAULTS[meta.role]}
              <span class="text-muted-foreground">(default)</span>
            {/if}
          </p>

          {#if meta.role === 'embedding'}
            <div
              class="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
              data-testid="app-settings-embedding-warning"
            >
              <strong>Changing the embedding model requires a re-embed migration.</strong> Existing canon
              and recipe vectors were produced by the current model; a different model's vectors are not
              comparable, so matching quality will degrade until everything is re-embedded. Do not change
              this without a planned migration.
            </div>
          {/if}

          <div class="mt-3 flex flex-col gap-2">
            <ModelComboField
              label={meta.title}
              placeholder={`Default: ${AI_MODEL_DEFAULTS[meta.role]}`}
              bind:value={drafts[meta.role]}
              models={$catalogByRole[meta.role]}
              role={meta.role}
              disabled={$isLoadingAppSettings || saving[meta.role]}
              testId={meta.role}
            />
            <div class="flex gap-2">
              <Button
                size="sm"
                onclick={() => void onSave(meta.role)}
                disabled={$isLoadingAppSettings || saving[meta.role]}
                data-testid="app-settings-save-{meta.role}"
              >
                Save
              </Button>
              <Button
                variant="outline"
                size="sm"
                onclick={() => void onReset(meta.role)}
                disabled={$isLoadingAppSettings || saving[meta.role]}
                data-testid="app-settings-reset-{meta.role}"
              >
                Reset to default
              </Button>
            </div>
          </div>
        </div>
      {/each}
    </div>

    <div class="rounded-lg border" data-testid="app-settings-advanced">
      <button
        type="button"
        class="flex w-full items-center justify-between gap-3 p-4 text-left"
        onclick={() => (showAdvanced = !showAdvanced)}
        aria-expanded={showAdvanced}
        data-testid="app-settings-advanced-toggle"
      >
        <span>
          <span class="text-base font-medium">Advanced: per-flow overrides</span>
          <span class="mt-0.5 block text-sm text-muted-foreground">
            Override the model for a single flow. An override takes precedence over the flow's role;
            leave it blank to follow the role. For one-off experiments — most flows should follow
            their role.
          </span>
        </span>
        <span class="text-sm text-muted-foreground">{showAdvanced ? 'Hide' : 'Show'}</span>
      </button>

      {#if showAdvanced}
        <div class="flex flex-col gap-4 border-t p-4">
          {#each FLOWS_BY_ROLE as group (group.role)}
            <div data-testid="app-settings-flow-group-{group.role}">
              <h3 class="text-sm font-semibold text-muted-foreground uppercase">
                {group.role} role
              </h3>
              <div class="mt-2 flex flex-col gap-4">
                {#each group.flows as flowId (flowId)}
                  <div class="rounded-md border p-3" data-testid="app-settings-flow-{flowId}">
                    <p class="text-sm font-medium">{FLOW_LABELS[flowId]}</p>
                    <p class="mt-1 text-sm" data-testid="app-settings-flow-effective-{flowId}">
                      Effective model:
                      <code class="rounded bg-muted px-1 py-0.5 text-xs"
                        >{$effectiveFlowModels[flowId]}</code
                      >
                      {#if flowHasOverride[flowId]}
                        <span class="text-muted-foreground">(override)</span>
                      {:else}
                        <span class="text-muted-foreground">(follows {group.role} role)</span>
                      {/if}
                    </p>

                    <div class="mt-2 flex flex-col gap-2">
                      <ModelComboField
                        label="Model override"
                        placeholder={`Follows ${group.role} role: ${$effectiveModels[group.role]}`}
                        bind:value={flowDrafts[flowId]}
                        models={$catalogByRole[group.role]}
                        role={group.role}
                        disabled={$isLoadingAppSettings || flowSaving[flowId]}
                        testId="flow-{flowId}"
                      />
                      <div class="flex gap-2">
                        <Button
                          size="sm"
                          onclick={() => void onSaveFlow(flowId)}
                          disabled={$isLoadingAppSettings || flowSaving[flowId]}
                          data-testid="app-settings-flow-save-{flowId}"
                        >
                          Save
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onclick={() => void onResetFlow(flowId)}
                          disabled={$isLoadingAppSettings ||
                            flowSaving[flowId] ||
                            !flowHasOverride[flowId]}
                          data-testid="app-settings-flow-reset-{flowId}"
                        >
                          Reset to role
                        </Button>
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</AdminGuard>
