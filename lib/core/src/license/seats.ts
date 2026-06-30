// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Seat-limit policy (internal design note).
 *
 * Pure decision logic, separated from the DB count and the HTTP layer so it can
 * be unit-tested exhaustively. The server counts active members for an org and
 * asks this function whether one more seat may be consumed.
 *
 * Semantics:
 *  - No license, or a license without `maxSeats` ⇒ unlimited (enterprise custom
 *    / not-yet-metered). We do NOT block in that case — billing/seat caps are an
 *    explicit number, and absence means "uncapped", consistent with how
 *    enterprise deals are negotiated.
 *  - `maxSeats: N` ⇒ at most N active seats. Adding a seat is allowed only while
 *    `activeSeats < N`.
 */

import type { KodelaLicense } from "./types.js";

export interface SeatDecision {
  allowed: boolean;
  activeSeats: number;
  maxSeats: number | null; // null = unlimited
  remaining: number | null; // null = unlimited
  reason?: string;
}

/** Can the org add ONE more active seat right now? */
export function canAddSeat(activeSeats: number, license: KodelaLicense | null): SeatDecision {
  const maxSeats = license?.maxSeats ?? null;
  if (maxSeats === null) {
    return { allowed: true, activeSeats, maxSeats: null, remaining: null };
  }
  const remaining = Math.max(0, maxSeats - activeSeats);
  const allowed = activeSeats < maxSeats;
  return {
    allowed,
    activeSeats,
    maxSeats,
    remaining,
    reason: allowed
      ? undefined
      : `Seat limit reached: ${activeSeats}/${maxSeats} seats in use. Upgrade your plan or remove a member.`,
  };
}

/** Current seat usage snapshot (for the license probe / dashboard banner). */
export function seatUsage(activeSeats: number, license: KodelaLicense | null): SeatDecision {
  const maxSeats = license?.maxSeats ?? null;
  return {
    allowed: maxSeats === null ? true : activeSeats <= maxSeats,
    activeSeats,
    maxSeats,
    remaining: maxSeats === null ? null : Math.max(0, maxSeats - activeSeats),
  };
}
