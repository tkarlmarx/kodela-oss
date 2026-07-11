// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { importEdges, extractRelativeImports } from "./importEdges.js";

describe("extractRelativeImports", () => {
  test("pulls relative TS/JS import + require + re-export specifiers", () => {
    const src = [
      `import { a } from "./a";`,
      `import b from '../b.js';`,
      `export { c } from "./sub/c";`,
      `const d = require("./d");`,
      `const lazy = await import("./e");`,
      `import react from "react";`, // bare — ignored
    ].join("\n");
    const specs = extractRelativeImports("src/x.ts", src);
    assert.deepEqual(specs.sort(), ["../b.js", "./a", "./d", "./e", "./sub/c"]);
  });

  test("handles python relative imports", () => {
    const src = "from .util import x\nimport .sibling\nimport os\n";
    const specs = extractRelativeImports("pkg/mod.py", src);
    assert.deepEqual(specs.sort(), [".sibling", ".util"]);
  });
});

describe("importEdges", () => {
  test("resolves ./ and ../ against the known set with extension fallbacks", () => {
    const files = [
      { path: "src/auth/session.ts", source: `import { mint } from "./jwt";\nimport { db } from "../db";` },
      { path: "src/auth/jwt.ts", source: "export const mint = () => 1;" },
      { path: "src/db.ts", source: "export const db = {};" },
    ];
    const edges = importEdges(files);
    assert.deepEqual(edges, [
      { from: "src/auth/session.ts", to: "src/auth/jwt.ts" },
      { from: "src/auth/session.ts", to: "src/db.ts" },
    ]);
  });

  test("rewrites a TS ESM .js specifier to the .ts file on disk", () => {
    const files = [
      { path: "routes.ts", source: `import { rotate } from "./session.js";` },
      { path: "session.ts", source: "export const rotate = () => 1;" },
    ];
    assert.deepEqual(importEdges(files), [{ from: "routes.ts", to: "session.ts" }]);
  });

  test("resolves directory imports via /index", () => {
    const files = [
      { path: "src/app.ts", source: `import { core } from "./core";` },
      { path: "src/core/index.ts", source: "export const core = 1;" },
    ];
    assert.deepEqual(importEdges(files), [{ from: "src/app.ts", to: "src/core/index.ts" }]);
  });

  test("drops imports that resolve outside the provided node set", () => {
    const files = [{ path: "src/a.ts", source: `import x from "./missing";` }];
    assert.deepEqual(importEdges(files), []);
  });

  test("de-duplicates, ignores self-imports, and is deterministically sorted", () => {
    const files = [
      { path: "src/z.ts", source: `import "./a";\nimport "./a";` },
      { path: "src/a.ts", source: `import "./a";` }, // self — dropped
    ];
    assert.deepEqual(importEdges(files), [{ from: "src/z.ts", to: "src/a.ts" }]);
  });

  test("empty source contributes no outgoing edges", () => {
    const files = [
      { path: "src/a.ts", source: "" },
      { path: "src/b.ts", source: `import "./a";` },
    ];
    assert.deepEqual(importEdges(files), [{ from: "src/b.ts", to: "src/a.ts" }]);
  });
});
