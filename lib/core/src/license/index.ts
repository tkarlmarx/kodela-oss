// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export {
  KodelaFeatureSchema,
  KodelaLicensePlanSchema,
  KodelaLicenseSchema,
  KODELA_FEATURES,
} from "./types.js";
export type { KodelaFeature, KodelaLicensePlan, KodelaLicense } from "./types.js";

export {
  LICENSE_FILE_NAME,
  LICENSE_ENV_VAR,
  LICENSE_ENFORCE_SIGNATURE_ENV,
  signatureEnforcementEnabled,
  loadLicense,
  licenseHasFeature,
  hasFeature,
  isLicenseExpired,
  assessLicense,
} from "./resolver.js";
export type { LicenseAssessment } from "./resolver.js";

export {
  canonicalClaims,
  verifyLicenseSignature,
  isLicenseSigned,
  signingKeyFor,
} from "./verify.js";

export {
  SIGNING_KEYS,
  findSigningKey,
  publicKeyRegistry,
} from "./keys.js";
export type { SigningKey } from "./keys.js";

export { canAddSeat, seatUsage } from "./seats.js";
export type { SeatDecision } from "./seats.js";

export type { AdminGrant, IsAdminInput } from "./admin.js";
export {
  isAdmin,
  isAdminViaClaim,
  isAdminViaEmail,
  effectiveAdminRoleNames,
  extractIdpRoles,
} from "./admin.js";
