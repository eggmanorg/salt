<script lang="ts">
  import { DetailPage, Spinner } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import { goBack } from '../../lib/nav.js';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import { initLibrarySync, libraryPages, removeLibraryPage } from '../../lib/libraryService.js';
  import LibraryPageDocument from './LibraryPageDocument.svelte';

  /**
   * The route half of one library page (epic #1372, Phase 1) — `/library/:id`.
   *
   * Three states and nothing else: the collection has not arrived, the page is not
   * in it, or it is — and in the third case the whole surface is
   * `LibraryPageDocument`, which takes a page that is REQUIRED rather than one it
   * has to keep re-checking. Keeping the two halves apart is what stops every
   * field in the editor reading `page?.title ?? ''`.
   *
   * An ordinary AppShell route, so no entry in ./fullViewport.ts, and no `fill` —
   * the page is simply tall and `<main>` scrolls it (ui-spec-v07 §1.6).
   */
  let { params }: { params?: { id?: string } } = $props();
  const pageId = $derived(params?.id ?? '');

  // The collection, for as long as the surface is open — the house pattern, and
  // the reason nothing subscribes to `libraryPages` at app boot.
  $effect(() => initLibrarySync());

  const page = $derived($libraryPages?.find((p) => p.id === pageId));

  /** Delete, and leave for the list. `true` means it went. */
  async function handleDelete(): Promise<boolean> {
    const result = await removeLibraryPage(pageId);
    if (result.kind === 'err') return false;
    push('/library');
    return true;
  }
</script>

<!-- The library is still being built (issue #831): everyone outside the test group
     is redirected home and sees nothing at all — no denial copy, because a message
     would announce a feature they are not meant to know exists yet. Cosmetic only;
     the boundary is not here (see lib/featureGate.ts). -->
<FeatureGuard feature="library">
  {#if $libraryPages === undefined}
    <div class="flex items-center justify-center py-12" data-testid="library-page-loading">
      <Spinner size={24} />
    </div>
  {:else if page === undefined}
    <!-- Deleted on another device, or a stale link. Says so, rather than showing an
         empty page that reads as one with nothing written in it yet. -->
    <DetailPage title="Not found" onBack={() => void goBack('/library')} backLabel="Library">
      {#snippet children()}
        <p class="text-sm text-muted-foreground" data-testid="library-page-missing">
          That page isn't in the library any more.
        </p>
      {/snippet}
    </DetailPage>
  {:else}
    <LibraryPageDocument {page} onDelete={handleDelete} />
  {/if}
</FeatureGuard>
