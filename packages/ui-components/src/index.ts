// spec: ui-spec-v02.md §1.3 v0.2.17; ui-spec-v04.md §2 v0.4

// Primitives
export { default as Button } from './primitives/Button/Button.svelte';
export { default as CanonIcon } from './primitives/CanonIcon/CanonIcon.svelte';
export { default as Combobox } from './primitives/Combobox/Combobox.svelte';
export { default as ComboboxContent } from './primitives/Combobox/ComboboxContent.svelte';
export { default as ComboboxCreate } from './primitives/Combobox/ComboboxCreate.svelte';
export { default as ComboboxEmpty } from './primitives/Combobox/ComboboxEmpty.svelte';
export { default as ComboboxField } from './primitives/Combobox/ComboboxField.svelte';
export { default as ComboboxGroup } from './primitives/Combobox/ComboboxGroup.svelte';
export { default as ComboboxInput } from './primitives/Combobox/ComboboxInput.svelte';
export { default as ComboboxItem } from './primitives/Combobox/ComboboxItem.svelte';
export { default as ComboboxLabel } from './primitives/Combobox/ComboboxLabel.svelte';
export { default as ComboboxSeparator } from './primitives/Combobox/ComboboxSeparator.svelte';
export { default as ComboboxTrigger } from './primitives/Combobox/ComboboxTrigger.svelte';
export { default as Card } from './primitives/Card/Card.svelte';
export { default as CardContent } from './primitives/Card/CardContent.svelte';
export { default as CardDescription } from './primitives/Card/CardDescription.svelte';
export { default as CardFooter } from './primitives/Card/CardFooter.svelte';
export { default as CardHeader } from './primitives/Card/CardHeader.svelte';
export { default as CardTitle } from './primitives/Card/CardTitle.svelte';
export { default as Checkbox } from './primitives/Checkbox/Checkbox.svelte';
export { default as Chip } from './primitives/Chip/Chip.svelte';
export { default as ChipGroup } from './primitives/Chip/ChipGroup.svelte';
export { default as CollapsibleSection } from './primitives/CollapsibleSection/CollapsibleSection.svelte';
export { default as Dial } from './primitives/Dial/Dial.svelte';
export { default as Dialog } from './primitives/Dialog/Dialog.svelte';
export { default as DialogClose } from './primitives/Dialog/DialogClose.svelte';
export { default as DialogContent } from './primitives/Dialog/DialogContent.svelte';
export { default as DialogDescription } from './primitives/Dialog/DialogDescription.svelte';
export { default as DialogFooter } from './primitives/Dialog/DialogFooter.svelte';
export { default as DialogHeader } from './primitives/Dialog/DialogHeader.svelte';
export { default as DialogTitle } from './primitives/Dialog/DialogTitle.svelte';
export { default as DialogTrigger } from './primitives/Dialog/DialogTrigger.svelte';
export { default as DisclosureChevron } from './primitives/Disclosure/DisclosureChevron.svelte';
export { default as DisclosureTrigger } from './primitives/Disclosure/DisclosureTrigger.svelte';
export { default as Divider } from './primitives/Divider/Divider.svelte';
export { default as EditableRow } from './primitives/EditableRow/EditableRow.svelte';
export { default as EmptyState } from './primitives/EmptyState/EmptyState.svelte';
export { default as ErrorState } from './primitives/ErrorState/ErrorState.svelte';
export { default as Grid } from './primitives/Grid/Grid.svelte';
export { default as Heading } from './primitives/Heading/Heading.svelte';
export { default as Icon } from './primitives/Icon/Icon.svelte';
// The registered icon names, for gallery-style consumers (Storybook). Derived
// from the registry, so no consumer keeps its own list of names to drift.
export { iconNames } from './primitives/Icon/iconRegistry';
export { default as ImageCropper } from './primitives/ImageCropper/ImageCropper.svelte';
export { default as Inline } from './primitives/Inline/Inline.svelte';
export { default as Markdown } from './primitives/Markdown/Markdown.svelte';
// A drawn object, named (ui-spec-v12 §8.30). NOT a `Chip`: a 40px pictogram
// does not fit a 26px text pill in either direction, and the name says so.
export { default as PictogramPill } from './primitives/PictogramPill/PictogramPill.svelte';
export { default as Popover } from './primitives/Popover/Popover.svelte';
export { default as PopoverContent } from './primitives/Popover/PopoverContent.svelte';
export { default as PopoverTrigger } from './primitives/Popover/PopoverTrigger.svelte';
// One row of the menu a PopoverContent holds (ui-spec-v14 §8.33). The string it
// replaces was hand-written 28 times across four pages and still growing (#930).
export { default as PopoverMenuItem } from './primitives/Popover/PopoverMenuItem.svelte';
export { default as Progress } from './primitives/Progress/Progress.svelte';
export { default as RadioGroup } from './primitives/RadioGroup/RadioGroup.svelte';
export { default as RadioGroupItem } from './primitives/RadioGroup/RadioGroupItem.svelte';
export { default as Select } from './primitives/Select/Select.svelte';
export { default as SelectContent } from './primitives/Select/SelectContent.svelte';
export { default as SelectGroup } from './primitives/Select/SelectGroup.svelte';
export { default as SelectItem } from './primitives/Select/SelectItem.svelte';
export { default as SelectLabel } from './primitives/Select/SelectLabel.svelte';
export { default as SelectSeparator } from './primitives/Select/SelectSeparator.svelte';
export { default as SelectTrigger } from './primitives/Select/SelectTrigger.svelte';
export { default as Sheet } from './primitives/Sheet/Sheet.svelte';
export { default as SheetClose } from './primitives/Dialog/DialogClose.svelte';
export { default as SheetContent } from './primitives/Sheet/SheetContent.svelte';
export { default as SheetDescription } from './primitives/Dialog/DialogDescription.svelte';
export { default as SheetFooter } from './primitives/Sheet/SheetFooter.svelte';
export { default as SheetHeader } from './primitives/Dialog/DialogHeader.svelte';
export { default as SheetTitle } from './primitives/Dialog/DialogTitle.svelte';
export { default as SheetTrigger } from './primitives/Sheet/SheetTrigger.svelte';
export { default as Slider } from './primitives/Slider/Slider.svelte';
export { default as SliderRange } from './primitives/Slider/SliderRange.svelte';
export { default as SliderThumb } from './primitives/Slider/SliderThumb.svelte';
export { default as SliderTrack } from './primitives/Slider/SliderTrack.svelte';
export { default as Spinner } from './primitives/Spinner/Spinner.svelte';
export { default as SortableList } from './primitives/SortableList/SortableList.svelte';
export { default as Stack } from './primitives/Stack/Stack.svelte';
export { default as Switch } from './primitives/Switch/Switch.svelte';
export { default as Tabs } from './primitives/Tabs/Tabs.svelte';
export { default as TabsList } from './primitives/Tabs/TabsList.svelte';
export { default as TabsTrigger } from './primitives/Tabs/TabsTrigger.svelte';
export { default as TabsContent } from './primitives/Tabs/TabsContent.svelte';
export { default as Text } from './primitives/Text/Text.svelte';
export { default as Textarea } from './primitives/Textarea/Textarea.svelte';
export { default as TextField } from './primitives/TextField/TextField.svelte';
export { default as Toast } from './primitives/Toast/Toast.svelte';
export { default as ToastAction } from './primitives/Toast/ToastAction.svelte';
export { default as ToastClose } from './primitives/Toast/ToastClose.svelte';
export { default as ToastDescription } from './primitives/Toast/ToastDescription.svelte';
export { default as ToastProvider } from './primitives/Toast/ToastProvider.svelte';
export { default as ToastTitle } from './primitives/Toast/ToastTitle.svelte';
export { default as ToastViewport } from './primitives/Toast/ToastViewport.svelte';
export { default as Tooltip } from './primitives/Tooltip/Tooltip.svelte';
export { default as TooltipContent } from './primitives/Tooltip/TooltipContent.svelte';
export { default as TooltipProvider } from './primitives/Tooltip/TooltipProvider.svelte';
export { default as TooltipTrigger } from './primitives/Tooltip/TooltipTrigger.svelte';

// The value-chip surface (ui-spec-v09 §8.27). Exported as a class factory, not
// a component: it is worn BY a SelectTrigger / ComboboxInput / TextField frame,
// each of which already owns the interaction it needs.
export { valueChipVariants } from './primitives/Chip/Chip.variants';
export { popoverMenuItemVariants } from './primitives/Popover/PopoverMenuItem.variants';

// Helpers (re-exported from ./lib)
export { cn } from './lib/cn';
export { useId } from './lib/useId';

// Token re-exports
export * as tokens from './tokens';

// Types
export type { ButtonProps } from './primitives/Button/Button.types';
export type { CanonIconProps, CanonIconSize } from './primitives/CanonIcon/CanonIcon.types';
export type {
  ComboboxItem as ComboboxItemType,
  ComboboxProps,
  ComboboxInputProps,
  ComboboxFieldProps,
  ComboboxTriggerProps,
  ComboboxContentProps,
  ComboboxItemProps,
  ComboboxGroupProps,
  ComboboxLabelProps,
  ComboboxSeparatorProps,
  ComboboxEmptyProps,
  ComboboxCreateProps,
} from './primitives/Combobox/Combobox.types';
export type {
  CardProps,
  CardContentProps,
  CardDescriptionProps,
  CardFooterProps,
  CardHeaderProps,
  CardTitleProps,
} from './primitives/Card/Card.types';
export type { CheckboxProps, CheckedState } from './primitives/Checkbox/Checkbox.types';
export type { ChipProps, ChipTone, ChipGroupProps } from './primitives/Chip/Chip.types';
export type { CollapsibleSectionProps } from './primitives/CollapsibleSection/CollapsibleSection.types';
export type { DialProps } from './primitives/Dial/Dial.types';
export type {
  DialogProps,
  DialogContentProps,
  DialogPartProps,
} from './primitives/Dialog/Dialog.types';
export type {
  DisclosureTriggerProps,
  DisclosureChevronProps,
} from './primitives/Disclosure/Disclosure.types';
export type { DividerProps } from './primitives/Divider/Divider.types';
export type { EditableRowProps } from './primitives/EditableRow/EditableRow.types';
export type { EmptyStateProps } from './primitives/EmptyState/EmptyState.types';
export type { ErrorStateProps } from './primitives/ErrorState/ErrorState.types';
export type { GridProps } from './primitives/Grid/Grid.types';
export type { HeadingProps } from './primitives/Heading/Heading.types';
export type { IconProps } from './primitives/Icon/Icon.types';
export type { IconName } from './primitives/Icon/iconRegistry';
export type {
  ImageCropperProps,
  ImageCropperHandle,
  ImageCropperAspect,
} from './primitives/ImageCropper/ImageCropper.types';
export type { InlineProps } from './primitives/Inline/Inline.types';
export type { PictogramPillProps } from './primitives/PictogramPill/PictogramPill.types';
export type {
  PopoverProps,
  PopoverContentProps,
  PopoverPartProps,
} from './primitives/Popover/Popover.types';
export type { PopoverMenuItemProps } from './primitives/Popover/PopoverMenuItem.types';
export type { ProgressProps } from './primitives/Progress/Progress.types';
export type {
  RadioGroupProps,
  RadioGroupItemProps,
} from './primitives/RadioGroup/RadioGroup.types';
export type {
  SelectProps,
  SelectTriggerProps,
  SelectContentProps,
  SelectItemProps,
  SelectGroupProps,
  SelectLabelProps,
  SelectSeparatorProps,
} from './primitives/Select/Select.types';
export type {
  SheetProps,
  SheetContentProps,
  SheetPartProps,
  SheetSide,
} from './primitives/Sheet/Sheet.types';
export type {
  SliderProps,
  SliderTrackProps,
  SliderRangeProps,
  SliderThumbProps,
} from './primitives/Slider/Slider.types';
export type { SpinnerProps } from './primitives/Spinner/Spinner.types';
export type { SortableListProps } from './primitives/SortableList/SortableList.types';
export type { StackProps } from './primitives/Stack/Stack.types';
export type { SwitchProps } from './primitives/Switch/Switch.types';
export type {
  TabsProps,
  TabsListProps,
  TabsTriggerProps,
  TabsContentProps,
} from './primitives/Tabs/Tabs.types';
export type { TextProps } from './primitives/Text/Text.types';
export type { TextareaProps } from './primitives/Textarea/Textarea.types';
export type { TextFieldProps } from './primitives/TextField/TextField.types';
export type {
  ToastVariant,
  ToastProviderProps,
  ToastViewportProps,
  ToastProps,
  ToastPartProps,
  ToastActionProps,
} from './primitives/Toast/Toast.types';
export type {
  TooltipProviderProps,
  TooltipProps,
  TooltipContentProps,
  TooltipPartProps,
} from './primitives/Tooltip/Tooltip.types';

// Layout
export { default as AppShell } from './layout/AppShell/AppShell.svelte';
export { default as TopBar } from './layout/TopBar/TopBar.svelte';
export { default as SideNav } from './layout/SideNav/SideNav.svelte';
export { default as BottomNav } from './layout/BottomNav/BottomNav.svelte';

export type { AppShellProps } from './layout/AppShell/AppShell.types';
export type { TopBarProps } from './layout/TopBar/TopBar.types';
export type { SideNavProps } from './layout/SideNav/SideNav.types';
export type { BottomNavProps } from './layout/BottomNav/BottomNav.types';
export type { NavItem } from './layout/NavItem.types';

// Templates
export { default as ListPage } from './templates/ListPage/ListPage.svelte';
export { default as FormPage } from './templates/FormPage/FormPage.svelte';
export { default as DetailPage } from './templates/DetailPage/DetailPage.svelte';
export { default as SelectableList } from './templates/SelectableList/SelectableList.svelte';
export { default as SelectAllCheckbox } from './templates/SelectableList/SelectAllCheckbox.svelte';
export { default as RowSelectCheckbox } from './templates/SelectableList/RowSelectCheckbox.svelte';
export { createListSelection } from './templates/SelectableList/listSelection.svelte.js';

export type {
  ListPageProps,
  BulkAction,
  BulkActionIcon,
} from './templates/ListPage/ListPage.types';
export { LIST_PAGE_CONTEXT } from './templates/ListPage/ListPage.context';
export type { ListPageContext } from './templates/ListPage/ListPage.context';
export type { FormPageProps } from './templates/FormPage/FormPage.types';
export type { DetailPageProps } from './templates/DetailPage/DetailPage.types';
export type {
  SelectableListProps,
  SelectableListItem,
} from './templates/SelectableList/SelectableList.types';
export type {
  ListSelection,
  CreateListSelectionOptions,
} from './templates/SelectableList/listSelection.svelte.js';
