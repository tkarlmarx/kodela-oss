// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canAddSeat, seatUsage } from "./seats.js";
import type { KodelaLicense } from "./types.js";

function lic(maxSeats?: number): KodelaLicense {
  return {
    plan: "team",
    features: ["dashboard"],
    orgId: "org_acme",
    expiresAt: "2099-01-01",
    ...(maxSeats !== undefined ? { maxSeats } : {}),
  };
}

describe("canAddSeat", () => {
  test("null license ⇒ unlimited (allowed)", () => {
    const d = canAddSeat(1000, null);
    assert.equal(d.allowed, true);
    assert.equal(d.maxSeats, null);
    assert.equal(d.remaining, null);
  });

  test("license without maxSeats ⇒ unlimited (allowed)", () => {
    const d = canAddSeat(50, lic());
    assert.equal(d.allowed, true);
    assert.equal(d.maxSeats, null);
  });

  test("under the cap ⇒ allowed with remaining", () => {
    const d = canAddSeat(3, lic(5));
    assert.equal(d.allowed, true);
    assert.equal(d.remaining, 2);
  });

  test("at the cap ⇒ blocked", () => {
    const d = canAddSeat(5, lic(5));
    assert.equal(d.allowed, false);
    assert.equal(d.remaining, 0);
    assert.match(d.reason ?? "", /Seat limit reached: 5\/5/);
  });

  test("over the cap (e.g. after a downgrade) ⇒ blocked, remaining clamped to 0", () => {
    const d = canAddSeat(7, lic(5));
    assert.equal(d.allowed, false);
    assert.equal(d.remaining, 0);
  });
});

describe("seatUsage", () => {
  test("reports usage under cap as ok", () => {
    const u = seatUsage(2, lic(5));
    assert.equal(u.allowed, true);
    assert.equal(u.activeSeats, 2);
    assert.equal(u.maxSeats, 5);
    assert.equal(u.remaining, 3);
  });

  test("over cap reports not-ok (for an over-limit banner)", () => {
    const u = seatUsage(6, lic(5));
    assert.equal(u.allowed, false);
    assert.equal(u.remaining, 0);
  });

  test("unlimited when no maxSeats", () => {
    const u = seatUsage(999, lic());
    assert.equal(u.maxSeats, null);
    assert.equal(u.remaining, null);
  });
});
