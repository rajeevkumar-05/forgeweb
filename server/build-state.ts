/**
 * Authoritative build state machine.
 *
 * A build advances through a fixed lifecycle:
 *
 *   queued → specifying → planning → awaiting_confirmation
 *          → generating → reviewing → validating → completed
 *
 * The user may also revise the specification from `awaiting_confirmation`,
 * which returns the build to `specifying` so a new proposal can be generated.
 *
 * with `failed` reachable from any active state and `needs_context` used when
 * the specification stage needs more input before it can continue.
 *
 * Every status change is checked against the table below. Illegal edges — such
 * as `awaiting_confirmation → completed` (skipping generation entirely) or
 * `specifying → generating` (skipping the confirmation gate) — are rejected.
 * This makes the confirmation gate and stage ordering impossible to bypass,
 * even from a future code path that forgets to guard the transition itself.
 */

import type { BuildStatus } from "./domain.ts";
import { ApiError } from "./lib.ts";

const ALLOWED_TRANSITIONS: Record<BuildStatus, readonly BuildStatus[]> = {
  queued: ["specifying", "failed"],
  specifying: ["planning", "needs_context", "failed"],
  planning: ["awaiting_confirmation", "needs_context", "failed"],
  awaiting_confirmation: ["generating", "specifying", "failed"],
  generating: ["reviewing", "failed"],
  reviewing: ["validating", "failed"],
  validating: ["completed", "failed"],
  needs_context: ["specifying", "planning", "failed"],
  completed: [],
  failed: [],
};

/**
 * True when `from → to` is a legal edge. A self-transition (`from === to`) is
 * treated as an idempotent no-op and always allowed, so re-writing the current
 * status (e.g. `confirm()` setting `generating` and the first generate stage
 * re-affirming it) never trips the guard.
 */
export function canTransition(from: BuildStatus, to: BuildStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throw `INVALID_TRANSITION` (HTTP 409) if `from → to` is not a legal edge. */
export function assertBuildTransition(from: BuildStatus, to: BuildStatus): void {
  if (!canTransition(from, to)) {
    throw new ApiError(
      409,
      "INVALID_TRANSITION",
      `Illegal build state transition: ${from} → ${to}.`,
    );
  }
}

/**
 * Validate and apply a status change on a build record in place. Prefer this
 * over assigning `build.status` directly so the transition is always checked.
 */
export function setBuildStatus(build: { status: BuildStatus }, to: BuildStatus): void {
  assertBuildTransition(build.status, to);
  build.status = to;
}
