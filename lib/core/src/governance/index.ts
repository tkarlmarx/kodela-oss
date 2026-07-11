// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Governance metrics — decisions honored vs violated, % AI changes with captured
 * intent, and the composite governance score. See metrics.ts.
 */
export { computeGovernance } from "./metrics.js";
export type {
  GovernanceChange,
  GovernanceInput,
  GovernanceViolation,
  GovernanceScorecard,
} from "./metrics.js";
