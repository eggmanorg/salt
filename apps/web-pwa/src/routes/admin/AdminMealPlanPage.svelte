<script lang="ts">
  import { Button, Select, SelectContent, SelectItem, SelectTrigger } from '@salt/ui-components';
  import { goBack } from '../../lib/nav.js';
  import { WEEKDAYS, emptyTemplate, type Attendee, type Weekday } from '@salt/domain';
  import AdminGuard from './AdminGuard.svelte';
  import MealDayEditor from '../mealplan/MealDayEditor.svelte';
  // `people`, never `members` (issue #1300) — the standard-week template renders
  // the same attendee/chef row the live week does.
  import { people } from '../../lib/membersService.js';
  import {
    mealPlanTemplate,
    firstDayOfWeek,
    saveFirstDayOfWeek,
    setTemplateDayNote,
    setTemplateDayChefs,
    setTemplateDayGuests,
    addTemplateAttendee,
    removeTemplateAttendee,
    setTemplateAttendeeHomeTime,
    setTemplateAttendeeNote,
  } from '../../lib/mealPlanService.js';
  import { addToast } from '../../lib/toastStore.js';

  // The displayed template — falls back to an empty one until the doc loads (and
  // for a greenfield project with no template yet).
  const template = $derived($mealPlanTemplate ?? emptyTemplate());

  const WEEKDAY_LABELS: Record<Weekday, string> = {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
  };

  // Which weekday's sheet is open (#640, Phase 1) — page-owned, in memory only
  // (Rule 3), so exactly one day of the template is open at a time.
  let openDay = $state<Weekday | null>(null);

  async function onFirstDayChange(value: string): Promise<void> {
    const result = await saveFirstDayOfWeek(value as Weekday);
    if (result.kind !== 'ok') addToast('Failed to save the first day of the week.', 'destructive');
  }

  function toggleChef(weekday: Weekday, memberId: string): void {
    const chefs = template.days[weekday]?.chefs ?? [];
    const next = chefs.includes(memberId)
      ? chefs.filter((c) => c !== memberId)
      : [...chefs, memberId];
    void setTemplateDayChefs(weekday, next);
  }

  function toggleAttendee(weekday: Weekday, memberId: string): void {
    const attending = template.days[weekday]?.attendees.some((a) => a.memberId === memberId);
    if (attending) {
      void removeTemplateAttendee(weekday, memberId);
    } else {
      // Home time starts blank; the picker seeds 18:30 when first opened.
      const attendee: Attendee = { memberId, homeTime: null, note: '' };
      void addTemplateAttendee(weekday, attendee);
    }
  }
</script>

<AdminGuard>
  <div class="flex flex-col gap-4 p-4 sm:p-6" data-testid="admin-mealplan">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Meal plan settings</h1>
        <p class="text-sm text-muted-foreground">
          The standard week and the big-shop day. Loading the template into a week copies these days
          in.
        </p>
      </div>
      <Button size="sm" onclick={() => goBack('/admin')}>Back to admin</Button>
    </div>

    <!-- First day of the week (the big-shop day) -->
    <div class="flex flex-col gap-1.5" data-testid="first-day-setting">
      <span class="text-sm font-medium">First day of the week</span>
      <p class="text-xs text-muted-foreground">
        The "big shop" day each week starts on. Changing it only re-lays-out the week — it never
        reshapes the template.
      </p>
      <Select value={$firstDayOfWeek} onValueChange={(v) => v && void onFirstDayChange(v)}>
        <SelectTrigger class="w-48" data-testid="first-day-trigger">
          {WEEKDAY_LABELS[$firstDayOfWeek]}
        </SelectTrigger>
        <SelectContent>
          {#each WEEKDAYS as wd (wd)}
            <SelectItem value={wd}>{WEEKDAY_LABELS[wd]}</SelectItem>
          {/each}
        </SelectContent>
      </Select>
    </div>

    <!-- Standard template — seven weekday days -->
    <div class="mt-2 flex flex-col gap-3">
      {#each WEEKDAYS as wd (wd)}
        {@const day = template.days[wd]}
        {#if day}
          <MealDayEditor
            label={WEEKDAY_LABELS[wd]}
            bind:open={
              () => openDay === wd,
              (v) => {
                if (v) openDay = wd;
                else if (openDay === wd) openDay = null;
              }
            }
            {day}
            members={$people}
            testid={`tmpl-${wd}`}
            onNoteChange={(note) => void setTemplateDayNote(wd, note)}
            onChefToggle={(id) => toggleChef(wd, id)}
            onAttendeeToggle={(id) => toggleAttendee(wd, id)}
            onAttendeeHomeTime={(id, t) => void setTemplateAttendeeHomeTime(wd, id, t)}
            onAttendeeNote={(id, n) => void setTemplateAttendeeNote(wd, id, n)}
            onGuestsChange={(g) => void setTemplateDayGuests(wd, g)}
          />
        {/if}
      {/each}
    </div>
  </div>
</AdminGuard>
