<script lang="ts">
  // The keep-the-screen-awake toggle (issue #1620). One component, rendered in four
  // places — the title bar and the headers of the three cook screens, which run
  // full-viewport with no title bar — all flipping the one app-wide switch in
  // `$lib/keepAwake.svelte`. Unsupported browsers get nothing at all.
  //
  // An icon toggle, not a labelled switch: the cook headers have to stay legible
  // next to a long recipe title, and the title bar is already full at phone width.
  // `aria-pressed` carries the state for assistive tech, and every tap fires a toast
  // so a change is never silent.
  //
  // How ON shows differs by where the button sits:
  //   - `cook`: colour, muted → `warning`, the family the cook surfaces already
  //     spend on "pay attention to this".
  //   - `bar`: NOT colour. The title bar's surface is swapped wholesale for the
  //     non-prod environment banner and everything in it inherits that colour (see
  //     KitchenLink.svelte) — staging's bar is amber, so `warning` would vanish there.
  //     ON is an outline plus a tint, both drawn in `currentColor`, so it reads on
  //     prod and on every banner surface alike.
  import { Button, Icon } from '@salt/ui-components';
  import { keepAwake } from '../lib/keepAwake.svelte.js';

  interface Props {
    placement: 'bar' | 'cook';
    'data-testid': string;
  }
  let { placement, 'data-testid': testId }: Props = $props();

  const held = $derived(keepAwake.held);

  const buttonClass = $derived(placement === 'bar' && held ? 'border-current bg-current/15' : '');
  const glyphClass = $derived(
    placement === 'bar' ? '' : held ? 'text-warning' : 'text-muted-foreground',
  );
</script>

{#if keepAwake.supported}
  <Button
    variant="ghost"
    size="icon"
    class={buttonClass}
    onclick={() => void keepAwake.toggle()}
    ariaLabel="Keep screen awake"
    title={held ? 'Screen stays awake' : 'Keep screen awake'}
    aria-pressed={held}
    data-testid={testId}
    data-active={held}
  >
    {#snippet leading()}
      <!-- Lucide has no phone-with-padlock glyph, so it's composed: a Lock badge on
           the corner of Smartphone. The phone's outline is masked out under the
           badge rather than painted over with a background disc, so the knockout
           is right on whatever surface the button sits on — the title bar is four
           different colours. -->
      <span class="relative inline-flex transition-colors {glyphClass}">
        <Icon
          name="Smartphone"
          size={20}
          class="[mask-image:radial-gradient(circle_at_17px_17px,transparent_7.5px,black_8px)]"
        />
        <Icon name="Lock" size={14} class="absolute -right-1 -bottom-1" />
      </span>
    {/snippet}
  </Button>
{/if}
