// spec: ui-spec-v03.md §6 v0.3
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as pkg from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_SOURCE = readFileSync(join(__dirname, '../src/index.ts'), 'utf-8');

describe('@salt/ui-components', () => {
  it('is importable', () => {
    expect(pkg).toBeDefined();
  });

  describe('v0.2 exports', () => {
    it('exports Button', () => expect(pkg.Button).toBeDefined());
    it('exports Card and parts', () => {
      expect(pkg.Card).toBeDefined();
      expect(pkg.CardContent).toBeDefined();
      expect(pkg.CardDescription).toBeDefined();
      expect(pkg.CardFooter).toBeDefined();
      expect(pkg.CardHeader).toBeDefined();
      expect(pkg.CardTitle).toBeDefined();
    });
    it('exports Checkbox', () => expect(pkg.Checkbox).toBeDefined());
    it('exports Dialog and parts', () => {
      expect(pkg.Dialog).toBeDefined();
      expect(pkg.DialogClose).toBeDefined();
      expect(pkg.DialogContent).toBeDefined();
      expect(pkg.DialogDescription).toBeDefined();
      expect(pkg.DialogFooter).toBeDefined();
      expect(pkg.DialogHeader).toBeDefined();
      expect(pkg.DialogTitle).toBeDefined();
      expect(pkg.DialogTrigger).toBeDefined();
    });
    it('exports layout primitives', () => {
      expect(pkg.Divider).toBeDefined();
      expect(pkg.Grid).toBeDefined();
      expect(pkg.Heading).toBeDefined();
      expect(pkg.Icon).toBeDefined();
      expect(pkg.Inline).toBeDefined();
      expect(pkg.Stack).toBeDefined();
      expect(pkg.Text).toBeDefined();
    });
    it('exports Popover and parts', () => {
      expect(pkg.Popover).toBeDefined();
      expect(pkg.PopoverContent).toBeDefined();
      expect(pkg.PopoverTrigger).toBeDefined();
    });
    it('exports Progress', () => expect(pkg.Progress).toBeDefined());
    it('exports Spinner', () => expect(pkg.Spinner).toBeDefined());
    it('exports Switch', () => expect(pkg.Switch).toBeDefined());
    it('exports Textarea', () => expect(pkg.Textarea).toBeDefined());
    it('exports TextField', () => expect(pkg.TextField).toBeDefined());
    it('exports Tooltip and parts', () => {
      expect(pkg.Tooltip).toBeDefined();
      expect(pkg.TooltipContent).toBeDefined();
      expect(pkg.TooltipProvider).toBeDefined();
      expect(pkg.TooltipTrigger).toBeDefined();
    });
  });

  describe('v0.3 exports', () => {
    it('exports RadioGroup and RadioGroupItem', () => {
      expect(pkg.RadioGroup).toBeDefined();
      expect(pkg.RadioGroupItem).toBeDefined();
    });
    it('exports Select and all parts', () => {
      expect(pkg.Select).toBeDefined();
      expect(pkg.SelectContent).toBeDefined();
      expect(pkg.SelectGroup).toBeDefined();
      expect(pkg.SelectItem).toBeDefined();
      expect(pkg.SelectLabel).toBeDefined();
      expect(pkg.SelectSeparator).toBeDefined();
      expect(pkg.SelectTrigger).toBeDefined();
    });
    it('exports Slider and all parts', () => {
      expect(pkg.Slider).toBeDefined();
      expect(pkg.SliderRange).toBeDefined();
      expect(pkg.SliderThumb).toBeDefined();
      expect(pkg.SliderTrack).toBeDefined();
    });
    it('exports Sheet and all parts', () => {
      expect(pkg.Sheet).toBeDefined();
      expect(pkg.SheetClose).toBeDefined();
      expect(pkg.SheetContent).toBeDefined();
      expect(pkg.SheetDescription).toBeDefined();
      expect(pkg.SheetFooter).toBeDefined();
      expect(pkg.SheetHeader).toBeDefined();
      expect(pkg.SheetTitle).toBeDefined();
      expect(pkg.SheetTrigger).toBeDefined();
    });
    it('exports Toast and all parts', () => {
      expect(pkg.Toast).toBeDefined();
      expect(pkg.ToastAction).toBeDefined();
      expect(pkg.ToastClose).toBeDefined();
      expect(pkg.ToastDescription).toBeDefined();
      expect(pkg.ToastProvider).toBeDefined();
      expect(pkg.ToastTitle).toBeDefined();
      expect(pkg.ToastViewport).toBeDefined();
    });
  });

  describe('v0.9 exports', () => {
    it('exports Chip and ChipGroup', () => {
      expect(pkg.Chip).toBeDefined();
      expect(pkg.ChipGroup).toBeDefined();
    });
    it('exports CollapsibleSection', () => expect(pkg.CollapsibleSection).toBeDefined());
    it('exports the Disclosure pieces', () => {
      expect(pkg.DisclosureTrigger).toBeDefined();
      expect(pkg.DisclosureChevron).toBeDefined();
    });
  });

  describe('helpers and tokens', () => {
    it('exports cn helper', () => expect(pkg.cn).toBeDefined());
    it('exports useId helper', () => expect(pkg.useId).toBeDefined());
    it('exports tokens namespace', () => expect(pkg.tokens).toBeDefined());
  });

  describe('export identity (#1062)', () => {
    // A component becomes public by being named on src/index.ts, leaf file by
    // leaf file (ui-spec-v02 §3.2) — so the exported name and the source
    // filename should always agree. TextArea was an unnoticed exception among
    // 100+ exports; nothing caught it for the life of the package.
    //
    // Sheet is a second, deliberate exception: it is built directly on Dialog
    // (bits-ui) and reuses four of its sub-parts wholesale rather than
    // duplicating them. Adding a name here is a decision, not a shortcut —
    // it must show up in the diff for review.
    const KNOWN_ALIASES: Record<string, string> = {
      SheetClose: 'DialogClose',
      SheetDescription: 'DialogDescription',
      SheetHeader: 'DialogHeader',
      SheetTitle: 'DialogTitle',
    };

    it('every component export name matches its source filename, or is a documented exception', () => {
      const componentExportPattern = /export \{ default as (\w+) \} from '.*\/(\w+)\.svelte';/g;
      const mismatches: string[] = [];
      for (const match of INDEX_SOURCE.matchAll(componentExportPattern)) {
        const [, exportedName, fileName] = match;
        if (!exportedName || !fileName) continue;
        if (exportedName === fileName) continue;
        if (KNOWN_ALIASES[exportedName] === fileName) continue;
        mismatches.push(`${exportedName} (file: ${fileName}.svelte)`);
      }
      expect(mismatches).toEqual([]);
    });
  });
});
