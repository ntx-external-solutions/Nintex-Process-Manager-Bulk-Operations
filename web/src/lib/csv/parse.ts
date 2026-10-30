/**
 * Minimal RFC 4180 CSV reader.
 *
 * Hand-rolled rather than pulled from npm because the surface we need is small, the
 * edge cases we care about are all things Excel actually emits (BOM, CRLF, quoted
 * fields containing commas and newlines, doubled quotes), and this runs byte-identical
 * in Node and the browser with no bundler involvement.
 *
 * Returns rows of raw cell strings. No trimming, no header handling, no type
 * coercion — callers own all of that.
 */

const BOM = '﻿';

export function parseCsv(input: string): string[][] {
  return parseCsvLines(input).map((r) => r.cells);
}

/** A parsed row and the line of the file it starts on, counting from 1. */
export interface CsvLine {
  cells: string[];
  line: number;
}

/**
 * As parseCsv, with each row's starting line, so a row can be pointed at in the file
 * (W7: rows with no id are listed by line). A quoted cell spanning lines moves the count
 * on, so the next row's number is still the one an editor shows.
 */
export function parseCsvLines(input: string): CsvLine[] {
  let text = input;
  if (text.startsWith(BOM)) text = text.slice(BOM.length);

  const rows: CsvLine[] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let i = 0;
  let line = 1;
  let rowStart = 1;

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldWasQuoted = false;
  };

  const endRow = (): void => {
    endField();
    rows.push({ cells: row, line: rowStart });
    row = [];
  };

  while (i < text.length) {
    const ch = text[i] as string;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      // A line break inside quotes is data, but still a line in the file. CRLF counts once.
      if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line += 1;
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      // A quote only opens a quoted field at the start of that field; a stray quote
      // mid-field is data, which is what Excel does too.
      inQuotes = true;
      fieldWasQuoted = true;
      i += 1;
      continue;
    }

    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }

    if (ch === '\r') {
      // Normalise CRLF and a lone CR to a row break.
      endRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      rowStart = ++line;
      continue;
    }

    if (ch === '\n') {
      endRow();
      i += 1;
      rowStart = ++line;
      continue;
    }

    field += ch;
    i += 1;
  }

  // Trailing content, or a final unterminated row. A file ending in a newline leaves
  // nothing pending and must not produce a phantom empty row.
  if (field !== '' || fieldWasQuoted || row.length > 0) {
    endRow();
  }

  return rows;
}

/** True when a parsed row carries no data at all (Excel loves emitting these). */
export function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}

/**
 * Quote a single cell for output.
 * We always quote rather than quoting conditionally — it is always valid, and it
 * keeps generated templates visually consistent.
 */
export function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Serialise rows to CSV text with CRLF line endings, which Excel prefers. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
