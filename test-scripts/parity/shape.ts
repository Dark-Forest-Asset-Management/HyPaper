/**
 * Shape-diff util for HL parity testing. Reused by the parity runner and by
 * every future epic's parity assertions.
 *
 * Compares the STRUCTURE of two JSON values (field names, nesting, types,
 * array element shapes) — not their values — so a HyPaper response can be
 * checked field-by-field against a captured HL golden. Distinguishes
 * key-present-with-null from key-absent, which matters for HL (it emits
 * `tif: null` / `cloid: null` rather than omitting).
 *
 * Severity:
 *   fail — a key HL emits is MISSING from HyPaper, or a non-null type
 *          mismatch (e.g. HL string vs HyPaper number). Real schema drift.
 *   warn — extra HyPaper key HL doesn't emit; a nullability difference
 *          (one side null) or an unverifiable empty array. Data-dependent,
 *          not necessarily wrong.
 */

export type Shape =
  | { kind: 'null' }
  | { kind: 'string' | 'number' | 'boolean' | 'undefined' }
  | { kind: 'array'; element?: Shape }
  | { kind: 'object'; fields: Record<string, Shape> };

export function shapeOf(v: unknown): Shape {
  if (v === null) return { kind: 'null' };
  if (Array.isArray(v)) return { kind: 'array', element: v.length ? shapeOf(v[0]) : undefined };
  const t = typeof v;
  if (t === 'object') {
    const fields: Record<string, Shape> = {};
    for (const [k, val] of Object.entries(v as object)) fields[k] = shapeOf(val);
    return { kind: 'object', fields };
  }
  return { kind: t as Shape['kind'] };
}

export interface Mismatch {
  path: string;
  severity: 'fail' | 'warn';
  detail: string;
}

export function diffShape(expected: Shape, actual: Shape, path = ''): Mismatch[] {
  const out: Mismatch[] = [];
  const p = path || '<root>';

  // Nullability is data-dependent (a field can be null on one row, set on
  // another) — never a hard fail.
  if (expected.kind === 'null' || actual.kind === 'null') {
    if (expected.kind !== actual.kind) {
      out.push({ path: p, severity: 'warn', detail: `nullability: HL=${expected.kind}, HyPaper=${actual.kind}` });
    }
    return out;
  }

  if (expected.kind !== actual.kind) {
    out.push({ path: p, severity: 'fail', detail: `type: HL=${expected.kind}, HyPaper=${actual.kind}` });
    return out;
  }

  if (expected.kind === 'object' && actual.kind === 'object') {
    for (const k of Object.keys(expected.fields)) {
      if (!(k in actual.fields)) {
        out.push({ path: `${p}.${k}`, severity: 'fail', detail: 'missing in HyPaper (HL emits it)' });
        continue;
      }
      out.push(...diffShape(expected.fields[k], actual.fields[k], `${p}.${k}`));
    }
    for (const k of Object.keys(actual.fields)) {
      if (!(k in expected.fields)) {
        out.push({ path: `${p}.${k}`, severity: 'warn', detail: 'extra in HyPaper (HL does not emit it)' });
      }
    }
  }

  if (expected.kind === 'array' && actual.kind === 'array') {
    if (!expected.element) return out;
    if (!actual.element) {
      out.push({ path: `${p}[]`, severity: 'warn', detail: 'cannot verify element shape — HyPaper array empty' });
      return out;
    }
    out.push(...diffShape(expected.element, actual.element, `${p}[]`));
  }

  return out;
}

/** Compare a HyPaper response against an HL golden. Returns mismatches. */
export function compareToGolden(golden: unknown, actual: unknown): Mismatch[] {
  return diffShape(shapeOf(golden), shapeOf(actual));
}
