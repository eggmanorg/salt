// `@joplin/turndown-plugin-gfm@1.0.68` ships no typings — it is a CommonJS build
// of the upstream plugin with a `lib/` directory and nothing else, and there is no
// `@types/` package for either it or its unmaintained upstream. This declares the
// one export the library import uses.
//
// Delete this file if the package ever ships its own `.d.ts`.
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  /** Tables, strikethrough, task lists and highlighted code blocks. */
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
}
