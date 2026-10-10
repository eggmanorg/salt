// spec: ui-spec-v04.md §12.7 v0.4
import type { Component } from 'svelte';

/**
 * The props a `Markdown` caller's block renderer receives for one `salt-*`
 * fenced code block — the raw text, never parsed here. Parsing is the caller's
 * job: this package imports nothing from `@salt/*`, so it cannot name the
 * schemas that say what a block holds.
 */
export interface SaltBlockProps {
  /** The part of the fence's info string after `salt-`: ` ```salt-cards ` → `cards`. */
  kind: string;
  /** The text between the fences, without the final newline. */
  source: string;
}

export type SaltBlockRenderer = Component<SaltBlockProps>;

/** The element name the rewritten node carries, and the renderer-map key it is drawn by. */
export const SALT_BLOCK_TAG = 'salt-block';

const LANGUAGE_PREFIX = 'language-salt-';

type Node = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

function saltKind(pre: Node): string | null {
  if (pre.tagName !== 'pre' || pre.children?.length !== 1) return null;
  const code = pre.children[0];
  if (code?.type !== 'element' || code.tagName !== 'code') return null;
  const classes = code.properties?.className;
  if (!Array.isArray(classes)) return null;
  const lang = classes.find(
    (c): c is string => typeof c === 'string' && c.startsWith(LANGUAGE_PREFIX),
  );
  return lang ? lang.slice(LANGUAGE_PREFIX.length) : null;
}

function textOf(node: Node): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/**
 * Rewrite every `pre > code.language-salt-<kind>` into one `salt-block` element
 * carrying `{ kind, source }` as properties, for `Markdown`'s renderer map to
 * draw with the caller's component.
 *
 * Runs AFTER `rehype-sanitize` when the caller opted into `sanitizedHtml`, so it
 * opens no raw-HTML route: a `<salt-block>` typed as raw HTML is not on the
 * allowlist and is stripped before this runs, and without `sanitizedHtml` raw
 * HTML never becomes an element at all. The only `salt-block` the renderer ever
 * meets is one this function made, from text. `Markdown.test.ts` pins both.
 *
 * What survives to it: `hast-util-sanitize`'s default schema keeps a `code`
 * element's `language-*` class, which is the whole of what this reads.
 */
export function rehypeSaltBlocks() {
  return (tree: unknown): void => {
    const visit = (node: Node): void => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.map((child) => {
        const kind = child.type === 'element' ? saltKind(child) : null;
        if (kind === null) {
          visit(child);
          return child;
        }
        const source = textOf(child).replace(/\n$/, '');
        return {
          type: 'element',
          tagName: SALT_BLOCK_TAG,
          properties: { kind, source },
          children: [],
        };
      });
    };
    visit(tree as Node);
  };
}
