// Editor colours come from CSS variables (tokens.css, set per theme by Settings › Appearance),
// so the editor follows the app theme without being recreated: surfaces and text from the UI
// tokens, caret like the terminal cursor (focus colour), syntax in the theme's terminal hues.
// The terminal's monospace font is used so code looks the same in both.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { TERMINAL_FONT } from '../terminal/terminal-theme';

const v = (name: string) => `var(--${name})`;
const field = { backgroundColor: v('bg-terminal'), border: `1px solid ${v('border-strong')}`, color: v('text') };

export const editorTheme = EditorView.theme(
  {
    '&': { color: v('text'), backgroundColor: v('bg-terminal'), height: '100%' },
    '.cm-scroller': { fontFamily: TERMINAL_FONT, lineHeight: '1.5' },
    '.cm-content': { caretColor: v('focus'), padding: '6px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('focus'), borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: v('ed-selection'),
    },
    '.cm-activeLine': { backgroundColor: v('ed-active-line') },
    '.cm-gutters': { backgroundColor: v('bg-terminal'), color: v('ed-gutter'), border: 'none', paddingRight: '6px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: v('ed-gutter-active') },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 14px', minWidth: '40px' },
    '.cm-foldPlaceholder': { backgroundColor: v('bg-elevated'), border: `1px solid ${v('border-strong')}`, color: v('text-muted') },
    '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: v('ed-match'), outline: `1px solid ${v('accent-line')}` },
    '.cm-searchMatch': { backgroundColor: v('ed-match'), outline: `1px solid ${v('accent-line')}` },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: v('ed-match-current') },
    '.cm-selectionMatch': { backgroundColor: v('ed-match') },
    '.cm-panels': { backgroundColor: v('bg-surface'), color: v('text') },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${v('border')}` },
    '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${v('border')}` },
    '.cm-panel input, .cm-panel button, .cm-panel label': { fontFamily: 'inherit', fontSize: '13px' },
    '.cm-panel.cm-search input[type=text], .cm-textfield': { ...field, borderRadius: '4px', padding: '3px 6px' },
    '.cm-button': { ...field, backgroundImage: 'none', backgroundColor: v('bg-elevated'), borderRadius: '4px' },
    '.cm-tooltip': { ...field, backgroundColor: v('bg-elevated') },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: v('ed-selection'), color: v('text') },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: v('syn-keyword') },
  { tag: [t.definitionKeyword, t.moduleKeyword], color: v('syn-keyword') },
  { tag: [t.string, t.special(t.string), t.regexp], color: v('syn-string') },
  { tag: [t.number, t.bool, t.null, t.atom], color: v('syn-number') },
  { tag: [t.comment, t.blockComment, t.lineComment, t.docComment], color: v('ed-comment'), fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: v('syn-function') },
  { tag: [t.typeName, t.className, t.namespace], color: v('syn-type') },
  { tag: [t.propertyName], color: v('syn-property') },
  { tag: [t.definition(t.variableName)], color: v('text') },
  { tag: [t.tagName], color: v('syn-tag') },
  { tag: [t.attributeName], color: v('syn-type') },
  { tag: [t.operator, t.punctuation, t.bracket], color: v('syn-operator') },
  { tag: [t.heading], color: v('accent'), fontWeight: '600' },
  { tag: [t.link, t.url], color: v('link'), textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: v('text-muted') },
  { tag: [t.invalid], color: v('danger') },
]);

export const editorHighlighting = syntaxHighlighting(highlight);
