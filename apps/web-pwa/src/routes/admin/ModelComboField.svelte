<script lang="ts">
  import {
    Button,
    Combobox,
    ComboboxContent,
    ComboboxCreate,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    type ComboboxItemType,
  } from '@salt/ui-components';
  import type { AiModelRole } from '@salt/domain/schemas';
  import type { AiCatalogModel } from '@salt/firebase-sync';
  import { testModel as probeModel } from '../../lib/aiModelCatalogService.js';

  // One model field: a capability-filtered combobox (free-text retained via
  // allowCustom) plus a per-field "Test" probe. Used by both the role cards and
  // the Advanced per-flow rows on AppSettingsPage. When the catalog is
  // unavailable (`models` empty) it degrades to a plain free-text combobox.

  let {
    label,
    placeholder,
    value = $bindable(),
    models,
    role,
    disabled = false,
    testId,
  }: {
    label: string;
    placeholder: string;
    value: string;
    models: AiCatalogModel[];
    // Role decides the probe method server-side (embedding vs generate).
    role: AiModelRole;
    disabled?: boolean;
    testId: string;
  } = $props();

  const items = $derived<ComboboxItemType[]>(
    models.map((m) => ({
      value: m.name,
      label: m.displayName && m.displayName !== m.name ? `${m.name} — ${m.displayName}` : m.name,
    })),
  );

  function filterFn(input: string, item: ComboboxItemType): boolean {
    const q = input.trim().toLowerCase();
    if (!q) return true;
    return item.value.toLowerCase().includes(q) || item.label.toLowerCase().includes(q);
  }

  // The combobox emits the selected item's *value* (the model id). Custom typed
  // text also arrives via onValueChange / onCreate as the raw string.
  function onValueChange(v: string): void {
    value = v;
  }
  function onCreate(v: string): void {
    value = v;
  }

  type TestState =
    | { status: 'idle' }
    | { status: 'testing' }
    | { status: 'ok' }
    | { status: 'error'; message: string };
  let test = $state<TestState>({ status: 'idle' });

  // The model to probe: the typed/selected value, or the placeholder default
  // when the field is blank (blank = "use the default", so test that).
  const effectiveValue = $derived(value.trim());

  async function onTest(): Promise<void> {
    const model = effectiveValue;
    if (!model) {
      test = { status: 'error', message: 'Enter or choose a model first.' };
      return;
    }
    test = { status: 'testing' };
    const result = await probeModel(model, role);
    test = result.ok
      ? { status: 'ok' }
      : { status: 'error', message: result.error ?? 'Model test failed.' };
  }

  // Reset the test result whenever the value changes so a stale OK/error never
  // lingers against a different model.
  $effect(() => {
    void value;
    if (test.status === 'ok' || test.status === 'error') test = { status: 'idle' };
  });
</script>

<div class="flex items-end gap-2" data-testid="model-combo-{testId}">
  <div class="flex-1">
    <span class="mb-1 block text-sm font-medium">{label}</span>
    <Combobox
      {items}
      value={value || ''}
      allowCustom={true}
      {filterFn}
      {onValueChange}
      {onCreate}
      {placeholder}
    >
      <ComboboxField>
        <ComboboxInput data-testid="model-combo-input-{testId}" />
      </ComboboxField>
      <ComboboxContent>
        {#snippet children({ filteredItems, showCreate })}
          {#each filteredItems as item, i (item.value)}
            <ComboboxItem {item} index={i} />
          {/each}
          {#if showCreate}
            <ComboboxCreate />
          {/if}
          {#if filteredItems.length === 0 && !showCreate}
            <ComboboxEmpty>No matching models — type a custom name.</ComboboxEmpty>
          {/if}
        {/snippet}
      </ComboboxContent>
    </Combobox>
  </div>
  <Button
    variant="outline"
    size="sm"
    onclick={() => void onTest()}
    disabled={disabled || test.status === 'testing'}
    data-testid="model-combo-test-{testId}"
  >
    {test.status === 'testing' ? 'Testing…' : 'Test'}
  </Button>
</div>

{#if test.status === 'ok'}
  <p class="mt-1 text-xs text-secondary" data-testid="model-combo-test-ok-{testId}">
    Model responded successfully.
  </p>
{:else if test.status === 'error'}
  <p class="mt-1 text-xs text-destructive" data-testid="model-combo-test-error-{testId}">
    Test failed: {test.message}
  </p>
{/if}
