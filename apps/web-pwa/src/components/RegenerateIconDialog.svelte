<script lang="ts">
  import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    TextField,
  } from '@salt/ui-components';

  // The optional one-shot prompt steer, asked once (issue #930, Phase 7).
  //
  // Two near-identical copies of this dialog existed — the Catalog's record
  // editor (shared across canon items and product forms since #871) and the
  // kitchen-tools page — about 45 lines each, agreeing on every word by nothing
  // more than having been copied.
  //
  // It is an INPUT, not a confirmation. The commit contract drops "are you
  // sure?", not the chance to say what you want different. That framing is the
  // reason the dialog exists at all, and it is why the title and description are
  // fixed here rather than being props: they are what makes it not a
  // confirmation, and a caller free to reword them could quietly turn it back
  // into one.
  //
  // It lives in components/ rather than @salt/ui-components because it composes
  // Dialog, TextField and Button for one app-specific job — an app composite, not
  // a primitive (Rule 7). Same reasoning as ImagePromptDialog beside it.

  type Props = {
    open: boolean;
    /**
     * Plain `open` + `onOpenChange` rather than `bind:open`, unlike
     * `ImagePromptDialog`. The two callers hold "which dialog is open" in
     * genuinely different shapes — a boolean on the record editor, and the open
     * ROW itself on the kitchen-tools page, where the tool being regenerated is
     * the state and a separate flag would be a second source of truth. A
     * `$bindable` would have made one of them pretend to be the other; this pair
     * is what `Dialog` itself offers and it serves both unchanged.
     */
    onOpenChange: (open: boolean) => void;
    /**
     * The example steer, per site: what you would sensibly say about a tin of
     * tomatoes is not what you would say about a whisk. Deliberately a prop and
     * not a shared default — the wording is the only part of this dialog that
     * knows what is being drawn.
     */
    placeholder: string;
    /**
     * Prefixes all three test ids. A prop because the record editor's varies
     * with the record kind (`canon-detail` / `product-form-detail`) while the
     * kitchen-tools page has one fixed value.
     */
    testidPrefix: string;
    /** Whether a regeneration is in flight. Each page derives this its own way. */
    busy: boolean;
    /** Handed the trimmed hint; empty string means "just try again". */
    onConfirm: (hint: string) => void;
  };

  let { open, onOpenChange, placeholder, testidPrefix, busy, onConfirm }: Props = $props();

  // The hint lives here, not at the call sites: both reset it to '' on open and
  // trimmed it on confirm, which is this dialog's business rather than the
  // page's. Cleared whenever the dialog opens, so a steer typed and abandoned
  // never silently rides along with the next regeneration.
  let hint = $state('');
  $effect(() => {
    if (open) hint = '';
  });

  function confirm(): void {
    onConfirm(hint.trim());
  }
</script>

<Dialog {open} {onOpenChange}>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="{testidPrefix}-regenerate-dialog">
      <DialogHeader>
        <DialogTitle>Regenerate icon</DialogTitle>
        <DialogDescription>
          Optionally add guidance for the new icon. Leave blank to just try again.
        </DialogDescription>
      </DialogHeader>
      <TextField
        label="Extra guidance (optional)"
        value={hint}
        onValueChange={(v) => (hint = v)}
        {placeholder}
        data-testid="{testidPrefix}-regenerate-hint"
        disabled={busy}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            confirm();
          }
        }}
      />
      <DialogFooter>
        <Button variant="outline" onclick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button
          data-testid="{testidPrefix}-regenerate-confirm"
          onclick={confirm}
          loading={busy}
          disabled={busy}
        >
          Regenerate
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>
