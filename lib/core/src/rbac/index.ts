// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Role-based access control (RBAC) model — the permission matrix Kodela's
 * commercial governance is built on (internal design note).
 *
 * This is the pure, dependency-free source of truth: roles, the permissions
 * they grant, and the helpers to query them. Enforcement (middleware, UI gates)
 * consumes this; the model itself has no I/O so it's trivially testable and
 * shared by server + dashboard.
 *
 * Roles are a strict hierarchy: owner ⊃ admin ⊃ member ⊃ viewer.
 */

export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Higher rank = more authority. Used for `roleAtLeast` gates. */
export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

export const PERMISSIONS = [
  // membership
  "members:read", "members:invite", "members:remove", "members:role",
  // repositories
  "repos:read", "repos:connect", "repos:disconnect",
  // api tokens
  "tokens:read", "tokens:create", "tokens:revoke",
  // governance
  "policy:read", "policy:write",
  "decisions:read", "decisions:write",
  "audit:read", "audit:export",
  // billing / org settings
  "billing:read", "billing:write",
  "settings:read", "settings:write",
  // knowledge
  "context:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * The matrix. `"*"` = all permissions (owner). Each other role lists exactly
 * what it can do; everything unlisted is denied. Designed so each tier is a
 * superset of the one below it.
 */
const VIEWER: Permission[] = [
  "members:read", "repos:read", "tokens:read", "policy:read",
  "decisions:read", "audit:read", "settings:read", "billing:read", "context:read",
];
const MEMBER: Permission[] = [
  ...VIEWER,
  "decisions:write", "repos:connect", "tokens:create",
];
const ADMIN: Permission[] = [
  ...MEMBER,
  "members:invite", "members:remove", "members:role",
  "repos:disconnect", "tokens:revoke",
  "policy:write", "audit:export", "settings:write",
];

const MATRIX: Record<Role, Permission[] | "*"> = {
  owner: "*",
  admin: ADMIN,
  member: MEMBER,
  viewer: VIEWER,
};

/** Is `value` a valid role? */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Does `role` grant `perm`? */
export function can(role: Role, perm: Permission): boolean {
  const grants = MATRIX[role];
  return grants === "*" || grants.includes(perm);
}

/** All permissions a role holds (expanded; owner returns the full set). */
export function permissionsFor(role: Role): Permission[] {
  const grants = MATRIX[role];
  return grants === "*" ? [...PERMISSIONS] : [...grants];
}

/** Is `role` at least as powerful as `min` in the hierarchy? */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
