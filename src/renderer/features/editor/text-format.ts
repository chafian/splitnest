// Line-ending and indentation detection for opened files (pure, no DOM).

export function detectEol(text: string): 'LF' | 'CRLF' {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > 0 && crlf >= lf ? 'CRLF' : 'LF';
}

/** Guesses the indentation unit from the first indented lines (tabs, 2 or 4 spaces). */
export function detectIndent(text: string): string {
  let tabs = 0;
  const widths = new Map<number, number>();
  for (const line of text.split(/\r?\n/, 500)) {
    if (line.startsWith('\t')) tabs++;
    const m = /^( +)\S/.exec(line);
    if (m) widths.set(m[1]!.length, (widths.get(m[1]!.length) ?? 0) + 1);
  }
  const spaced = [...widths.values()].reduce((a, b) => a + b, 0);
  if (tabs > spaced) return '\t';
  if (spaced === 0) return '  ';
  const fours = [...widths.entries()].filter(([w]) => w % 4 === 0).reduce((a, [, n]) => a + n, 0);
  const odd2 = [...widths.entries()].filter(([w]) => w % 4 === 2).reduce((a, [, n]) => a + n, 0);
  return odd2 > 0 || fours === 0 ? '  ' : '    ';
}
