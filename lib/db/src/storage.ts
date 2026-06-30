// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { AuditEventType } from "./schema/auditEvents.js";

export type { AuditEventType };

export interface AuditEventRow {
  id: string;
  orgId: string;
  eventType: AuditEventType;
  actor: string;
  filePath: string | null;
  entryId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface PolicyRow {
  id: string;
  orgId: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyRuleRow {
  id: string;
  policyId: string;
  pathGlob: string;
  minConfidence: number | null;
  requireContext: boolean;
  allowedAiTools: string[] | null;
  minSeverity: "critical" | "high" | "medium" | "low" | null;
  requireReview: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepoLinkRow {
  id: string;
  orgId: string;
  provider: "github" | "gitlab" | "local";
  repoFullName: string;
  encryptedToken: string;
  installationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SnapshotRow {
  id: string;
  repoLinkId: string;
  capturedAt: Date;
  totalEntries: number;
  mappedEntries: number;
  aiGeneratedPct: number;
  unresolvedCriticalPct: number;
  orphanedPct: number;
  confidenceScore: number;
}

// ── Seats / membership (internal design note) ───────────────────────────────────────────

export type MemberRole = "owner" | "admin" | "member" | "viewer";
export type MemberStatus = "invited" | "active" | "suspended";

export interface MemberRow {
  id: string;
  orgId: string;
  userId: string;
  email: string;
  name: string | null;
  role: MemberRole;
  status: MemberStatus;
}

export interface AddMemberData {
  orgId: string;
  email: string;
  name?: string;
  role?: MemberRole;
  status?: MemberStatus;
}

// ── Repo permissions (internal design note) ──────────────────────────────

export type RepoAccess = "write" | "read" | "none";

export interface RepoPermissionRow {
  id: string;
  orgId: string;
  repoId: string;
  principalId: string;
  access: RepoAccess;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetRepoPermissionData {
  orgId: string;
  repoId: string;
  principalId: string;
  access: RepoAccess;
}

// ── Webhooks (internal design note) ────────────────────────────────────────────────

export interface WebhookRow {
  id: string;
  orgId: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: Date;
}

export interface CreateWebhookData {
  orgId: string;
  url: string;
  events: string[];
}

// ── API tokens (internal design note) ──────────────────────────────────────────────

/** A token row as returned to the UI — never includes the hash or plaintext. */
export interface ApiTokenRow {
  id: string;
  orgId: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface CreateApiTokenData {
  orgId: string;
  name: string;
  prefix: string;
  tokenHash: string;
}

export interface InsertAuditEventData {
  orgId: string;
  eventType: AuditEventType;
  actor: string;
  filePath?: string | null;
  entryId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditQueryFilters {
  actor?: string;
  filePath?: string;
  eventType?: AuditEventType;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export interface AuditExportFilters {
  actor?: string;
  filePath?: string;
  eventType?: AuditEventType;
  from?: Date;
  to?: Date;
}

export interface InsertPolicyRuleData {
  policyId: string;
  pathGlob: string;
  minConfidence?: number | null;
  requireContext: boolean;
  allowedAiTools?: string[] | null;
  minSeverity?: "critical" | "high" | "medium" | "low" | null;
  requireReview?: boolean;
}

export interface UpdatePolicyRuleData {
  pathGlob: string;
  minConfidence?: number | null;
  requireContext: boolean;
  allowedAiTools?: string[] | null;
  minSeverity?: "critical" | "high" | "medium" | "low" | null;
  requireReview?: boolean;
}

export interface InsertRepoLinkData {
  orgId: string;
  provider: "github" | "gitlab" | "local";
  repoFullName: string;
  encryptedToken: string;
  installationId?: string | null;
}

export interface InsertSnapshotData {
  repoLinkId: string;
  capturedAt?: Date;
  totalEntries: number;
  mappedEntries: number;
  aiGeneratedPct: number;
  unresolvedCriticalPct: number;
  orphanedPct: number;
  confidenceScore: number;
}

// ── Fused-graph ingest (parity PR #2) ───────────────────────────────────────
// The SaaS writer path: the CLI reads the repo's local `.kodela/index.db` graph
// and pushes it; the server upserts it into the Postgres mirror org-/repo-scoped.
// `orgId` + `repoId` are supplied by the authenticated route, NOT the payload,
// so a client can never write another tenant's rows. Timestamps are ISO strings
// on the wire (the local store keeps them as TEXT).

export interface IngestDecision {
  id: string;
  title: string;
  category?: string | null;
  status: string;
  visibility?: string | null;
  problem: string;
  decision: string;
  reason: string;
  consequences?: string | null;
  tradeOffs?: string | null;
  outcome?: string | null;
  outcomeEvidence?: string | null;
  authorId: string;
  /** JSON-encoded string arrays, mirroring the local store's TEXT columns. */
  approverIds?: string | null;
  tags?: string | null;
  supersededBy?: string | null;
  supersedes?: string | null;
  lastReviewedAt?: string | null;
  decidedAt: string;
  schemaVersion: string;
}

export interface IngestDecisionOption {
  id: string;
  decisionId: string;
  label: string;
  description?: string | null;
  pros?: string | null;
  cons?: string | null;
  /** 0 | 1, mirroring the local store's integer-boolean. */
  wasChosen: number;
  rejectionReason?: string | null;
  position?: number | null;
}

export interface IngestDecisionLink {
  id: string;
  decisionId: string;
  linkType: string;
  externalId: string;
  displayLabel?: string | null;
}

export interface IngestGraphEdge {
  edgeType: string;
  sourceNodeType: string;
  sourceNodeId: string;
  targetNodeType: string;
  targetNodeId: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  extractedBy?: string;
  capturePath?: string;
  validFrom: string;
  validUntil?: string | null;
  schemaVersion?: string;
}

export interface IngestRepoGraphData {
  decisions?: IngestDecision[];
  decisionOptions?: IngestDecisionOption[];
  decisionLinks?: IngestDecisionLink[];
  edges?: IngestGraphEdge[];
}

export interface IngestRepoGraphResult {
  decisions: number;
  decisionOptions: number;
  decisionLinks: number;
  edgesUpserted: number;
  /** Currently-valid edges closed because they were absent from the push. */
  edgesSuperseded: number;
}

export interface KodelaStorage {
  upsertOrg(orgId: string): Promise<void>;

  insertAuditEvent(data: InsertAuditEventData): Promise<void>;
  queryAuditEvents(orgId: string, filters: AuditQueryFilters): Promise<AuditEventRow[]>;
  exportAuditEvents(orgId: string, filters: AuditExportFilters): Promise<AuditEventRow[]>;

  getOrCreateActivePolicy(orgId: string): Promise<PolicyRow>;
  getPolicyRules(policyId: string): Promise<PolicyRuleRow[]>;
  insertPolicyRule(data: InsertPolicyRuleData): Promise<PolicyRuleRow>;
  updatePolicyRule(
    ruleId: string,
    policyId: string,
    data: UpdatePolicyRuleData,
  ): Promise<PolicyRuleRow | null>;
  deletePolicyRule(ruleId: string, policyId: string): Promise<boolean>;

  getRepoLinks(orgId: string): Promise<RepoLinkRow[]>;
  getRepoLinkById(id: string): Promise<RepoLinkRow | null>;
  getRepoLinkByFullName(repoFullName: string): Promise<RepoLinkRow | null>;
  insertRepoLink(data: InsertRepoLinkData): Promise<RepoLinkRow>;

  getSnapshotsByRepoLink(repoLinkId: string): Promise<SnapshotRow[]>;
  getLatestSnapshotByRepoLinkId(repoLinkId: string): Promise<SnapshotRow | null>;
  getSnapshotsByRepoIds(repoIds: string[]): Promise<SnapshotRow[]>;
  insertSnapshot(data: InsertSnapshotData): Promise<void>;

  /**
   * Parity PR #2 — upsert a repo's fused graph (decisions + options + links +
   * edges) pushed from its local `.kodela/index.db`. Idempotent: decisions/
   * options/links upsert by id, edges upsert by their dedup unique key. Edges
   * currently valid in the store for `(orgId, repoId)` but absent from `data.edges`
   * are closed (`valid_until = now`) — so the store converges to the pushed
   * valid graph. MUST scope every write to `orgId` + `repoId`.
   */
  ingestRepoGraph(
    orgId: string,
    repoId: string,
    data: IngestRepoGraphData,
  ): Promise<IngestRepoGraphResult>;

  insertSignOffRecord(data: InsertSignOffData): Promise<SignOffRecordRow>;
  /**
   * P6.6 (internal design note) — `orgId` is the first argument so the row-filter audit
   * cannot accidentally fall back to an unfiltered query.  The implementation
   * MUST include `WHERE org_id = ?` even if `repoId` already scopes the query.
   */
  querySignOffRecords(
    orgId: string,
    repoId: string,
    filters: SignOffQueryFilters,
  ): Promise<SignOffRecordRow[]>;

  insertComment(data: InsertCommentData): Promise<CommentRow>;
  /** P6.6 (internal design note) — `orgId` added; same fail-closed contract as querySignOffRecords. */
  queryComments(
    orgId: string,
    repoId: string,
    entryId: string,
    includeResolved: boolean,
  ): Promise<CommentRow[]>;
  /** P6.6 (internal design note) — `orgId` added so a cross-org UPDATE is impossible. */
  resolveDbComment(orgId: string, repoId: string, commentId: string): Promise<CommentRow | null>;

  insertPrComment(data: InsertPrCommentData): Promise<PrCommentRow>;
  hasPrComment(repoId: string, provider: string, prNumber: number, entryId: string): Promise<boolean>;
  queryPrComments(repoId: string, provider: string, prNumber: number): Promise<PrCommentRow[]>;

  upsertEntry(data: UpsertEntryData): Promise<void>;
  /** P6.6 (internal design note) — `orgId` required so metrics never aggregate across tenants. */
  getEntryMetrics(orgId: string): Promise<EntryMetrics>;
  getAllEntries(): Promise<any[]>;

  // Seats / membership (internal design note). Seats are counted as ACTIVE memberships
  // per org and enforced against the org's licensed maxSeats.
  countActiveSeats(orgId: string): Promise<number>;
  addMember(data: AddMemberData): Promise<MemberRow>;
  listMembers(orgId: string): Promise<MemberRow[]>;
  setMemberStatus(orgId: string, userId: string, status: MemberStatus): Promise<MemberRow | null>;
  setMemberRole(orgId: string, userId: string, role: MemberRole): Promise<MemberRow | null>;

  // API tokens (internal design note). Storage holds only the hash + prefix.
  createApiToken(data: CreateApiTokenData): Promise<ApiTokenRow>;
  listApiTokens(orgId: string): Promise<ApiTokenRow[]>;
  revokeApiToken(orgId: string, tokenId: string): Promise<ApiTokenRow | null>;

  // Repo permissions (internal design note). Per-repo access scoping.
  listRepoPermissions(orgId: string, repoId: string): Promise<RepoPermissionRow[]>;
  setRepoPermission(data: SetRepoPermissionData): Promise<RepoPermissionRow>;
  deleteRepoPermission(orgId: string, repoId: string, principalId: string): Promise<boolean>;
  getEffectiveAccess(orgId: string, repoId: string, userId: string): Promise<RepoAccess>;

  // Webhooks (internal design note). Outbound HTTP notifications for org events.
  listWebhooks(orgId: string): Promise<WebhookRow[]>;
  createWebhook(data: CreateWebhookData): Promise<WebhookRow>;
  deleteWebhook(orgId: string, webhookId: string): Promise<boolean>;
}

export interface SignOffRecordRow {
  id: string;
  repoId: string;
  entryId: string;
  reviewer: string;
  signedOffAt: Date;
  comment: string | null;
  filePath: string | null;
  createdAt: Date;
}

export interface InsertSignOffData {
  /** P6.5 (internal design note) — multi-tenant isolation. NOT NULL on the SQL row. */
  orgId: string;
  repoId: string;
  entryId: string;
  reviewer: string;
  signedOffAt: Date;
  comment?: string | null;
  filePath?: string | null;
}

export interface SignOffQueryFilters {
  entryId?: string;
  reviewer?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export interface StorageError {
  code: string;
  feature: string;
  value: string;
  upgrade: string;
}

export interface CommentRow {
  id: string;
  orgId: string;
  repoId: string;
  entryId: string;
  author: string;
  body: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface InsertCommentData {
  orgId: string;
  repoId: string;
  entryId: string;
  author: string;
  body: string;
}

export interface PrCommentRow {
  id: string;
  repoId: string;
  provider: string;
  prNumber: number;
  entryId: string;
  commitSha: string;
  providerCommentId: string;
  filePath: string;
  line: number;
  createdAt: Date;
}

export interface InsertPrCommentData {
  repoId: string;
  provider: string;
  prNumber: number;
  entryId: string;
  commitSha: string;
  providerCommentId: string;
  filePath: string;
  line: number;
}

export interface UpsertEntryData {
  id: string;
  /** P6.5 (internal design note) — multi-tenant isolation. NOT NULL on the SQL row. */
  orgId: string;
  /**
   * Server-side repo identifier (FK to `repo_links.id`).  Pre-P6.5 the
   * api-server route stuffed sessionId into the `repo_id` column as a
   * placeholder; post-P6.5 callers should pass the actual repoId from
   * `repo_links` for the customer's repo.  We keep this field separate from
   * sessionId so the placeholder can be cleaned up incrementally.
   */
  repoId: string;
  sessionId: string;
  clusterId: string | null;
  filePath: string;
  schemaVersion: string;
  status: string;
  severity: string;
  source: string;
  confidence: number;
  scope: string | null;
  reviewRequired: boolean;
  note: string;
  author: string;
  payload: string;
}

export interface EntryMetrics {
  totalEntries: number;
  aiGeneratedEntries: number;
  reviewRequired: number;
  bySource: Record<string, number>;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  recentSessions: number;
}
