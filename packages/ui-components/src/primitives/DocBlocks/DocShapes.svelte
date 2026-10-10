<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import { shapeExtent, shapePath, shapeScale, type DocShapeSize } from './docDiagram';
  import { withUnit } from './docScale';
  import { DOC_TONE_SHAPE, DOC_TONE_TINT } from './docTone';
  import type { DocShape, DocShapesProps } from './DocBlocks.types';

  /**
   * Vessels drawn to scale from their measurements, on shelves. Every shape in
   * the drawing shares ONE scale (`shapeScale`), so a jar twice as tall is drawn
   * twice as tall, on any shelf. A toned shape is drawn filled (the ones you
   * own); an untoned one in outline. Shelves wrap on a narrow screen rather
   * than shrink, so the scale holds.
   */
  let { unit, shelves, caption, class: className }: DocShapesProps = $props();

  const size = (s: DocShape): DocShapeSize => ({
    profile: s.profile,
    mouth: s.mouth.value,
    height: s.height.value,
    width: s.width?.value,
    base: s.base?.value,
  });
  const scale = $derived(shapeScale(shelves.flatMap((shelf) => shelf.items.map(size))));
  const px = (n: number) => `${n * scale}px`;
  const measured = (s: DocShape) =>
    `${withUnit(s.height.text, unit)} tall, ${withUnit(s.mouth.text, unit)} across the mouth`;
</script>

<div
  class={cn('salt-doc-shapes my-3 grid gap-3 rounded border border-border bg-card p-3', className)}
>
  {#each shelves as shelf, s (s)}
    <section class="grid gap-1.5">
      {#if shelf.heading}
        <h3>{shelf.heading}</h3>
      {/if}
      <div class="flex flex-wrap items-stretch gap-y-2">
        {#each shelf.items as shape, i (i)}
          {@const box = size(shape)}
          <div class="grid grid-rows-[1fr_auto_auto] px-1.5 text-center text-xs">
            <div class="flex flex-col items-center justify-end gap-1 border-b border-border pb-0.5">
              {#if shape.count}
                <span
                  class={cn(
                    'rounded-full px-1.5 font-semibold tabular-nums',
                    DOC_TONE_TINT[shape.tone ?? 'muted'],
                  )}
                  data-count>{`×${shape.count.text}`}</span
                >
              {/if}
              <svg
                viewBox={`0 0 ${shapeExtent(box)} ${box.height}`}
                style:width={px(shapeExtent(box))}
                style:height={px(box.height)}
                class="overflow-visible"
                role="img"
                aria-label={`${shape.label}, ${measured(shape)}`}
              >
                <path
                  d={shapePath(box)}
                  class={shape.tone ? DOC_TONE_SHAPE[shape.tone] : 'fill-none stroke-placeholder'}
                  stroke-width="1.5"
                  stroke-linejoin="round"
                  vector-effect="non-scaling-stroke"
                  data-tone={shape.tone}
                  data-shape={shape.profile}
                />
              </svg>
            </div>
            <span class="mt-1 font-semibold whitespace-nowrap text-foreground">{shape.label}</span>
            <!-- Always a line, so every shelf's labels are one height and its line stays level. -->
            <span class="min-h-4 whitespace-nowrap text-muted-foreground"
              >{shape.caption ?? ''}</span
            >
          </div>
        {/each}
      </div>
    </section>
  {/each}
  <div class="text-xs text-muted-foreground">
    Drawn to scale, in {unit}{#if caption}. {caption}{/if}
  </div>
</div>
