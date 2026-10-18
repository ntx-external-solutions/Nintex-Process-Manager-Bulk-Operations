/**
 * The PowerShell suite's fixtures, read where they are.
 *
 * `Tests/Fixtures` holds real payloads captured from the demo tenant (and one synthetic
 * model covering every reference bucket). They are read in place rather than copied
 * under `web/`, so the repository keeps one copy of that tenant data, and so the two
 * suites cannot drift apart. Tests take ids and names from the fixtures themselves
 * instead of spelling them out.
 *
 * Node only: tests import this, the app never does.
 */

import { readFileSync } from 'node:fs';

const DIR = new URL('../../../../../Tests/Fixtures/', import.meta.url);

export type FixtureName = 'ActionCustomerRequest.json' | 'AllBuckets.json' | 'DependencyTest.json';

/** A fresh parse on every call, so a test that edits a model cannot leak into the next. */
export function readFixture<T = Record<string, unknown>>(name: FixtureName): T {
  return JSON.parse(readFileSync(new URL(name, DIR), 'utf8')) as T;
}
