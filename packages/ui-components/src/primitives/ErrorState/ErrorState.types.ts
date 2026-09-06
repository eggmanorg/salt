// spec: ui-spec-v13.md §8.32 v0.13.2
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

export type ErrorStateProps = {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  actions?: Snippet;
  class?: string;
  /**
   * `role` is NOT passable, exactly as on `EmptyState` (§8.31.4). §8.31.2 makes
   * the `status` / `alert` split the whole reason the two components exist
   * separately, so a caller able to override it could collapse the distinction
   * from the outside. Everything else on the panel element — `data-testid`,
   * `data-*`, `id`, `aria-*` — rides `...rest`.
   */
} & Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'role'>;
