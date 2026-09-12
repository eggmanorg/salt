<script lang="ts">
  import { untrack } from 'svelte';
  import { TextField } from '@salt/ui-components';

  // A minute box over a REQUIRED number (issue #1221).
  //
  // `TextField` is controlled: it paints whatever string the parent hands it. That
  // is right for Servings, whose model is `number | null` — an empty box means
  // `null`, `null` renders `''`, and the box round-trips. It is wrong for a phase's
  // two minute figures and a step timer's duration, where the model is a plain
  // number and HAS NO WAY TO SAY "EMPTY": clearing the box stored 0, 0 rendered
  // `'0'`, and the box repainted a `0` under the caret mid-edit. Backspace-then-
  // type — how a number is retimed on a phone — showed `045`.
  //
  // So the box owns its text and the number owns the model, and they are kept in
  // step deliberately rather than by echo. This is NOT a general-purpose numeric
  // primitive and it deliberately does not live in `@salt/ui-components`: both
  // callers are page-local to `routes/recipes/` — the phase strip
  // (`RecipePhaseEditor`) and a step timer (`RecipeMethodRail`) — and a caller
  // outside this folder is what would earn it a promotion.
  //
  // `tests/MinutesField.test.ts` pins the behaviour below, and is where it is
  // pinned: neither caller's suite reads the box's live text, only the number
  // that reached `onEdit`, which is precisely the assertion that cannot see this
  // defect.

  interface Props {
    label: string;
    /** The stored figure. Required, so `''` is not one of its values. */
    value: number;
    /** How this box's text becomes a stored figure. Each caller keeps its own
     * rule — the phase boxes floor and clamp negatives, the step timer does not —
     * so wrapping a call site here never changes what it saves. */
    parse: (text: string) => number;
    onValueChange: (minutes: number) => void;
    class?: string;
    'data-testid'?: string;
  }

  // `class` and `data-testid` ride in `...rest`. Naming `class` explicitly would
  // hand `TextField` a `string | undefined`, which `exactOptionalPropertyTypes`
  // refuses; spreading an absent optional prop is the shape it does accept.
  let { label, value, parse, onValueChange, ...rest }: Props = $props();

  // What the box shows. While it has focus this is the cook's, uninterpreted: a
  // cleared box stays cleared, and `01` stays `01` until they leave.
  let text = $state(untrack(() => String(value)));

  // The figure this box's own text last produced. Re-seeding on `value` alone
  // would put the defect straight back — clearing a box sets it to 0, and 0 is a
  // change. Re-seeding only when the stored figure DISAGREES with what the text
  // already parses to means our own edits never re-seed, and a change from
  // anywhere else always does.
  let authored = untrack(() => value);

  $effect(() => {
    if (value !== authored) {
      authored = value;
      text = String(value);
    }
  });

  function edit(next: string): void {
    text = next;
    authored = parse(next);
    onValueChange(authored);
  }

  // Leaving the box is what settles it: an empty box reads back as the 0 it
  // stored, and anything unparseable stops pretending it was accepted. Doing this
  // on blur rather than per keystroke is the whole point — mid-edit text is not
  // yet an answer.
  function settle(): void {
    text = String(value);
    authored = value;
  }
</script>

<TextField
  {label}
  inputmode="numeric"
  value={text}
  onValueChange={edit}
  onblur={settle}
  {...rest}
/>
