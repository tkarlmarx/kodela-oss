// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Guided tours (Phase 2 — P2.2). Confirms buildTour ranks foundational +
 * documented + risky modules first, caps to maxStops, respects documentedOnly,
 * writes a "why here" rationale that weaves in decisions/risk, and that the
 * markdown renderer includes the whys.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTour, formatTourMarkdown, type TourCandidate } from "./index.js";

function cand(over: Partial<TourCandidate>): TourCandidate {
  return {
    filePath: "src/x.ts",
    description: "does x",
    whys: [],
    decisions: [],
    riskLevel: "none",
    inboundCount: 0,
    ...over,
  };
}

describe("buildTour (Phase 2 guided tours)", () => {
  test("ranks the most load-bearing + documented module first", () => {
    const tour = buildTour([
      cand({ filePath: "src/leaf.ts", inboundCount: 0 }),
      cand({
        filePath: "src/core.ts",
        inboundCount: 12,
        riskLevel: "high",
        decisions: [{ decisionId: "d1", title: "Use ed25519", status: "accepted" }],
        whys: [{ entryId: "w1", note: "signing keys", severity: "high", tags: ["auth"] }],
      }),
      cand({ filePath: "src/util.ts", inboundCount: 3 }),
    ]);
    assert.equal(tour.stops[0]!.filePath, "src/core.ts");
    assert.equal(tour.stops[0]!.order, 1);
    assert.match(tour.stops[0]!.rationale, /Start here/);
    assert.match(tour.stops[0]!.rationale, /imported by 12/);
    assert.match(tour.stops[0]!.rationale, /decision/);
    assert.equal(tour.stats.withWhy, 1);
  });

  test("caps to maxStops", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      cand({ filePath: `src/f${i}.ts`, inboundCount: i }),
    );
    const tour = buildTour(many, { maxStops: 5 });
    assert.equal(tour.stops.length, 5);
    assert.equal(tour.stats.candidates, 30);
    // Highest inbound (f29) must lead.
    assert.equal(tour.stops[0]!.filePath, "src/f29.ts");
  });

  test("documentedOnly drops modules with no captured why", () => {
    const tour = buildTour(
      [
        cand({ filePath: "src/documented.ts", whys: [{ entryId: "w", note: "n", severity: "low", tags: [] }] }),
        cand({ filePath: "src/bare.ts", inboundCount: 99 }),
      ],
      { documentedOnly: true },
    );
    assert.equal(tour.stops.length, 1);
    assert.equal(tour.stops[0]!.filePath, "src/documented.ts");
  });

  test("markdown renderer weaves in the why and decisions", () => {
    const tour = buildTour([
      cand({
        filePath: "src/auth.ts",
        description: "handles auth",
        whys: [{ entryId: "w", note: "rotates tokens to prevent replay", severity: "high", tags: ["auth"] }],
        decisions: [{ decisionId: "d", title: "ed25519 over RSA", status: "accepted" }],
        inboundCount: 4,
      }),
    ]);
    const md = formatTourMarkdown(tour, "MyApp");
    assert.match(md, /# Guided tour — MyApp/);
    assert.match(md, /1\. auth {2}`src\/auth\.ts`/);
    assert.match(md, /rotates tokens to prevent replay/);
    assert.match(md, /ed25519 over RSA/);
    assert.match(md, /Why here:/);
  });

  test("empty input yields an empty tour, not a crash", () => {
    const tour = buildTour([]);
    assert.equal(tour.stops.length, 0);
    assert.equal(tour.stats.stops, 0);
    assert.match(formatTourMarkdown(tour), /# Guided tour/);
  });

  test("--language localises the scaffolding while notes stay verbatim (P3.4)", () => {
    const tour = buildTour(
      [
        cand({
          filePath: "src/auth.ts",
          inboundCount: 5,
          whys: [{ entryId: "w", note: "rotate tokens to prevent replay", severity: "high", tags: [] }],
        }),
      ],
      { language: "es" },
    );
    // The rationale (generated) is Spanish...
    assert.match(tour.stops[0]!.rationale, /Empieza aquí|importado por 5/);
    const md = formatTourMarkdown(tour, { language: "es", projectName: "MiApp" });
    assert.match(md, /# Recorrido guiado — MiApp/);
    assert.match(md, /Por qué aquí:/);
    assert.match(md, /El porqué:/);
    // ...but the captured note is untouched (user content is never translated).
    assert.match(md, /rotate tokens to prevent replay/);
  });
});
