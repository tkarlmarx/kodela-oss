// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Architecture mapping (Phase 3 — P3.1). Confirms deriveArchitecture classifies
 * files into layers (specific rules before catch-all core), derives domains,
 * fuses risk per layer, honours caller rule overrides, and builds the
 * layer-to-layer dependency matrix from file edges.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deriveArchitecture,
  classifyLayer,
  deriveDomain,
  DEFAULT_LAYER_RULES,
  type ArchitectureNodeInput,
} from "./index.js";
import type { WhyLink } from "../comprehension/types.js";

function why(severity: WhyLink["severity"]): WhyLink {
  return { entryId: "e", note: "n", severity, tags: [] };
}

describe("classifyLayer / deriveDomain", () => {
  test("specific layers win over the catch-all Core", () => {
    assert.equal(classifyLayer("lib/core/src/auth/session.ts", DEFAULT_LAYER_RULES), "Auth & Security");
    assert.equal(classifyLayer("artifacts/api-server/src/routes/x.ts", DEFAULT_LAYER_RULES), "API");
    assert.equal(classifyLayer("lib/dashboard/src/pages/Home.tsx", DEFAULT_LAYER_RULES), "UI");
    assert.equal(classifyLayer("lib/core/src/util/math.ts", DEFAULT_LAYER_RULES), "Core");
  });
  test("tests are classified before anything else", () => {
    assert.equal(classifyLayer("lib/core/src/auth/session.test.ts", DEFAULT_LAYER_RULES), "Tests");
  });
  test("domain derives from the module segment or an explicit map", () => {
    assert.equal(deriveDomain("lib/core/src/x.ts"), "core");
    // Explicit map matches by substring and wins over the segment fallback.
    assert.equal(deriveDomain("src/billing/charge.ts", { billing: "Billing" }), "Billing");
    // No map match → second path segment.
    assert.equal(deriveDomain("lib/dashboard/pages/x.tsx"), "dashboard");
  });
});

describe("deriveArchitecture (Phase 3)", () => {
  const files: ArchitectureNodeInput[] = [
    { filePath: "lib/core/src/auth/session.ts", whys: [why("high")] },
    { filePath: "lib/core/src/auth/jwt.ts", whys: [why("critical")] },
    { filePath: "artifacts/api-server/src/routes/login.ts" },
    { filePath: "lib/dashboard/src/pages/Login.tsx" },
    { filePath: "lib/core/src/util/math.ts" },
  ];

  test("groups files into layers with per-layer highest risk", () => {
    const arch = deriveArchitecture(files);
    const auth = arch.layers.find((l) => l.layer === "Auth & Security")!;
    assert.equal(auth.fileCount, 2);
    assert.equal(auth.highestRisk, "critical");
    assert.equal(arch.stats.files, 5);
    assert.ok(arch.layers.some((l) => l.layer === "API"));
    assert.ok(arch.layers.some((l) => l.layer === "UI"));
  });

  test("caller rule overrides win over the defaults", () => {
    const arch = deriveArchitecture([{ filePath: "lib/core/src/auth/session.ts" }], {
      rules: [{ layer: "Identity", match: ["/auth"] }],
    });
    assert.equal(arch.assignments["lib/core/src/auth/session.ts"]!.layer, "Identity");
  });

  test("builds the layer-to-layer dependency matrix from file edges", () => {
    const arch = deriveArchitecture(files, {
      dependencies: [
        // UI login imports the API route → UI → API edge.
        { from: "lib/dashboard/src/pages/Login.tsx", to: "artifacts/api-server/src/routes/login.ts" },
        // API route imports auth → API → Auth edge.
        { from: "artifacts/api-server/src/routes/login.ts", to: "lib/core/src/auth/session.ts" },
      ],
    });
    const uiToApi = arch.layerEdges.find((e) => e.from === "UI" && e.to === "API");
    const apiToAuth = arch.layerEdges.find((e) => e.from === "API" && e.to === "Auth & Security");
    assert.ok(uiToApi, "UI depends on API");
    assert.ok(apiToAuth, "API depends on Auth");
    // Same-layer imports are not edges.
    assert.ok(!arch.layerEdges.some((e) => e.from === e.to));
  });

  test("empty input yields an empty, non-crashing map", () => {
    const arch = deriveArchitecture([]);
    assert.equal(arch.layers.length, 0);
    assert.equal(arch.stats.files, 0);
  });
});
