// spec: ui-spec-v02.md §8.12 v0.2.11
// Curated static registry of the Lucide icons Salt actually renders (issue #813).
//
// Icon.svelte used to index @lucide/svelte's `icons` barrel. That barrel is a
// namespace object, so nothing tree-shakes and all 1,764 icon modules shipped —
// 633 kB (109 kB gzipped) of the boot payload to draw the icons listed below.
// Importing each icon from its own `@lucide/svelte/icons/<kebab-name>` subpath
// ships only what is registered here.
//
// ADDING AN ICON: add the import and the record entry, both alphabetically. The
// primitive's `name` prop is typed `keyof typeof iconRegistry`, so an
// unregistered name fails `pnpm check` / `pnpm typecheck` naming the missing
// key — that compile error IS the maintenance mechanism, deliberately in place of
// a generator plus a CI staleness check (issue #813).
//
// Icons imported by name elsewhere in this package (DialogClose, SelectTrigger, …)
// are NOT registered here — a direct named import already tree-shakes.

import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import ArrowRight from '@lucide/svelte/icons/arrow-right';
import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
import Bell from '@lucide/svelte/icons/bell';
import BellPlus from '@lucide/svelte/icons/bell-plus';
import BellRing from '@lucide/svelte/icons/bell-ring';
import Blender from '@lucide/svelte/icons/blender';
import Bold from '@lucide/svelte/icons/bold';
import BookOpen from '@lucide/svelte/icons/book-open';
import CalendarDays from '@lucide/svelte/icons/calendar-days';
import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
import Camera from '@lucide/svelte/icons/camera';
import Carrot from '@lucide/svelte/icons/carrot';
import Check from '@lucide/svelte/icons/check';
import CheckCheck from '@lucide/svelte/icons/check-check';
import ChefHat from '@lucide/svelte/icons/chef-hat';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronLeft from '@lucide/svelte/icons/chevron-left';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import ChevronUp from '@lucide/svelte/icons/chevron-up';
import Circle from '@lucide/svelte/icons/circle';
import CircleCheck from '@lucide/svelte/icons/circle-check';
import CircleSlash from '@lucide/svelte/icons/circle-slash';
import CircleX from '@lucide/svelte/icons/circle-x';
import Clipboard from '@lucide/svelte/icons/clipboard';
import Clock from '@lucide/svelte/icons/clock';
import CookingPot from '@lucide/svelte/icons/cooking-pot';
import Copy from '@lucide/svelte/icons/copy';
import Ear from '@lucide/svelte/icons/ear';
import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
import ExternalLink from '@lucide/svelte/icons/external-link';
import Eye from '@lucide/svelte/icons/eye';
import EyeOff from '@lucide/svelte/icons/eye-off';
import Flame from '@lucide/svelte/icons/flame';
import FolderInput from '@lucide/svelte/icons/folder-input';
import GripVertical from '@lucide/svelte/icons/grip-vertical';
import HandPlatter from '@lucide/svelte/icons/hand-platter';
import Hourglass from '@lucide/svelte/icons/hourglass';
import ImagePlus from '@lucide/svelte/icons/image-plus';
import Images from '@lucide/svelte/icons/images';
import Italic from '@lucide/svelte/icons/italic';
import LayoutList from '@lucide/svelte/icons/layout-list';
import Link from '@lucide/svelte/icons/link';
import List from '@lucide/svelte/icons/list';
import ListChecks from '@lucide/svelte/icons/list-checks';
import ListFilter from '@lucide/svelte/icons/list-filter';
import Lock from '@lucide/svelte/icons/lock';
import Martini from '@lucide/svelte/icons/martini';
import Merge from '@lucide/svelte/icons/merge';
import Minus from '@lucide/svelte/icons/minus';
import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
import Pencil from '@lucide/svelte/icons/pencil';
import Percent from '@lucide/svelte/icons/percent';
import Play from '@lucide/svelte/icons/play';
import Plus from '@lucide/svelte/icons/plus';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import Search from '@lucide/svelte/icons/search';
import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
import Share from '@lucide/svelte/icons/share';
import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
import Smartphone from '@lucide/svelte/icons/smartphone';
import Soup from '@lucide/svelte/icons/soup';
import Sparkles from '@lucide/svelte/icons/sparkles';
import SkipForward from '@lucide/svelte/icons/skip-forward';
import Split from '@lucide/svelte/icons/split';
import SquarePlus from '@lucide/svelte/icons/square-plus';
import StickyNote from '@lucide/svelte/icons/sticky-note';
import Thermometer from '@lucide/svelte/icons/thermometer';
import Timer from '@lucide/svelte/icons/timer';
import Trash2 from '@lucide/svelte/icons/trash-2';
import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
import Undo2 from '@lucide/svelte/icons/undo-2';
import Upload from '@lucide/svelte/icons/upload';
import Users from '@lucide/svelte/icons/users';
import Wand from '@lucide/svelte/icons/wand';
import X from '@lucide/svelte/icons/x';

export const iconRegistry = {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Bell,
  BellPlus,
  BellRing,
  Blender,
  Bold,
  BookOpen,
  CalendarDays,
  CalendarPlus,
  Camera,
  Carrot,
  Check,
  CheckCheck,
  ChefHat,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clipboard,
  Clock,
  CookingPot,
  Copy,
  Ear,
  EllipsisVertical,
  ExternalLink,
  Eye,
  EyeOff,
  Flame,
  FolderInput,
  GripVertical,
  HandPlatter,
  Hourglass,
  ImagePlus,
  Images,
  Italic,
  LayoutList,
  Link,
  List,
  ListChecks,
  ListFilter,
  Lock,
  Martini,
  Merge,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Percent,
  Play,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Share,
  ShoppingCart,
  SlidersHorizontal,
  Smartphone,
  Soup,
  Sparkles,
  SkipForward,
  Split,
  SquarePlus,
  StickyNote,
  Thermometer,
  Timer,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  Users,
  Wand,
  X,
};

/** Every icon name the {@link Icon} primitive accepts. */
export type IconName = keyof typeof iconRegistry;

/**
 * The registered names, alphabetically. Derived from the registry itself so a
 * gallery consumer (Storybook) never keeps a second hand-list to drift.
 */
export const iconNames = Object.keys(iconRegistry) as IconName[];
