// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Decision-contradiction detection — flags changes that reverse or contradict an
 * active recorded decision. Pure, offline, high-precision. See detect.ts.
 */
export { detectContradictions, changeText } from "./detect.js";
export { detectContradictionsAsync, cosine } from "./semantic.js";
export { stanceOf, BUILTIN_ALIASES, OPPOSED } from "./stance.js";
export type {
  Stance,
  EntityStance,
  ContradictionDecision,
  ContradictionChange,
  ContradictionKind,
  ContradictionFlag,
  DetectOptions,
  EmbedFn,
  JudgeFn,
  JudgeVerdict,
  AsyncDetectOptions,
} from "./types.js";
