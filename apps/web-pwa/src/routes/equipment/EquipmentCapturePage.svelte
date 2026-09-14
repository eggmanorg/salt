<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    Button,
    Checkbox,
    FormPage,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Spinner,
    TextField,
  } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import { goBack } from '../../lib/nav.js';
  import { startUserActionSpan } from '@salt/observability';
  import {
    callIdentifyEquipment,
    callPopulateEquipmentEntry,
    captureEquipmentItem,
    isLoadingEquipment,
  } from '../../lib/equipmentService.js';
  import { addToast } from '../../lib/toastStore.js';
  import type { IdentifyEquipmentCandidate } from '@salt/firebase-sync';
  import type { EquipmentKind } from '@salt/domain/schemas';

  // ─── One browser-rooted trace across the whole add-equipment action (#361) ──
  // The action fires two AI callables — identify → populate — with human
  // think-time between (the user picks a candidate). We mint ONE root span at
  // "Identify" and hand its W3C traceparent to BOTH calls, so the two CF flows
  // nest under a single trace instead of re-rooting two. Inert no-op when browser
  // tracing is off (empty traceparent → the callable wrappers omit the field).
  // Never throws (Rule 10). Held in a plain let — not reactive UI state.
  let actionSpan: ReturnType<typeof startUserActionSpan> | null = null;

  function endActionSpan(): void {
    actionSpan?.end();
    actionSpan = null;
  }

  // Flush an in-flight trace if the user navigates away mid-action (bottom nav,
  // browser back) without saving or cancelling.
  onDestroy(endActionSpan);

  // ─── Step machine ─────────────────────────────────────────────────────────
  // step 1: raw name entry
  // step 2: pick AI candidate (or confirm custom)
  // step 3: review/edit AI accessories + manual add
  type Step = 1 | 2 | 3;
  let step = $state<Step>(1);

  // ─── Step 1 ───────────────────────────────────────────────────────────────
  let rawName = $state('');
  let identifyBusy = $state(false);
  let candidates = $state<readonly IdentifyEquipmentCandidate[]>([]);

  // Equipment or a family of kit (issue #1373). Asked here rather than only on
  // the record afterwards because steps 2 and 3 are PRODUCT IDENTIFICATION —
  // "which Magimix is this, and what ships in its box". A family is the
  // household's own list of things it already owns, so there is no product to
  // identify and no accessory list to fetch: "Frying pans" put through those two
  // AI calls buys two wrong answers. A family goes straight to the list.
  let kind = $state<EquipmentKind>('equipment');
  const isFamily = $derived(kind === 'family');

  async function handleIdentify(): Promise<void> {
    const name = rawName.trim();
    if (!name) return;
    if (isFamily) {
      confirmedName = name;
      draftAccessories = [];
      step = 3;
      return;
    }
    // Fresh add attempt → fresh trace root. End any prior span (e.g. the user
    // came Back and re-identified) so each attempt is its own trace.
    endActionSpan();
    actionSpan = startUserActionSpan(`Add equipment: ${name}`);
    identifyBusy = true;
    const child = actionSpan.child('callIdentifyEquipment');
    const result = await callIdentifyEquipment(name, actionSpan.traceparent || undefined);
    child.end();
    identifyBusy = false;
    if (result.kind !== 'ok') {
      actionSpan.setError();
      addToast('Could not reach AI. You can still type the name manually.', 'destructive');
      candidates = [];
    } else {
      candidates = result.value.candidates;
    }
    step = 2;
  }

  // ─── Step 2 ───────────────────────────────────────────────────────────────
  let confirmedName = $state('');
  let populateBusy = $state(false);

  interface DraftAccessory {
    id: string;
    name: string;
    owned: boolean;
    included: boolean;
  }
  let draftAccessories = $state<DraftAccessory[]>([]);

  function pickCandidate(name: string): void {
    confirmedName = name;
  }

  async function handleConfirm(): Promise<void> {
    const name = confirmedName.trim() || rawName.trim();
    if (!name) return;
    confirmedName = name;
    populateBusy = true;
    // SECOND leg of the same trace: reuse the action span's traceparent so this
    // flow nests beside identifyEquipment under one root, not a fresh trace.
    const child = actionSpan?.child('callPopulateEquipmentEntry');
    const result = await callPopulateEquipmentEntry(name, actionSpan?.traceparent || undefined);
    child?.end();
    populateBusy = false;
    if (result.kind !== 'ok') {
      actionSpan?.setError();
      addToast('Could not fetch accessories. You can add them manually.', 'destructive');
      draftAccessories = [];
    } else {
      // Phase 3 contract: no id, no owned in response — mint both here.
      // Accessories that ship in the standard box default to owned; the user
      // can untick if their unit was missing one.
      draftAccessories = result.value.accessories.map((a) => ({
        id: crypto.randomUUID(),
        name: a.name,
        owned: a.included,
        included: a.included,
      }));
    }
    step = 3;
  }

  // ─── Step 3 ───────────────────────────────────────────────────────────────
  let newAccessoryName = $state('');
  let saveBusy = $state(false);

  function addManualAccessory(): void {
    const name = newAccessoryName.trim();
    if (!name) return;
    // A family is a list of what the household HAS, so its entries go in owned
    // and the tick is never shown for them (issue #1373).
    draftAccessories = [
      ...draftAccessories,
      { id: crypto.randomUUID(), name, owned: isFamily, included: false },
    ];
    newAccessoryName = '';
  }

  function removeDraftAccessory(id: string): void {
    draftAccessories = draftAccessories.filter((a) => a.id !== id);
  }

  function toggleDraftOwned(id: string): void {
    draftAccessories = draftAccessories.map((a) => (a.id === id ? { ...a, owned: !a.owned } : a));
  }

  async function handleSave(): Promise<void> {
    saveBusy = true;
    // The save is a local Firestore write (no CF/AI continuation), but recording
    // it as a child gives the trace the client-side save timing under the same
    // root before we close the action span.
    const child = actionSpan?.child('captureEquipmentItem');
    const result = await captureEquipmentItem(
      confirmedName,
      draftAccessories.map((a) => ({ name: a.name, owned: a.owned, included: a.included })),
      kind,
    );
    child?.end();
    saveBusy = false;
    if (result.kind !== 'ok') {
      actionSpan?.setError();
      addToast('Failed to save equipment.', 'destructive');
      return;
    }
    addToast(`Added ${confirmedName}`, 'success');
    // Terminal success — close the add-equipment trace before navigating away.
    endActionSpan();
    push(`/equipment/${result.value.itemId}`);
  }

  const canIdentify = $derived(rawName.trim().length > 0 && !identifyBusy);
  const canConfirm = $derived((confirmedName.trim() || rawName.trim()).length > 0 && !populateBusy);
  // Block Save until the manifest subscription has hydrated — saving against
  // a not-yet-loaded store would overwrite the user's existing manifest.
  const canSave = $derived(!saveBusy && !$isLoadingEquipment);
</script>

{#if step === 1}
  <FormPage
    title="Add equipment"
    description={isFamily
      ? 'Name the family, then list what is in it.'
      : 'Type your appliance or tool name.'}
    submitLabel={isFamily ? 'Next' : 'Identify'}
    isSubmitting={identifyBusy}
    canSubmit={canIdentify}
    onSubmit={handleIdentify}
    onCancel={() => {
      endActionSpan();
      goBack('/equipment');
    }}
    class="p-4 sm:p-6"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-medium">What are you adding?</span>
        <Select value={kind} onValueChange={(v) => (kind = v as EquipmentKind)}>
          <SelectTrigger data-testid="equipment-kind-select">
            {isFamily ? 'A family of kit — several similar things' : 'A piece of equipment'}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="equipment">A piece of equipment</SelectItem>
            <SelectItem value="family">A family of kit — several similar things</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-sm font-medium" for="equipment-raw-name">Name</label>
        <TextField
          id="equipment-raw-name"
          bind:value={rawName}
          placeholder={isFamily
            ? 'e.g. Frying pans, Weck jars…'
            : 'e.g. KitchenAid Artisan, Magimix 5200XL…'}
          disabled={identifyBusy}
          data-testid="equipment-raw-name-input"
          autofocus
        />
      </div>
    </div>
  </FormPage>
{:else if step === 2}
  <FormPage
    title="Confirm name"
    description="Select a suggested name or keep what you typed."
    submitLabel={populateBusy ? 'Loading…' : 'Confirm'}
    isSubmitting={populateBusy}
    canSubmit={canConfirm}
    onSubmit={handleConfirm}
    class="p-4 sm:p-6"
  >
    {#snippet footer()}
      <div class="flex w-full items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onclick={() => (step = 1)} disabled={populateBusy}>Back</Button>
        <Button
          type="submit"
          loading={populateBusy}
          disabled={!canConfirm}
          data-testid="equipment-confirm-name-btn"
        >
          Confirm
        </Button>
      </div>
    {/snippet}

    <div class="flex flex-col gap-3">
      {#if candidates.length > 0}
        <p class="text-sm text-muted-foreground">AI suggestions:</p>
        <ul class="flex flex-col gap-2">
          {#each candidates as candidate (candidate.name)}
            <li>
              <button
                type="button"
                class="w-full rounded border px-4 py-3 text-left text-sm transition-colors {confirmedName ===
                candidate.name
                  ? 'border-primary bg-primary/5 font-medium'
                  : 'border-border bg-card hover:border-primary/50'}"
                onclick={() => pickCandidate(candidate.name)}
                data-testid="equipment-candidate"
              >
                <span class="font-medium">{candidate.name}</span>
                <span class="mt-0.5 block text-xs text-muted-foreground">{candidate.rationale}</span
                >
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="flex flex-col gap-1.5">
        <label class="text-sm font-medium" for="equipment-confirmed-name">
          {candidates.length > 0 ? 'Or type a custom name:' : 'Name:'}
        </label>
        <!-- Framed, not bare (#821). This placeholder is not an example — leaving
             the field empty really does keep `rawName` (see handleConfirm), so
             echoing the name back with no words around it read as a value the
             page had already set on your behalf. Now it says what it is: the
             default you have not overridden. -->
        <TextField
          id="equipment-confirmed-name"
          bind:value={confirmedName}
          placeholder={`Keep “${rawName}”`}
          disabled={populateBusy}
          data-testid="equipment-confirmed-name-input"
        />
      </div>
    </div>
  </FormPage>
{:else}
  <FormPage
    title={confirmedName}
    description={isFamily
      ? 'List what is in this family. Each one can carry a note on the record afterwards.'
      : 'Review AI-suggested accessories, toggle ownership, and add any extras.'}
    submitLabel="Save"
    isSubmitting={saveBusy}
    canSubmit={canSave}
    onSubmit={handleSave}
    class="p-4 sm:p-6"
  >
    {#snippet footer()}
      <div class="flex w-full items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onclick={() => (step = isFamily ? 1 : 2)} disabled={saveBusy}>
          Back
        </Button>
        <Button
          type="submit"
          loading={saveBusy}
          disabled={!canSave}
          data-testid="equipment-save-btn"
        >
          Save
        </Button>
      </div>
    {/snippet}

    <div class="flex flex-col gap-4">
      <!-- Accessory list -->
      {#if draftAccessories.length > 0}
        <div class="flex flex-col gap-2">
          <p class="text-sm font-medium">{isFamily ? 'Contains' : 'Accessories'}</p>
          <ul class="flex flex-col gap-1" data-testid="equipment-accessory-list">
            {#each draftAccessories as acc (acc.id)}
              <li
                class="flex items-center gap-3 rounded border border-border bg-card px-3 py-2 text-sm"
                data-testid="equipment-draft-accessory"
              >
                {#if !isFamily}
                  <Checkbox
                    checked={acc.owned}
                    onCheckedChange={() => toggleDraftOwned(acc.id)}
                    label=""
                    aria-label="Owned"
                  />
                {/if}
                <span class="flex-1">
                  {acc.name}
                  {#if acc.included}
                    <span class="ml-1 text-xs text-muted-foreground">(included)</span>
                  {/if}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => removeDraftAccessory(acc.id)}
                  aria-label="Remove {acc.name}"
                >
                  Remove
                </Button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- Manual add -->
      <div class="flex flex-col gap-1.5">
        <p class="text-sm font-medium">{isFamily ? 'Add item' : 'Add accessory'}</p>
        <div class="flex gap-2">
          <TextField
            bind:value={newAccessoryName}
            placeholder={isFamily ? 'e.g. 28cm cast iron…' : 'Accessory name…'}
            class="flex-1"
            data-testid="equipment-new-accessory-input"
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addManualAccessory();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            onclick={addManualAccessory}
            disabled={!newAccessoryName.trim()}
          >
            Add
          </Button>
        </div>
      </div>

      {#if saveBusy}
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size={16} />
          Saving…
        </div>
      {/if}
    </div>
  </FormPage>
{/if}
