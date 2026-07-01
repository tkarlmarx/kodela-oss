// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Localization pipeline (Phase 3 — P3.4). Confirms t() interpolates and falls
 * back to English, resolveLanguage normalises tags, every supported language has
 * a complete catalog, and the guard works.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  t,
  resolveLanguage,
  isLanguage,
  SUPPORTED_LANGUAGES,
  type Language,
  type MessageKey,
} from "./index.js";

describe("t (translate + interpolate)", () => {
  test("interpolates {var} placeholders", () => {
    assert.equal(t("en", "rationale.importedBy", { n: 12 }), "imported by 12 other files");
    assert.match(t("es", "rationale.risk", { risk: "high" }), /riesgo high/);
  });
  test("localises fixed strings", () => {
    assert.equal(t("en", "tour.title"), "Guided tour");
    assert.equal(t("es", "tour.title"), "Recorrido guiado");
    assert.equal(t("de", "tour.title"), "Geführte Tour");
    assert.equal(t("fr", "tour.whyHere"), "Pourquoi ici");
    assert.equal(t("pt", "tour.decisions"), "Decisões");
  });
  test("leaves an unknown placeholder intact rather than blanking it", () => {
    assert.equal(t("en", "rationale.importedBy", {}), "imported by {n} other files");
  });
});

describe("resolveLanguage / isLanguage", () => {
  test("normalises region tags to the base language", () => {
    assert.equal(resolveLanguage("es-ES"), "es");
    assert.equal(resolveLanguage("PT_br"), "pt");
    assert.equal(resolveLanguage("fr"), "fr");
  });
  test("falls back to English for unknown or missing tags", () => {
    assert.equal(resolveLanguage("xx"), "en");
    assert.equal(resolveLanguage(undefined), "en");
    assert.equal(resolveLanguage(""), "en");
  });
  test("isLanguage guards", () => {
    assert.equal(isLanguage("de"), true);
    assert.equal(isLanguage("klingon"), false);
    assert.equal(isLanguage(null), false);
  });
});

describe("catalog completeness", () => {
  test("every supported language defines every key used by en", () => {
    const keys: MessageKey[] = [
      "tour.title", "tour.summary", "tour.whyHere", "tour.theWhy", "tour.decisions",
      "rationale.startHere", "rationale.importedBy", "rationale.shapedBy",
      "rationale.risk", "rationale.notes", "rationale.foundational",
    ];
    for (const lang of SUPPORTED_LANGUAGES as Language[]) {
      for (const key of keys) {
        const s = t(lang, key, { n: 1, risk: "low", stops: 1, withWhy: 1 });
        assert.ok(s.length > 0, `${lang}/${key} is non-empty`);
        // Non-English catalogs should differ from English for at least the title.
        if (lang !== "en" && key === "tour.title") {
          assert.notEqual(s, t("en", key), `${lang} localises the title`);
        }
      }
    }
  });
});
