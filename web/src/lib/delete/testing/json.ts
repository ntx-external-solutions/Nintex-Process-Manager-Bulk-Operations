/**
 * Reading models in tests the way the PowerShell tests read them.
 *
 * `@($x.A.B).Count` and `@($x.A)[1]` are how the script's suite inspects a model: a
 * missing step is null rather than a throw, and a bare object counts as one element.
 * These two helpers give the ported assertions the same semantics, so a bucket the
 * remover leaves as `[]`, null or absent all count as zero, as they do there.
 */

/** Walks a path of field names and indexes. A number on a non-array treats it as one element. */
export function dig(value: unknown, ...path: ReadonlyArray<string | number>): unknown {
  let current: unknown = value;
  for (const step of path) {
    if (current === null || current === undefined) return null;
    if (typeof step === 'number') {
      const list = Array.isArray(current) ? current : [current];
      current = list[step];
    } else {
      if (typeof current !== 'object') return null;
      current = (current as Record<string, unknown>)[step];
    }
  }
  return current ?? null;
}

/** `@($value).Count`: null is 0, an array its length, anything else 1. */
export function count(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Array.isArray(value) ? value.length : 1;
}

/** `@($value)`: the value as an array. */
export function list(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
