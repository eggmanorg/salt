// A comment stripper for the source-scanning gates, shared rather than
// re-rolled per gate: the briefwriters gate and the unit-test spec guard each
// once carried a hand-rolled walker of their own, with the same regex-literal
// blindness in both (#1550, #1559).

import ts from 'typescript';

/**
 * Blank out every comment in a whole file's text before matching, so prose
 * ABOUT a pattern cannot be counted as an instance of it.
 *
 * Comments are found the way the compiler finds them, not by a hand-rolled
 * character walk: the text is parsed by `typescript` (the same dependency
 * `schemaCatchSites.mjs` parses with) and every token the parser produced is
 * visited. A comment can only sit in the trivia between two tokens, so the
 * trivia ranges are blanked and every token's own text is kept verbatim. That
 * is what makes a `//` or `/*` inside a regex LITERAL (`/\/\//`, `/[//]/`,
 * `/a\/*b/`), a quoted string or a template literal part of a token rather
 * than a comment opener, and a quote character inside a regex (`/don't/`)
 * part of the regex rather than a string opener. A `//` or `/*` inside a
 * template `${...}` interpolation is real code, not literal text, so it IS a
 * comment opener there and gets stripped like anywhere else. The hand-rolled
 * walkers this replaced had no regex state: `subjectBriefWriters.mjs`'s went
 * green over a real writer on exactly those lines (#1550), and
 * `unitTestSpec.mjs`'s carried the same blindness (#1559).
 *
 * Only characters are blanked, never removed, and newlines inside a comment
 * are kept, so line numbers downstream line up with the original file.
 *
 * Its boundary: the file is parsed as TypeScript whatever its extension, with
 * JSDoc parsing off (JSDoc would otherwise be surfaced as nodes rather than
 * trivia), and the above holds for source that parses. On source that does
 * not, the parser's error recovery decides the tokens, and text it skips is
 * re-scanned lexically — where a `/` reads as division, which is the old
 * walker's blindness back again for that file.
 */
export function stripComments(text) {
  const sourceFile = ts.createSourceFile(
    'scan.ts',
    text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    ts.ScriptKind.TS,
  );
  const chars = text.split(''); // UTF-16 units, the indexing the parser's positions use
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  };
  const visit = (node) => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      // A leaf token: [pos, start) is its leading trivia — whitespace and comments only.
      blank(node.pos, node.getStart(sourceFile));
      return;
    }
    children.forEach(visit);
  };
  visit(sourceFile);
  return chars.join('');
}
