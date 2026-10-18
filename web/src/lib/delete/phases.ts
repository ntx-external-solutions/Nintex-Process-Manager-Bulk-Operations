/**
 * The Bulk Delete engine, ported from `NintexProcessDependencies.ps1` one phase at a time
 * (handoff/TASKS.md, W5). Phase 1 ports the offline tests and fixtures; every later phase
 * replaces its stubs with the implementation and turns its tests on.
 *
 * A stub throws `notPorted`, and each ported test that needs one is marked
 * `{ skip: PHASE.<name> }`, so the suite stays green and the tests still typecheck
 * against the API they will hold the implementation to. (`skip`, not `todo`: a failing
 * todo prints its stack, and hundreds of those would bury a real failure.) When a phase
 * lands, its skips come off and the assertions decide.
 */

export const PHASE = {
  discovery: 'W5 discovery: claims, location fetches, reconciliation',
  hold: 'W5 hold: restore archived participants, the holding group',
  references: 'W5 reference removal: read-modify-write of each holder',
  checkpoints: 'W5 checkpoints: baseline, collateral after each phase, the gate',
  delete: 'W5 delete, and the post-delete checkpoint',
  unwind: 'W5 unwind: re-archive what the run restored, remove the holding group',
} as const;

export type Phase = keyof typeof PHASE;

export function notPorted(phase: Phase): never {
  throw new Error(`Not ported yet (${PHASE[phase]}).`);
}
