/**
 * Section edits on a Markdown page: the agent says what to add or restate under which
 * heading, the host places it. A page grows by dated lines instead of being regenerated
 * whole on every change (a whole-page republish was 47% of a replay window's output).
 */
export interface WikiSectionEdit {
  /** The exact heading line, e.g. "## History". */
  section: string;
  /** Text added at the end of the section; the section is created at the page end if absent. */
  append?: string;
  /** Text that replaces the section body; the section must exist. */
  replace?: string;
}

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s/.exec(line);
  return match ? match[1]!.length : 0;
}

/** The body under a heading, up to the next heading of the same or higher level; null if absent. */
export function readWikiSection(content: string, section: string): string | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const heading = section.trim();
  const level = headingLevel(heading);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (level === 0 || start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const next = headingLevel(lines[end]!);
    if (next > 0 && next <= level) break;
    end += 1;
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

export function applyWikiEdits(content: string, edits: readonly WikiSectionEdit[]): string {
  let lines = content.replace(/\r\n/g, '\n').split('\n');
  for (const edit of edits) {
    const heading = edit.section.trim();
    const level = headingLevel(heading);
    if (level === 0) throw new Error(`wiki edit section must be a Markdown heading: ${heading}`);
    if ((edit.append === undefined) === (edit.replace === undefined)) {
      throw new Error(`wiki edit for ${heading} needs exactly one of append or replace`);
    }
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start === -1) {
      if (edit.replace !== undefined) throw new Error(`wiki section not found: ${heading}`);
      while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
      lines = [...lines, '', heading, edit.append!.replace(/\n+$/, ''), ''];
      continue;
    }
    let end = start + 1;
    while (end < lines.length) {
      const next = headingLevel(lines[end]!);
      if (next > 0 && next <= level) break;
      end += 1;
    }
    if (edit.replace !== undefined) {
      lines = [
        ...lines.slice(0, start + 1),
        edit.replace.replace(/\n+$/, ''),
        '',
        ...lines.slice(end),
      ];
      continue;
    }
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1]!.trim() === '') insertAt -= 1;
    lines = [
      ...lines.slice(0, insertAt),
      edit.append!.replace(/\n+$/, ''),
      ...lines.slice(insertAt),
    ];
  }
  return lines.join('\n');
}
