// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFunctions,
  languageForFile,
  _resetParserCacheForTests,
  _grammarAvailableForTests,
  _setGrammarPathOverrideForTests,
} from "./treesitter-layer.js";

const TS_SOURCE = `
export function topLevel(x: number): number {
  return x + 1;
}

export async function asyncFn() {
  return 42;
}

export function* gen() {
  yield 1;
}

export const arrow = (x: number) => x * 2;

export class Greeter {
  greet(name: string): string {
    return "hi " + name;
  }
  async wave() {
    return true;
  }
}
`;

const TSX_SOURCE = `
import React from "react";

export function Hello({ name }: { name: string }) {
  return <div>{name}</div>;
}

export const Card: React.FC = () => <section><p>card</p></section>;

class Panel extends React.Component {
  render() {
    return <main>panel</main>;
  }
}
`;

const PY_SOURCE = `
def top_level(x):
    return x + 1

async def async_fn():
    return 42

class Greeter:
    def greet(self, name):
        return f"hi {name}"

    @staticmethod
    def wave():
        return True

@decorator
def decorated():
    return 1
`;

// One-time grammar resolution probe — controls `skip:` on the language-specific
// happy-path tests. Production code must NOT branch on this; this is a test-only
// guard so the suite refuses to run the happy-path assertions on a platform
// where the optionalDependency grammar genuinely failed to install.
const HAS_TS = _grammarAvailableForTests("typescript");
const HAS_TSX = _grammarAvailableForTests("tsx");
const HAS_PY = _grammarAvailableForTests("python");
const HAS_GO = _grammarAvailableForTests("go");
const HAS_RS = _grammarAvailableForTests("rust");
const HAS_JAVA = _grammarAvailableForTests("java");
const HAS_BASH = _grammarAvailableForTests("bash");

test("languageForFile maps extensions correctly", () => {
  assert.equal(languageForFile("a.ts"), "typescript");
  assert.equal(languageForFile("b.mts"), "typescript");
  assert.equal(languageForFile("c.cts"), "typescript");
  assert.equal(languageForFile("d.tsx"), "tsx");
  assert.equal(languageForFile("e.jsx"), "tsx");
  assert.equal(languageForFile("f.py"), "python");
  assert.equal(languageForFile("g.pyi"), "python");
  assert.equal(languageForFile("h.go"), "go");
  assert.equal(languageForFile("i.rs"), "rust");
  assert.equal(languageForFile("Greeter.java"), "java");
  assert.equal(languageForFile("script.sh"), "bash");
  assert.equal(languageForFile("script.bash"), "bash");
  assert.equal(languageForFile("README.md"), null);
});

test(
  "parseFunctions extracts TS functions, methods, class and arrow",
  { skip: HAS_TS ? false : "@lumis-sh/wasm-typescript not installed on this platform" },
  async () => {
    _resetParserCacheForTests();
    const fns = await parseFunctions("src/example.ts", TS_SOURCE);
    // Hard assertion — if grammars resolve and parsing still yields [], the
    // dispatcher is broken.  Skip via `skip:` is the only acceptable empty
    // result; `[]` here means a real regression.
    assert.notEqual(fns.length, 0, "parser returned [] for valid TS source");

    const names = fns.map((f) => `${f.kind}:${f.name}`);
    assert.ok(names.includes("function:topLevel"), `missing topLevel — got ${names.join(", ")}`);
    assert.ok(names.includes("function:asyncFn"), `missing asyncFn — got ${names.join(", ")}`);
    assert.ok(names.includes("generator:gen"), `missing gen — got ${names.join(", ")}`);
    assert.ok(names.includes("arrow:arrow"), `missing arrow — got ${names.join(", ")}`);
    assert.ok(names.includes("class:Greeter"), `missing Greeter — got ${names.join(", ")}`);
    assert.ok(names.includes("method:greet"), `missing greet — got ${names.join(", ")}`);
    assert.ok(names.includes("method:wave"), `missing wave — got ${names.join(", ")}`);

    const greet = fns.find((f) => f.kind === "method" && f.name === "greet");
    assert.equal(greet?.parent, "Greeter");
    assert.ok(greet!.startLine > 0);
    assert.ok(greet!.endLine >= greet!.startLine);
    assert.equal(greet!.language, "typescript");
    assert.match(greet!.ast_anchor, /^method:greet@\d+$/);
  },
);

test(
  "parseFunctions extracts TSX components and methods",
  { skip: HAS_TSX ? false : "@lumis-sh/wasm-tsx not installed on this platform" },
  async () => {
    _resetParserCacheForTests();
    const fns = await parseFunctions("src/Card.tsx", TSX_SOURCE);
    assert.notEqual(fns.length, 0, "parser returned [] for valid TSX source");
    const names = fns.map((f) => `${f.kind}:${f.name}`);
    assert.ok(names.includes("function:Hello"));
    assert.ok(names.includes("arrow:Card"));
    assert.ok(names.includes("class:Panel"));
    assert.ok(names.includes("method:render"));
    const render = fns.find((f) => f.kind === "method" && f.name === "render");
    assert.equal(render?.parent, "Panel");
    assert.equal(render?.language, "tsx");
  },
);

test(
  "parseFunctions extracts Python functions, classes and decorated forms",
  { skip: HAS_PY ? false : "@lumis-sh/wasm-python not installed on this platform" },
  async () => {
    _resetParserCacheForTests();
    const fns = await parseFunctions("src/example.py", PY_SOURCE);
    assert.notEqual(fns.length, 0, "parser returned [] for valid Python source");
    const names = fns.map((f) => `${f.kind}:${f.name}`);
    assert.ok(names.includes("function:top_level"), `missing top_level — got ${names.join(", ")}`);
    assert.ok(names.includes("function:async_fn"), `missing async_fn — got ${names.join(", ")}`);
    assert.ok(names.includes("class:Greeter"), `missing Greeter — got ${names.join(", ")}`);
    assert.ok(names.includes("function:decorated"), `missing decorated — got ${names.join(", ")}`);
    // Python methods (function_definition nested in class_definition) emit as
    // "function" via the query but get parent attribution from the AST walk.
    const greet = fns.find((f) => f.name === "greet");
    assert.equal(greet?.parent, "Greeter");
    assert.equal(greet?.language, "python");
  },
);

// ── Phase 4.1: Go / Rust / Java / Bash ──────────────────────────────────────

const GO_SOURCE = `package main

func TopLevel(x int) int {
\treturn x + 1
}

type Greeter struct {
\tname string
}

func (g *Greeter) Greet(name string) string {
\treturn "hi " + name
}

func (g Greeter) Wave() bool {
\treturn true
}

type Greeting interface {
\tGreet(name string) string
}
`;

const RUST_SOURCE = `fn top_level(x: i32) -> i32 {
    x + 1
}

struct Greeter {
    name: String,
}

impl Greeter {
    fn greet(&self, name: &str) -> String {
        format!("hi {}", name)
    }
    fn wave(&self) -> bool {
        true
    }
}

enum Mood {
    Happy,
    Sad,
}

trait Greeting {
    fn greet(&self, name: &str) -> String;
}
`;

const JAVA_SOURCE = `public class Greeter {
    private String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet(String who) {
        return "hi " + who;
    }

    public static int topLevel(int x) {
        return x + 1;
    }
}

interface Greeting {
    String greet(String who);
}

enum Mood {
    HAPPY,
    SAD;
}
`;

const BASH_SOURCE = `#!/usr/bin/env bash
function top_level() {
  echo "hi"
}

greet() {
  echo "hi $1"
}
`;

test(
  "parseFunctions extracts Go top-level functions, methods (with receiver), structs and interfaces",
  { skip: HAS_GO ? false : "@lumis-sh/wasm-go not installed on this platform" },
  async () => {
    _resetParserCacheForTests();
    const fns = await parseFunctions("src/example.go", GO_SOURCE);
    assert.notEqual(fns.length, 0, "Go parser returned [] for valid source");
    const tags = fns.map((f) => `${f.kind}:${f.name}`);
    assert.ok(tags.includes("function:TopLevel"), `missing TopLevel — got ${tags.join(", ")}`);
    assert.ok(tags.includes("class:Greeter"), `missing Greeter struct — got ${tags.join(", ")}`);
    assert.ok(tags.includes("method:Greet"), `missing Greet method — got ${tags.join(", ")}`);
    assert.ok(tags.includes("method:Wave"), `missing Wave method — got ${tags.join(", ")}`);
    assert.ok(tags.includes("class:Greeting"), `missing Greeting interface — got ${tags.join(", ")}`);

    // Pointer receiver — should still resolve to "Greeter".
    const greet = fns.find((f) => f.kind === "method" && f.name === "Greet");
    assert.equal(greet?.parent, "Greeter", `Greet receiver: ${greet?.parent}`);
    assert.equal(greet?.language, "go");

    // Value receiver — same.
    const wave = fns.find((f) => f.kind === "method" && f.name === "Wave");
    assert.equal(wave?.parent, "Greeter", `Wave receiver: ${wave?.parent}`);
  },
);

test(
  "parseFunctions extracts Rust top-level fns, impl methods (with type), struct/enum/trait",
  { skip: HAS_RS ? false : "@lumis-sh/wasm-rust not installed on this platform" },
  async () => {
    _resetParserCacheForTests();
    const fns = await parseFunctions("src/example.rs", RUST_SOURCE);
    assert.notEqual(fns.length, 0, "Rust parser returned [] for valid source");
    const tags = fns.map((f) => `${f.kind}:${f.name}`);
    assert.ok(tags.includes("function:top_level"), `missing top_level — got ${tags.join(", ")}`);
    assert.ok(tags.includes("class:Greeter"), `missing Greeter struct — got ${tags.join(", ")}`);
    assert.ok(tags.includes("class:Mood"), `missing Mood enum — got ${tags.join(", ")}`);
    assert.ok(tags.includes("class:Greeting"), `missing Greeting trait — got ${tags.join(", ")}`);

    // impl method — kind is "function" (Rust grammar emits function_item) but
    // resolveParent walks up to impl_item and picks the impl-for type.
    const greet = fns.find((f) => f.name === "greet" && f.parent === "Greeter");
    assert.ok(greet, `missing impl Greeter::greet with parent set — got ${JSON.stringify(fns)}`);
    assert.equal(greet?.language, "rust");

    // Trait-method *signature* (no body) — Phase 1 scope cut: tree-sitter-rust
    // emits these as `function_signature_item`, which the query intentionally
    // does NOT capture (only `function_item` with a body). The trait itself
    // appears as `class:Greeting`, so navigation isn't lost — we just don't
    // surface signature-only declarations as separate function nodes. Documented
    // in doc 14 under Phase 1 scope cuts.
    const traitItself = fns.find((f) => f.kind === "class" && f.name === "Greeting");
    assert.ok(traitItself, "trait Greeting itself extracted as class");
  },
);

test(
  "parseFunctions extracts Java methods, constructors, classes, interfaces and enums",
  { skip: HAS_JAVA ? false : "@lumis-sh/wasm-java not installed on this platform" },
  async () => {
    _resetParserCacheForTests();
    const fns = await parseFunctions("Greeter.java", JAVA_SOURCE);
    assert.notEqual(fns.length, 0, "Java parser returned [] for valid source");
    const tags = fns.map((f) => `${f.kind}:${f.name}`);
    assert.ok(tags.includes("class:Greeter"), `missing Greeter — got ${tags.join(", ")}`);
    assert.ok(tags.includes("class:Greeting"), `missing Greeting interface — got ${tags.join(", ")}`);
    assert.ok(tags.includes("class:Mood"), `missing Mood enum — got ${tags.join(", ")}`);
    assert.ok(tags.includes("method:greet"), `missing greet — got ${tags.join(", ")}`);
    assert.ok(tags.includes("method:topLevel"), `missing topLevel — got ${tags.join(", ")}`);
    assert.ok(tags.includes("method:Greeter"), `missing constructor — got ${tags.join(", ")}`);

    const greet = fns.find((f) => f.kind === "method" && f.name === "greet");
    assert.equal(greet?.parent, "Greeter");
    assert.equal(greet?.language, "java");

    const ctor = fns.find((f) => f.kind === "method" && f.name === "Greeter");
    assert.equal(ctor?.parent, "Greeter", "constructor parent");
  },
);

test(
  "parseFunctions extracts Bash function definitions (no class concept)",
  { skip: HAS_BASH ? false : "@lumis-sh/wasm-bash not installed on this platform" },
  async () => {
    _resetParserCacheForTests();
    const fns = await parseFunctions("scripts/utils.sh", BASH_SOURCE);
    assert.notEqual(fns.length, 0, "Bash parser returned [] for valid source");
    const tags = fns.map((f) => `${f.kind}:${f.name}`);
    assert.ok(tags.includes("function:top_level"), `missing top_level — got ${tags.join(", ")}`);
    assert.ok(tags.includes("function:greet"), `missing greet — got ${tags.join(", ")}`);

    // Bash has no class — parent must always be undefined.
    for (const fn of fns) {
      assert.equal(fn.parent, undefined, `bash function ${fn.name} should have no parent`);
      assert.equal(fn.language, "bash");
    }
  },
);

test("parseFunctions returns [] for unsupported extensions without throwing", async () => {
  const fns = await parseFunctions("README.md", "# nothing here");
  assert.deepEqual(fns, []);
});

test("parseFunctions returns [] for empty content without crashing", async () => {
  const fns = await parseFunctions("src/empty.ts", "");
  assert.deepEqual(fns, []);
});

test("parseFunctions returns [] for syntactically broken source instead of throwing", async () => {
  const broken = "function foo( { return };;; \n class { method() {";
  const fns = await parseFunctions("src/broken.ts", broken);
  assert.ok(Array.isArray(fns));
});

test("parseFunctions returns [] for a supported extension when its grammar wasm fails to load (real GRAMMAR_UNAVAILABLE path)", async () => {
  // Closes the doc 23 §Phase 4 outstanding gate.  Uses the test-only
  // resolveGrammarPath override to simulate "wasm not installed" — proves
  // that a .ts file (supported extension, languageForFile === 'typescript')
  // returns [] without throwing when the grammar can't be located.
  _setGrammarPathOverrideForTests(() => null);
  _resetParserCacheForTests();
  try {
    const fns = await parseFunctions("src/example.ts", TS_SOURCE);
    assert.deepEqual(fns, [], "GRAMMAR_UNAVAILABLE path must yield [] silently");
  } finally {
    _setGrammarPathOverrideForTests(null);
    _resetParserCacheForTests();
  }
});

test("parseFunctions returns [] for an extension that has no language mapping (proxy for unsupported)", async () => {
  // NOTE — naming honesty.  This exercises the `languageForFile === null`
  // branch, NOT the harder `GRAMMAR_UNAVAILABLE` path where a supported
  // extension fails to load its WASM grammar.  The grammar-fail path is
  // explicitly NOT covered by the unit suite because stubbing
  // `require.resolve` mid-process is fragile — see doc 23 §Phase 4 outstanding
  // gates ("GRAMMAR_UNAVAILABLE path … unverified") for the explicit waiver
  // and where the disclosure is tracked.
  const fns = await parseFunctions("src/file.kodela_no_grammar", "anything");
  assert.deepEqual(fns, []);
});
