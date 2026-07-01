// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Localization pipeline (Phase 3 — P3.4).
 *
 * Kodela's *captured* content (notes, decisions) is user-authored and stays
 * verbatim — we never machine-translate someone's recorded why. What this
 * localizes is the **scaffolding** Kodela generates around it: the headings and
 * templated phrases in guided tours and summaries, so a `--language es` tour
 * reads in Spanish while the captured why stays exactly as written.
 *
 * The pipeline is deliberately small and offline: message catalogs keyed by
 * language, a `t()` translator with `{var}` interpolation and an English
 * fallback for any missing key/language, and a supported-language list. Adding a
 * language is adding one catalog — no code changes.
 */

export type Language = "en" | "es" | "fr" | "de" | "pt";

export const SUPPORTED_LANGUAGES: readonly Language[] = ["en", "es", "fr", "de", "pt"];

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
};

export function isLanguage(v: unknown): v is Language {
  return typeof v === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(v);
}

/** Normalise a user-supplied language tag ("es-ES", "PT_br") to a supported one, else "en". */
export function resolveLanguage(tag: string | undefined): Language {
  if (!tag) return "en";
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return isLanguage(base) ? base : "en";
}

/** Message keys used by generated summaries/tours. */
export type MessageKey =
  | "tour.title"
  | "tour.summary"
  | "tour.whyHere"
  | "tour.theWhy"
  | "tour.decisions"
  | "rationale.startHere"
  | "rationale.importedBy"
  | "rationale.shapedBy"
  | "rationale.risk"
  | "rationale.notes"
  | "rationale.foundational";

type Catalog = Record<MessageKey, string>;

// English is the source of truth and the fallback for every other catalog.
const EN: Catalog = {
  "tour.title": "Guided tour",
  "tour.summary": "{stops} stops, dependency-ordered (foundational first). {withWhy} carry captured why.",
  "tour.whyHere": "Why here",
  "tour.theWhy": "The why",
  "tour.decisions": "Decisions",
  "rationale.startHere": "Start here — the most load-bearing module in the codebase",
  "rationale.importedBy": "imported by {n} other files",
  "rationale.shapedBy": "shaped by {n} recorded decisions",
  "rationale.risk": "{risk}-risk — read the why before you touch it",
  "rationale.notes": "{n} captured notes to read",
  "rationale.foundational": "Foundational module worth knowing early",
};

const ES: Catalog = {
  "tour.title": "Recorrido guiado",
  "tour.summary": "{stops} paradas, ordenadas por dependencia (primero las fundamentales). {withWhy} tienen el porqué capturado.",
  "tour.whyHere": "Por qué aquí",
  "tour.theWhy": "El porqué",
  "tour.decisions": "Decisiones",
  "rationale.startHere": "Empieza aquí — el módulo más fundamental del código",
  "rationale.importedBy": "importado por {n} archivos",
  "rationale.shapedBy": "moldeado por {n} decisiones registradas",
  "rationale.risk": "riesgo {risk} — lee el porqué antes de tocarlo",
  "rationale.notes": "{n} notas capturadas para leer",
  "rationale.foundational": "Módulo fundamental que conviene conocer pronto",
};

const FR: Catalog = {
  "tour.title": "Visite guidée",
  "tour.summary": "{stops} étapes, ordonnées par dépendance (les fondamentales d'abord). {withWhy} portent le pourquoi capturé.",
  "tour.whyHere": "Pourquoi ici",
  "tour.theWhy": "Le pourquoi",
  "tour.decisions": "Décisions",
  "rationale.startHere": "Commencez ici — le module le plus structurant du code",
  "rationale.importedBy": "importé par {n} autres fichiers",
  "rationale.shapedBy": "façonné par {n} décisions enregistrées",
  "rationale.risk": "risque {risk} — lisez le pourquoi avant d'y toucher",
  "rationale.notes": "{n} notes capturées à lire",
  "rationale.foundational": "Module fondamental à connaître tôt",
};

const DE: Catalog = {
  "tour.title": "Geführte Tour",
  "tour.summary": "{stops} Stationen, nach Abhängigkeit geordnet (Grundlegendes zuerst). {withWhy} tragen das erfasste Warum.",
  "tour.whyHere": "Warum hier",
  "tour.theWhy": "Das Warum",
  "tour.decisions": "Entscheidungen",
  "rationale.startHere": "Hier beginnen — das tragendste Modul der Codebasis",
  "rationale.importedBy": "von {n} anderen Dateien importiert",
  "rationale.shapedBy": "geprägt von {n} dokumentierten Entscheidungen",
  "rationale.risk": "{risk}-Risiko — lies das Warum, bevor du es anfasst",
  "rationale.notes": "{n} erfasste Notizen zu lesen",
  "rationale.foundational": "Grundlegendes Modul, das man früh kennen sollte",
};

const PT: Catalog = {
  "tour.title": "Tour guiado",
  "tour.summary": "{stops} paradas, ordenadas por dependência (fundamentais primeiro). {withWhy} têm o porquê capturado.",
  "tour.whyHere": "Por que aqui",
  "tour.theWhy": "O porquê",
  "tour.decisions": "Decisões",
  "rationale.startHere": "Comece aqui — o módulo mais estrutural do código",
  "rationale.importedBy": "importado por {n} arquivos",
  "rationale.shapedBy": "moldado por {n} decisões registradas",
  "rationale.risk": "risco {risk} — leia o porquê antes de mexer",
  "rationale.notes": "{n} notas capturadas para ler",
  "rationale.foundational": "Módulo fundamental que vale conhecer cedo",
};

const CATALOGS: Record<Language, Catalog> = { en: EN, es: ES, fr: FR, de: DE, pt: PT };

/**
 * Translate `key` into `lang`, interpolating `{var}` placeholders from `vars`.
 * Falls back to the English string for any key a catalog is missing, so a
 * partial catalog never yields a blank.
 */
export function t(lang: Language, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = CATALOGS[lang]?.[key] ?? EN[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}
