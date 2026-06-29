// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// node:sqlite is only available in Node 24+. Loaded lazily (via a real require
// built from import.meta.url) so this ESM module can be imported on Node 20
// without crashing at startup, and so it works under both the bundler build and
// the tsx ESM test runner (a bare `require` is undefined in ESM).
const nodeRequire = createRequire(import.meta.url);
type DatabaseSync = import("node:sqlite").DatabaseSync;
import type {
  KodelaStorage,
  AuditEventRow,
  AuditQueryFilters,
  AuditExportFilters,
  InsertAuditEventData,
  PolicyRow,
  PolicyRuleRow,
  InsertPolicyRuleData,
  UpdatePolicyRuleData,
  RepoLinkRow,
  InsertRepoLinkData,
  SnapshotRow,
  InsertSnapshotData,
  SignOffRecordRow,
  InsertSignOffData,
  SignOffQueryFilters,
  CommentRow,
  InsertCommentData,
  PrCommentRow,
  InsertPrCommentData,
  UpsertEntryData,
  EntryMetrics,
  AddMemberData,
  MemberRow,
  MemberStatus,
  MemberRole,
  ApiTokenRow,
  CreateApiTokenData,
  WebhookRow,
  CreateWebhookData,
  RepoPermissionRow,
  RepoAccess,
  SetRepoPermissionData,
} from "../storage.js";
import type { AuditEventType } from "../schema/auditEvents.js";

function ensureGitignore(dir: string): void {
  const gitignorePath = join(dir, ".gitignore");
  const entry = "server.db\n";
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf8");
    if (!content.includes("server.db")) {
      writeFileSync(gitignorePath, content + entry, "utf8");
    }
  } else {
    writeFileSync(gitignorePath, entry, "utf8");
  }
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  return new Date(v as string);
}

function toBool(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}

function parseJson<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

type RawAuditEvent = {
  id: string;
  orgId: string;
  eventType: string;
  actor: string;
  filePath: string | null;
  entryId: string | null;
  metadata: string | null;
  createdAt: string;
};

type RawPolicy = {
  id: string;
  orgId: string;
  name: string;
  isActive: number;
  createdAt: string;
  updatedAt: string;
};

type RawPolicyRule = {
  id: string;
  policyId: string;
  pathGlob: string;
  minConfidence: number | null;
  requireContext: number;
  allowedAiTools: string | null;
  minSeverity: string | null;
  requireReview: number;
  createdAt: string;
  updatedAt: string;
};

type RawRepoLink = {
  id: string;
  orgId: string;
  provider: string;
  repoFullName: string;
  encryptedToken: string;
  installationId: string | null;
  createdAt: string;
  updatedAt: string;
};

type RawSnapshot = {
  id: string;
  repoLinkId: string;
  capturedAt: string;
  totalEntries: number;
  mappedEntries: number;
  aiGeneratedPct: number;
  unresolvedCriticalPct: number;
  orphanedPct: number;
  confidenceScore: number;
};

function mapAuditEvent(r: RawAuditEvent): AuditEventRow {
  return {
    id: r.id,
    orgId: r.orgId,
    eventType: r.eventType as AuditEventType,
    actor: r.actor,
    filePath: r.filePath ?? null,
    entryId: r.entryId ?? null,
    metadata: parseJson<Record<string, unknown>>(r.metadata),
    createdAt: toDate(r.createdAt),
  };
}

function mapPolicy(r: RawPolicy): PolicyRow {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    isActive: toBool(r.isActive),
    createdAt: toDate(r.createdAt),
    updatedAt: toDate(r.updatedAt),
  };
}

function mapPolicyRule(r: RawPolicyRule): PolicyRuleRow {
  return {
    id: r.id,
    policyId: r.policyId,
    pathGlob: r.pathGlob,
    minConfidence: r.minConfidence ?? null,
    requireContext: toBool(r.requireContext),
    allowedAiTools: parseJson<string[]>(r.allowedAiTools),
    minSeverity: (r.minSeverity as PolicyRuleRow["minSeverity"]) ?? null,
    requireReview: toBool(r.requireReview),
    createdAt: toDate(r.createdAt),
    updatedAt: toDate(r.updatedAt),
  };
}

function mapRepoLink(r: RawRepoLink): RepoLinkRow {
  return {
    id: r.id,
    orgId: r.orgId,
    provider: r.provider as RepoLinkRow["provider"],
    repoFullName: r.repoFullName,
    encryptedToken: r.encryptedToken,
    installationId: r.installationId ?? null,
    createdAt: toDate(r.createdAt),
    updatedAt: toDate(r.updatedAt),
  };
}

function mapApiToken(r: Record<string, string | null>): ApiTokenRow {
  return {
    id: r["id"] as string,
    orgId: r["orgId"] as string,
    name: r["name"] as string,
    prefix: r["prefix"] as string,
    createdAt: new Date(r["createdAt"] as string),
    lastUsedAt: r["lastUsedAt"] ? new Date(r["lastUsedAt"]) : null,
    revokedAt: r["revokedAt"] ? new Date(r["revokedAt"]) : null,
  };
}

function mapSnapshot(r: RawSnapshot): SnapshotRow {
  return {
    id: r.id,
    repoLinkId: r.repoLinkId,
    capturedAt: toDate(r.capturedAt),
    totalEntries: r.totalEntries,
    mappedEntries: r.mappedEntries,
    aiGeneratedPct: r.aiGeneratedPct,
    unresolvedCriticalPct: r.unresolvedCriticalPct,
    orphanedPct: r.orphanedPct,
    confidenceScore: r.confidenceScore,
  };
}

export class SqliteStorage implements KodelaStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? join(process.cwd(), ".kodela", "server.db");
    const dir = join(resolvedPath, "..");

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    ensureGitignore(dir);

    const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initSchema();
    this.applyMigrations();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        name TEXT,
        license_key TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS memberships (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (org_id, user_id),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS ix_memberships_org_status ON memberships(org_id, status);

      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS ix_api_tokens_org ON api_tokens(org_id);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        file_path TEXT,
        entry_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'default',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS policy_rules (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        path_glob TEXT NOT NULL,
        min_confidence REAL,
        require_context INTEGER NOT NULL DEFAULT 0,
        allowed_ai_tools TEXT,
        min_severity TEXT,
        require_review INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS repo_links (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        encrypted_token TEXT NOT NULL,
        installation_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        repo_link_id TEXT NOT NULL,
        captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        total_entries INTEGER NOT NULL DEFAULT 0,
        mapped_entries INTEGER NOT NULL DEFAULT 0,
        ai_generated_pct REAL NOT NULL DEFAULT 0,
        unresolved_critical_pct REAL NOT NULL DEFAULT 0,
        orphaned_pct REAL NOT NULL DEFAULT 0,
        confidence_score REAL NOT NULL DEFAULT 0,
        FOREIGN KEY (repo_link_id) REFERENCES repo_links(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sign_off_records (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'local',
        repo_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        signed_off_at TEXT NOT NULL,
        comment TEXT,
        file_path TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sign_off_records_org_id ON sign_off_records(org_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_comments (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        entry_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        provider_comment_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        resolved_at TEXT
      );
    `);

    try {
      this.db.exec(
        `ALTER TABLE policy_rules ADD COLUMN require_review INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      // Column already exists — ignore
    }

    // P6.6b — entries/intent_clusters carry org_id for multi-tenant parity
    // with the Drizzle/Postgres schema.  DEFAULT 'local' makes the schema
    // upgrade backward-compatible for single-tenant dev databases — existing
    // rows that lacked org_id become org_id='local' after the ALTER TABLE in
    // applyMigrations() below.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_permissions (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        access TEXT NOT NULL DEFAULT 'write',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,
        UNIQUE (org_id, repo_id, principal_id)
      );

      CREATE INDEX IF NOT EXISTS ix_repo_permissions_org_repo ON repo_permissions(org_id, repo_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        url TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS ix_webhooks_org ON webhooks(org_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id               TEXT PRIMARY KEY,
        org_id           TEXT NOT NULL DEFAULT 'local',
        repo_id          TEXT,
        session_id       TEXT NOT NULL,
        cluster_id       TEXT,
        file_path        TEXT NOT NULL,
        schema_version   TEXT NOT NULL,
        status           TEXT NOT NULL,
        severity         TEXT NOT NULL,
        source           TEXT NOT NULL,
        confidence       REAL NOT NULL,
        scope            TEXT,
        review_required  INTEGER NOT NULL DEFAULT 0,
        note             TEXT NOT NULL,
        author           TEXT NOT NULL,
        payload          TEXT NOT NULL,
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        synced_at        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_entries_org_id   ON entries(org_id);
      CREATE INDEX IF NOT EXISTS idx_entries_session  ON entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_entries_cluster  ON entries(cluster_id);
      CREATE INDEX IF NOT EXISTS idx_entries_file     ON entries(file_path);

      CREATE TABLE IF NOT EXISTS intent_clusters (
        id               TEXT PRIMARY KEY,
        org_id           TEXT NOT NULL DEFAULT 'local',
        repo_id          TEXT,
        session_id       TEXT NOT NULL,
        cluster_index    INTEGER NOT NULL,
        started_at       TEXT NOT NULL,
        ended_at         TEXT,
        trigger_type     TEXT NOT NULL,
        goal             TEXT,
        scope            TEXT,
        event_count      INTEGER NOT NULL DEFAULT 0,
        entry_count      INTEGER NOT NULL DEFAULT 0,
        aggregated_risk  TEXT,
        files_changed    TEXT NOT NULL DEFAULT '[]',
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_intent_clusters_org_id  ON intent_clusters(org_id);
      CREATE INDEX IF NOT EXISTS idx_intent_clusters_session ON intent_clusters(session_id);
    `);
  }

  /** Idempotent post-schema migrations for constraints added after initial release. */
  private applyMigrations(): void {
    // Prevent duplicate local repo links — safe on existing tables with no dupes.
    try {
      this.db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_repo_links_org_provider_name
         ON repo_links(org_id, provider, repo_full_name)`,
      );
    } catch {
      // Migration already applied or failed on an incompatible state; continue.
    }

    // P6.6b — backfill org_id / repo_id columns on tables that pre-date
    // multi-tenant parity.  Each ALTER TABLE is wrapped in try/catch because
    // SQLite throws "duplicate column" if the column already exists, and
    // there's no IF NOT EXISTS for ALTER TABLE ADD COLUMN.
    const alterTables: Array<[string, string]> = [
      ["entries", "org_id TEXT NOT NULL DEFAULT 'local'"],
      ["entries", "repo_id TEXT"],
      ["sign_off_records", "org_id TEXT NOT NULL DEFAULT 'local'"],
      ["intent_clusters", "org_id TEXT NOT NULL DEFAULT 'local'"],
      ["intent_clusters", "repo_id TEXT"],
    ];
    for (const [table, column] of alterTables) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
      } catch {
        // Column already exists — expected on a fresh CREATE TABLE which
        // already has the column.  Continue.
      }
    }

    // Indexes for the new columns — idempotent.
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_entries_org_id           ON entries(org_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sign_off_records_org_id  ON sign_off_records(org_id)`,
      `CREATE INDEX IF NOT EXISTS idx_intent_clusters_org_id   ON intent_clusters(org_id)`,
    ];
    for (const sql of indexes) {
      try {
        this.db.exec(sql);
      } catch {
        // ignore
      }
    }
  }

  upsertOrg(orgId: string): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO orgs (id) VALUES (?)")
      .run(orgId);
    return Promise.resolve();
  }

  insertAuditEvent(data: InsertAuditEventData): Promise<void> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO audit_events (id, org_id, event_type, actor, file_path, entry_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.orgId,
        data.eventType,
        data.actor,
        data.filePath ?? null,
        data.entryId ?? null,
        data.metadata != null ? JSON.stringify(data.metadata) : null,
      );
    return Promise.resolve();
  }

  queryAuditEvents(orgId: string, filters: AuditQueryFilters): Promise<AuditEventRow[]> {
    const { actor, filePath, eventType, from, to, page, pageSize } = filters;
    const conditions: string[] = ["org_id = ?"];
    const params: (string | number | null)[] = [orgId];

    if (actor) { conditions.push("actor = ?"); params.push(actor); }
    if (filePath) { conditions.push("file_path = ?"); params.push(filePath); }
    if (eventType) { conditions.push("event_type = ?"); params.push(eventType); }
    if (from) { conditions.push("created_at >= ?"); params.push(from.toISOString()); }
    if (to) { conditions.push("created_at <= ?"); params.push(to.toISOString()); }

    const sql = `
      SELECT id,
             org_id      AS "orgId",
             event_type  AS "eventType",
             actor,
             file_path   AS "filePath",
             entry_id    AS "entryId",
             metadata,
             created_at  AS "createdAt"
      FROM   audit_events
      WHERE  ${conditions.join(" AND ")}
      ORDER  BY created_at DESC
      LIMIT  ? OFFSET ?
    `;
    params.push(pageSize, (page - 1) * pageSize);

    const rows = this.db.prepare(sql).all(...params) as RawAuditEvent[];
    return Promise.resolve(rows.map(mapAuditEvent));
  }

  exportAuditEvents(orgId: string, filters: AuditExportFilters): Promise<AuditEventRow[]> {
    const { actor, filePath, eventType, from, to } = filters;
    const conditions: string[] = ["org_id = ?"];
    const params: (string | number | null)[] = [orgId];

    if (actor) { conditions.push("actor = ?"); params.push(actor); }
    if (filePath) { conditions.push("file_path = ?"); params.push(filePath); }
    if (eventType) { conditions.push("event_type = ?"); params.push(eventType); }
    if (from) { conditions.push("created_at >= ?"); params.push(from.toISOString()); }
    if (to) { conditions.push("created_at <= ?"); params.push(to.toISOString()); }

    const sql = `
      SELECT id,
             org_id      AS "orgId",
             event_type  AS "eventType",
             actor,
             file_path   AS "filePath",
             entry_id    AS "entryId",
             metadata,
             created_at  AS "createdAt"
      FROM   audit_events
      WHERE  ${conditions.join(" AND ")}
      ORDER  BY created_at DESC
      LIMIT  10000
    `;

    const rows = this.db.prepare(sql).all(...params) as RawAuditEvent[];
    return Promise.resolve(rows.map(mapAuditEvent));
  }

  getOrCreateActivePolicy(orgId: string): Promise<PolicyRow> {
    this.db
      .prepare("INSERT OR IGNORE INTO orgs (id) VALUES (?)")
      .run(orgId);

    const existing = this.db
      .prepare(
        `SELECT id,
                org_id     AS "orgId",
                name,
                is_active  AS "isActive",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
         FROM   policies
         WHERE  org_id = ? AND is_active = 1
         LIMIT  1`,
      )
      .get(orgId) as RawPolicy | undefined;

    if (existing) return Promise.resolve(mapPolicy(existing));

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO policies (id, org_id, name, is_active) VALUES (?, ?, 'default', 1)`,
      )
      .run(id, orgId);

    const created = this.db
      .prepare(
        `SELECT id,
                org_id     AS "orgId",
                name,
                is_active  AS "isActive",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
         FROM   policies
         WHERE  id = ?`,
      )
      .get(id) as RawPolicy;

    return Promise.resolve(mapPolicy(created));
  }

  getPolicyRules(policyId: string): Promise<PolicyRuleRow[]> {
    const rows = this.db
      .prepare(
        `SELECT id,
                policy_id        AS "policyId",
                path_glob        AS "pathGlob",
                min_confidence   AS "minConfidence",
                require_context  AS "requireContext",
                allowed_ai_tools AS "allowedAiTools",
                min_severity     AS "minSeverity",
                require_review   AS "requireReview",
                created_at       AS "createdAt",
                updated_at       AS "updatedAt"
         FROM   policy_rules
         WHERE  policy_id = ?`,
      )
      .all(policyId) as RawPolicyRule[];

    return Promise.resolve(rows.map(mapPolicyRule));
  }

  insertPolicyRule(data: InsertPolicyRuleData): Promise<PolicyRuleRow> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO policy_rules
           (id, policy_id, path_glob, min_confidence, require_context, allowed_ai_tools, min_severity, require_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.policyId,
        data.pathGlob,
        data.minConfidence ?? null,
        data.requireContext ? 1 : 0,
        data.allowedAiTools != null ? JSON.stringify(data.allowedAiTools) : null,
        data.minSeverity ?? null,
        data.requireReview ? 1 : 0,
      );

    const row = this.db
      .prepare(
        `SELECT id,
                policy_id        AS "policyId",
                path_glob        AS "pathGlob",
                min_confidence   AS "minConfidence",
                require_context  AS "requireContext",
                allowed_ai_tools AS "allowedAiTools",
                min_severity     AS "minSeverity",
                require_review   AS "requireReview",
                created_at       AS "createdAt",
                updated_at       AS "updatedAt"
         FROM   policy_rules
         WHERE  id = ?`,
      )
      .get(id) as RawPolicyRule;

    return Promise.resolve(mapPolicyRule(row));
  }

  updatePolicyRule(
    ruleId: string,
    policyId: string,
    data: UpdatePolicyRuleData,
  ): Promise<PolicyRuleRow | null> {
    const existing = this.db
      .prepare(
        `SELECT id FROM policy_rules WHERE id = ? AND policy_id = ?`,
      )
      .get(ruleId, policyId);

    if (!existing) return Promise.resolve(null);

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE policy_rules
         SET    path_glob        = ?,
                min_confidence   = ?,
                require_context  = ?,
                allowed_ai_tools = ?,
                min_severity     = ?,
                require_review   = ?,
                updated_at       = ?
         WHERE  id = ?`,
      )
      .run(
        data.pathGlob,
        data.minConfidence ?? null,
        data.requireContext ? 1 : 0,
        data.allowedAiTools != null ? JSON.stringify(data.allowedAiTools) : null,
        data.minSeverity ?? null,
        data.requireReview ? 1 : 0,
        now,
        ruleId,
      );

    const updated = this.db
      .prepare(
        `SELECT id,
                policy_id        AS "policyId",
                path_glob        AS "pathGlob",
                min_confidence   AS "minConfidence",
                require_context  AS "requireContext",
                allowed_ai_tools AS "allowedAiTools",
                min_severity     AS "minSeverity",
                require_review   AS "requireReview",
                created_at       AS "createdAt",
                updated_at       AS "updatedAt"
         FROM   policy_rules
         WHERE  id = ?`,
      )
      .get(ruleId) as RawPolicyRule;

    return Promise.resolve(mapPolicyRule(updated));
  }

  deletePolicyRule(ruleId: string, policyId: string): Promise<boolean> {
    const existing = this.db
      .prepare(`SELECT id FROM policy_rules WHERE id = ? AND policy_id = ?`)
      .get(ruleId, policyId);

    if (!existing) return Promise.resolve(false);

    this.db
      .prepare(`DELETE FROM policy_rules WHERE id = ?`)
      .run(ruleId);

    return Promise.resolve(true);
  }

  getRepoLinks(orgId: string): Promise<RepoLinkRow[]> {
    const rows = this.db
      .prepare(
        `SELECT id,
                org_id           AS "orgId",
                provider,
                repo_full_name   AS "repoFullName",
                encrypted_token  AS "encryptedToken",
                installation_id  AS "installationId",
                created_at       AS "createdAt",
                updated_at       AS "updatedAt"
         FROM   repo_links
         WHERE  org_id = ?`,
      )
      .all(orgId) as RawRepoLink[];

    return Promise.resolve(rows.map(mapRepoLink));
  }

  getRepoLinkById(id: string): Promise<RepoLinkRow | null> {
    const row = this.db
      .prepare(
        `SELECT id,
                org_id           AS "orgId",
                provider,
                repo_full_name   AS "repoFullName",
                encrypted_token  AS "encryptedToken",
                installation_id  AS "installationId",
                created_at       AS "createdAt",
                updated_at       AS "updatedAt"
         FROM   repo_links
         WHERE  id = ?
         LIMIT  1`,
      )
      .get(id) as RawRepoLink | undefined;

    return Promise.resolve(row ? mapRepoLink(row) : null);
  }

  getRepoLinkByFullName(repoFullName: string): Promise<RepoLinkRow | null> {
    const row = this.db
      .prepare(
        `SELECT id,
                org_id           AS "orgId",
                provider,
                repo_full_name   AS "repoFullName",
                encrypted_token  AS "encryptedToken",
                installation_id  AS "installationId",
                created_at       AS "createdAt",
                updated_at       AS "updatedAt"
         FROM   repo_links
         WHERE  repo_full_name = ?
         LIMIT  1`,
      )
      .get(repoFullName) as RawRepoLink | undefined;

    return Promise.resolve(row ? mapRepoLink(row) : null);
  }

  insertRepoLink(data: InsertRepoLinkData): Promise<RepoLinkRow> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO repo_links
           (id, org_id, provider, repo_full_name, encrypted_token, installation_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.orgId,
        data.provider,
        data.repoFullName,
        data.encryptedToken,
        data.installationId ?? null,
      );

    const row = this.db
      .prepare(
        `SELECT id,
                org_id           AS "orgId",
                provider,
                repo_full_name   AS "repoFullName",
                encrypted_token  AS "encryptedToken",
                installation_id  AS "installationId",
                created_at       AS "createdAt",
                updated_at       AS "updatedAt"
         FROM   repo_links
         WHERE  id = ?`,
      )
      .get(id) as RawRepoLink;

    return Promise.resolve(mapRepoLink(row));
  }

  getSnapshotsByRepoLink(repoLinkId: string): Promise<SnapshotRow[]> {
    const rows = this.db
      .prepare(
        `SELECT id,
                repo_link_id           AS "repoLinkId",
                captured_at            AS "capturedAt",
                total_entries          AS "totalEntries",
                mapped_entries         AS "mappedEntries",
                ai_generated_pct       AS "aiGeneratedPct",
                unresolved_critical_pct AS "unresolvedCriticalPct",
                orphaned_pct           AS "orphanedPct",
                confidence_score       AS "confidenceScore"
         FROM   snapshots
         WHERE  repo_link_id = ?
         ORDER  BY captured_at ASC`,
      )
      .all(repoLinkId) as RawSnapshot[];

    return Promise.resolve(rows.map(mapSnapshot));
  }

  getLatestSnapshotByRepoLinkId(repoLinkId: string): Promise<SnapshotRow | null> {
    const row = this.db
      .prepare(
        `SELECT id,
                repo_link_id           AS "repoLinkId",
                captured_at            AS "capturedAt",
                total_entries          AS "totalEntries",
                mapped_entries         AS "mappedEntries",
                ai_generated_pct       AS "aiGeneratedPct",
                unresolved_critical_pct AS "unresolvedCriticalPct",
                orphaned_pct           AS "orphanedPct",
                confidence_score       AS "confidenceScore"
         FROM   snapshots
         WHERE  repo_link_id = ?
         ORDER  BY captured_at DESC
         LIMIT  1`,
      )
      .get(repoLinkId) as RawSnapshot | undefined;

    return Promise.resolve(row ? mapSnapshot(row) : null);
  }

  getSnapshotsByRepoIds(repoIds: string[]): Promise<SnapshotRow[]> {
    if (repoIds.length === 0) return Promise.resolve([]);

    const placeholders = repoIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id,
                repo_link_id           AS "repoLinkId",
                captured_at            AS "capturedAt",
                total_entries          AS "totalEntries",
                mapped_entries         AS "mappedEntries",
                ai_generated_pct       AS "aiGeneratedPct",
                unresolved_critical_pct AS "unresolvedCriticalPct",
                orphaned_pct           AS "orphanedPct",
                confidence_score       AS "confidenceScore"
         FROM   snapshots
         WHERE  repo_link_id IN (${placeholders})
         ORDER  BY captured_at ASC`,
      )
      .all(...repoIds) as RawSnapshot[];

    return Promise.resolve(rows.map(mapSnapshot));
  }

  insertSnapshot(data: InsertSnapshotData): Promise<void> {
    const id = randomUUID();
    const capturedAt = (data.capturedAt ?? new Date()).toISOString();
    this.db
      .prepare(
        `INSERT INTO snapshots
           (id, repo_link_id, captured_at, total_entries, mapped_entries,
            ai_generated_pct, unresolved_critical_pct, orphaned_pct, confidence_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.repoLinkId,
        capturedAt,
        data.totalEntries,
        data.mappedEntries,
        data.aiGeneratedPct,
        data.unresolvedCriticalPct,
        data.orphanedPct,
        data.confidenceScore,
      );
    return Promise.resolve();
  }

  insertSignOffRecord(data: InsertSignOffData): Promise<SignOffRecordRow> {
    const id = randomUUID();
    const signedOffAt = data.signedOffAt.toISOString();
    const createdAt = new Date().toISOString();
    // P6.6b — persist org_id so the postgres adapter's row-filter contract is
    // mirrored at runtime in dev too.
    this.db
      .prepare(
        `INSERT INTO sign_off_records
           (id, org_id, repo_id, entry_id, reviewer, signed_off_at, comment, file_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.orgId,
        data.repoId,
        data.entryId,
        data.reviewer,
        signedOffAt,
        data.comment ?? null,
        data.filePath ?? null,
        createdAt,
      );
    return Promise.resolve({
      id,
      repoId: data.repoId,
      entryId: data.entryId,
      reviewer: data.reviewer,
      signedOffAt: data.signedOffAt,
      comment: data.comment ?? null,
      filePath: data.filePath ?? null,
      createdAt: new Date(createdAt),
    });
  }

  querySignOffRecords(
    orgId: string,
    repoId: string,
    filters: SignOffQueryFilters,
  ): Promise<SignOffRecordRow[]> {
    // P6.6 + P6.6b — orgId filter now enforced on SQLite too (org_id column
    // added by P6.6b schema parity migration).
    const conditions: string[] = ["org_id = ?", "repo_id = ?"];
    const params: (string | number | null)[] = [orgId, repoId];

    if (filters.entryId) {
      conditions.push("entry_id = ?");
      params.push(filters.entryId);
    }
    if (filters.reviewer) {
      conditions.push("reviewer = ?");
      params.push(filters.reviewer);
    }
    if (filters.from) {
      conditions.push("signed_off_at >= ?");
      params.push(filters.from.toISOString());
    }
    if (filters.to) {
      conditions.push("signed_off_at <= ?");
      params.push(filters.to.toISOString());
    }

    const offset = (filters.page - 1) * filters.pageSize;
    const where = conditions.join(" AND ");
    const sql =
      `SELECT id, repo_id, entry_id, reviewer, signed_off_at, comment, file_path, created_at ` +
      `FROM sign_off_records WHERE ${where} ORDER BY signed_off_at DESC LIMIT ? OFFSET ?`;
    params.push(filters.pageSize, offset);

    type RawSignOff = {
      id: string;
      repo_id: string;
      entry_id: string;
      reviewer: string;
      signed_off_at: string;
      comment: string | null;
      file_path: string | null;
      created_at: string;
    };

    const rows = this.db.prepare(sql).all(...params) as RawSignOff[];
    return Promise.resolve(
      rows.map((r) => ({
        id: r.id,
        repoId: r.repo_id,
        entryId: r.entry_id,
        reviewer: r.reviewer,
        signedOffAt: toDate(r.signed_off_at),
        comment: r.comment ?? null,
        filePath: r.file_path ?? null,
        createdAt: toDate(r.created_at),
      })),
    );
  }

  insertComment(data: InsertCommentData): Promise<CommentRow> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO comments (id, org_id, repo_id, entry_id, author, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, data.orgId, data.repoId, data.entryId, data.author, data.body, createdAt);
    return Promise.resolve({
      id,
      orgId: data.orgId,
      repoId: data.repoId,
      entryId: data.entryId,
      author: data.author,
      body: data.body,
      createdAt: new Date(createdAt),
      resolvedAt: null,
    });
  }

  queryComments(
    orgId: string,
    repoId: string,
    entryId: string,
    includeResolved: boolean,
  ): Promise<CommentRow[]> {
    type RawComment = {
      id: string;
      org_id: string;
      repo_id: string;
      entry_id: string;
      author: string;
      body: string;
      created_at: string;
      resolved_at: string | null;
    };

    // P6.6 (internal design note) — comments.org_id is on the SQLite schema (line 314)
    // so this filter is enforceable identically to Postgres.
    let sql =
      `SELECT id, org_id, repo_id, entry_id, author, body, created_at, resolved_at ` +
      `FROM comments WHERE org_id = ? AND repo_id = ? AND entry_id = ?`;
    const params: (string | number | null)[] = [orgId, repoId, entryId];

    if (!includeResolved) {
      sql += ` AND resolved_at IS NULL`;
    }
    sql += ` ORDER BY created_at ASC`;

    const rows = this.db.prepare(sql).all(...params) as RawComment[];
    return Promise.resolve(
      rows.map((r) => ({
        id: r.id,
        orgId: r.org_id,
        repoId: r.repo_id,
        entryId: r.entry_id,
        author: r.author,
        body: r.body,
        createdAt: toDate(r.created_at),
        resolvedAt: r.resolved_at ? toDate(r.resolved_at) : null,
      })),
    );
  }

  resolveDbComment(
    orgId: string,
    repoId: string,
    commentId: string,
  ): Promise<CommentRow | null> {
    // P6.6 (internal design note) — org_id is part of the UPDATE filter on both Postgres
    // and SQLite (the column exists in both schemas).  Without it a cross-org
    // resolve would silently mutate the wrong row.
    const resolvedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE comments SET resolved_at = ? WHERE id = ? AND org_id = ? AND repo_id = ? AND resolved_at IS NULL`,
      )
      .run(resolvedAt, commentId, orgId, repoId);

    if ((result as { changes: number }).changes === 0) return Promise.resolve(null);

    type RawComment = {
      id: string;
      org_id: string;
      repo_id: string;
      entry_id: string;
      author: string;
      body: string;
      created_at: string;
      resolved_at: string | null;
    };

    const row = this.db
      .prepare(
        `SELECT id, org_id, repo_id, entry_id, author, body, created_at, resolved_at FROM comments WHERE id = ?`,
      )
      .get(commentId) as RawComment | undefined;

    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      id: row.id,
      orgId: row.org_id,
      repoId: row.repo_id,
      entryId: row.entry_id,
      author: row.author,
      body: row.body,
      createdAt: toDate(row.created_at),
      resolvedAt: row.resolved_at ? toDate(row.resolved_at) : null,
    });
  }

  insertPrComment(data: InsertPrCommentData): Promise<PrCommentRow> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pr_comments
           (id, repo_id, provider, pr_number, entry_id, commit_sha,
            provider_comment_id, file_path, line, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.repoId,
        data.provider,
        data.prNumber,
        data.entryId,
        data.commitSha,
        data.providerCommentId,
        data.filePath,
        data.line,
        createdAt,
      );
    return Promise.resolve({
      id,
      repoId: data.repoId,
      provider: data.provider,
      prNumber: data.prNumber,
      entryId: data.entryId,
      commitSha: data.commitSha,
      providerCommentId: data.providerCommentId,
      filePath: data.filePath,
      line: data.line,
      createdAt: new Date(createdAt),
    });
  }

  hasPrComment(
    repoId: string,
    provider: string,
    prNumber: number,
    entryId: string,
  ): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT 1 FROM pr_comments WHERE repo_id = ? AND provider = ? AND pr_number = ? AND entry_id = ? LIMIT 1`,
      )
      .get(repoId, provider, prNumber, entryId);
    return Promise.resolve(row !== undefined);
  }

  queryPrComments(
    repoId: string,
    provider: string,
    prNumber: number,
  ): Promise<PrCommentRow[]> {
    type RawPrComment = {
      id: string;
      repo_id: string;
      provider: string;
      pr_number: number;
      entry_id: string;
      commit_sha: string;
      provider_comment_id: string;
      file_path: string;
      line: number;
      created_at: string;
    };
    const rows = this.db
      .prepare(
        `SELECT id, repo_id, provider, pr_number, entry_id, commit_sha,
                provider_comment_id, file_path, line, created_at
         FROM pr_comments WHERE repo_id = ? AND provider = ? AND pr_number = ?
         ORDER BY created_at ASC`,
      )
      .all(repoId, provider, prNumber) as RawPrComment[];
    return Promise.resolve(
      rows.map((r) => ({
        id: r.id,
        repoId: r.repo_id,
        provider: r.provider,
        prNumber: r.pr_number,
        entryId: r.entry_id,
        commitSha: r.commit_sha,
        providerCommentId: r.provider_comment_id,
        filePath: r.file_path,
        line: r.line,
        createdAt: toDate(r.created_at),
      })),
    );
  }

  upsertEntry(data: UpsertEntryData): Promise<void> {
    // P6.6b — persist org_id + repo_id to match Postgres schema.
    this.db.prepare(`
      INSERT INTO entries (
        id, org_id, repo_id, session_id, cluster_id, file_path, schema_version,
        status, severity, source, confidence, scope,
        review_required, note, author, payload, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(id) DO UPDATE SET
        session_id     = excluded.session_id,
        cluster_id     = excluded.cluster_id,
        file_path      = excluded.file_path,
        schema_version = excluded.schema_version,
        status         = excluded.status,
        severity       = excluded.severity,
        source         = excluded.source,
        confidence     = excluded.confidence,
        scope          = excluded.scope,
        review_required = excluded.review_required,
        note           = excluded.note,
        author         = excluded.author,
        payload        = excluded.payload,
        updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(
      data.id,
      data.orgId,
      data.repoId,
      data.sessionId,
      data.clusterId ?? null,
      data.filePath,
      data.schemaVersion,
      data.status,
      data.severity,
      data.source,
      data.confidence,
      data.scope ?? null,
      data.reviewRequired ? 1 : 0,
      data.note,
      data.author,
      data.payload,
    );
    return Promise.resolve();
  }

  getEntryMetrics(orgId: string): Promise<EntryMetrics> {
    // P6.6 + P6.6b — every aggregate filters by org_id now (column added in
    // SQLite schema parity migration).
    const totalRow = this.db.prepare("SELECT COUNT(*) as c FROM entries WHERE org_id = ?").get(orgId) as { c: number };
    const aiRow = this.db.prepare("SELECT COUNT(*) as c FROM entries WHERE org_id = ? AND source = 'ai'").get(orgId) as { c: number };
    const reviewRow = this.db.prepare("SELECT COUNT(*) as c FROM entries WHERE org_id = ? AND review_required = 1").get(orgId) as { c: number };

    const bySourceRows = this.db.prepare(
      "SELECT source, COUNT(*) as c FROM entries WHERE org_id = ? GROUP BY source",
    ).all(orgId) as { source: string; c: number }[];

    const bySeverityRows = this.db.prepare(
      "SELECT severity, COUNT(*) as c FROM entries WHERE org_id = ? GROUP BY severity",
    ).all(orgId) as { severity: string; c: number }[];

    const byStatusRows = this.db.prepare(
      "SELECT status, COUNT(*) as c FROM entries WHERE org_id = ? GROUP BY status",
    ).all(orgId) as { status: string; c: number }[];

    const recentSessionsRow = this.db.prepare(`
      SELECT COUNT(DISTINCT session_id) as c FROM entries
      WHERE org_id = ? AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', '-7 days'))
    `).get(orgId) as { c: number };

    return Promise.resolve({
      totalEntries: totalRow.c,
      aiGeneratedEntries: aiRow.c,
      reviewRequired: reviewRow.c,
      bySource: Object.fromEntries(bySourceRows.map((r) => [r.source, r.c])),
      bySeverity: Object.fromEntries(bySeverityRows.map((r) => [r.severity, r.c])),
      byStatus: Object.fromEntries(byStatusRows.map((r) => [r.status, r.c])),
      recentSessions: recentSessionsRow.c,
    });
  }

  getAllEntries(): Promise<any[]> {
    const rows = this.db.prepare("SELECT payload FROM entries").all() as Array<{ payload: string }>;
    const results = rows.map((r) => {
      try {
        return JSON.parse(r.payload);
      } catch {
        return null;
      }
    }).filter(Boolean);
    return Promise.resolve(results);
  }

  // ── Seats / membership (internal design note) ─────────────────────────────────────────

  countActiveSeats(orgId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM memberships WHERE org_id = ? AND status = 'active'")
      .get(orgId) as { c: number };
    return Promise.resolve(row.c);
  }

  addMember(data: AddMemberData): Promise<MemberRow> {
    // Ensure the org exists (single source of FK truth), then upsert the user
    // by email, then create the membership (idempotent on org+user).
    this.db.prepare("INSERT OR IGNORE INTO orgs (id) VALUES (?)").run(data.orgId);

    this.db
      .prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, users.name)")
      .run(randomUUID(), data.email, data.name ?? null);
    const user = this.db.prepare("SELECT id FROM users WHERE email = ?").get(data.email) as { id: string };

    this.db
      .prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role, status = excluded.status`,
      )
      .run(randomUUID(), data.orgId, user.id, data.role ?? "member", data.status ?? "active");

    return this.getMember(data.orgId, user.id) as Promise<MemberRow>;
  }

  listMembers(orgId: string): Promise<MemberRow[]> {
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, m.org_id AS orgId, m.user_id AS userId,
                u.email AS email, u.name AS name, m.role AS role, m.status AS status
         FROM   memberships m JOIN users u ON u.id = m.user_id
         WHERE  m.org_id = ?
         ORDER BY u.email`,
      )
      .all(orgId) as unknown as MemberRow[];
    return Promise.resolve(rows);
  }

  setMemberStatus(orgId: string, userId: string, status: MemberStatus): Promise<MemberRow | null> {
    this.db
      .prepare("UPDATE memberships SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND user_id = ?")
      .run(status, orgId, userId);
    return this.getMember(orgId, userId);
  }

  setMemberRole(orgId: string, userId: string, role: MemberRole): Promise<MemberRow | null> {
    this.db
      .prepare("UPDATE memberships SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND user_id = ?")
      .run(role, orgId, userId);
    return this.getMember(orgId, userId);
  }

  private getMember(orgId: string, userId: string): Promise<MemberRow | null> {
    const row = this.db
      .prepare(
        `SELECT m.id AS id, m.org_id AS orgId, m.user_id AS userId,
                u.email AS email, u.name AS name, m.role AS role, m.status AS status
         FROM   memberships m JOIN users u ON u.id = m.user_id
         WHERE  m.org_id = ? AND m.user_id = ?`,
      )
      .get(orgId, userId) as unknown as MemberRow | undefined;
    return Promise.resolve(row ?? null);
  }

  // ── API tokens (internal design note) ─────────────────────────────────────────────

  createApiToken(data: CreateApiTokenData): Promise<ApiTokenRow> {
    this.db.prepare("INSERT OR IGNORE INTO orgs (id) VALUES (?)").run(data.orgId);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO api_tokens (id, org_id, name, prefix, token_hash) VALUES (?, ?, ?, ?, ?)")
      .run(id, data.orgId, data.name, data.prefix, data.tokenHash);
    return this.getApiToken(id) as Promise<ApiTokenRow>;
  }

  listApiTokens(orgId: string): Promise<ApiTokenRow[]> {
    const rows = this.db
      .prepare(
        `SELECT id, org_id AS orgId, name, prefix,
                created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt
         FROM api_tokens WHERE org_id = ? ORDER BY created_at DESC`,
      )
      .all(orgId) as Array<Record<string, string | null>>;
    return Promise.resolve(rows.map(mapApiToken));
  }

  revokeApiToken(orgId: string, tokenId: string): Promise<ApiTokenRow | null> {
    this.db
      .prepare("UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND id = ? AND revoked_at IS NULL")
      .run(orgId, tokenId);
    return this.getApiToken(tokenId);
  }

  private getApiToken(id: string): Promise<ApiTokenRow | null> {
    const row = this.db
      .prepare(
        `SELECT id, org_id AS orgId, name, prefix,
                created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt
         FROM api_tokens WHERE id = ?`,
      )
      .get(id) as Record<string, string | null> | undefined;
    return Promise.resolve(row ? mapApiToken(row) : null);
  }

  // ── Repo permissions (internal design note) ──────────────────────────────

  listRepoPermissions(orgId: string, repoId: string): Promise<RepoPermissionRow[]> {
    const rows = this.db
      .prepare(
        `SELECT id, org_id AS orgId, repo_id AS repoId, principal_id AS principalId,
                access, created_at AS createdAt, updated_at AS updatedAt
         FROM repo_permissions WHERE org_id = ? AND repo_id = ? ORDER BY principal_id`,
      )
      .all(orgId, repoId) as Array<{ id: string; orgId: string; repoId: string; principalId: string; access: string; createdAt: string; updatedAt: string }>;
    return Promise.resolve(
      rows.map((r) => ({ ...r, access: r.access as RepoAccess, createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt) })),
    );
  }

  setRepoPermission(data: SetRepoPermissionData): Promise<RepoPermissionRow> {
    this.db.prepare("INSERT OR IGNORE INTO orgs (id) VALUES (?)").run(data.orgId);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO repo_permissions (id, org_id, repo_id, principal_id, access)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, repo_id, principal_id) DO UPDATE SET access = excluded.access, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(id, data.orgId, data.repoId, data.principalId, data.access);
    const row = this.db
      .prepare(
        `SELECT id, org_id AS orgId, repo_id AS repoId, principal_id AS principalId,
                access, created_at AS createdAt, updated_at AS updatedAt
         FROM repo_permissions WHERE org_id = ? AND repo_id = ? AND principal_id = ?`,
      )
      .get(data.orgId, data.repoId, data.principalId) as { id: string; orgId: string; repoId: string; principalId: string; access: string; createdAt: string; updatedAt: string };
    return Promise.resolve({ ...row, access: row.access as RepoAccess, createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt) });
  }

  deleteRepoPermission(orgId: string, repoId: string, principalId: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM repo_permissions WHERE org_id = ? AND repo_id = ? AND principal_id = ?")
      .run(orgId, repoId, principalId);
    return Promise.resolve((result as { changes: number }).changes > 0);
  }

  getEffectiveAccess(orgId: string, repoId: string, userId: string): Promise<RepoAccess> {
    // Check user-specific grant first, then org wildcard, then default to "write".
    const userRow = this.db
      .prepare("SELECT access FROM repo_permissions WHERE org_id = ? AND repo_id = ? AND principal_id = ?")
      .get(orgId, repoId, userId) as { access: string } | undefined;
    if (userRow) return Promise.resolve(userRow.access as RepoAccess);
    const wildcardRow = this.db
      .prepare("SELECT access FROM repo_permissions WHERE org_id = ? AND repo_id = ? AND principal_id = '*'")
      .get(orgId, repoId) as { access: string } | undefined;
    return Promise.resolve((wildcardRow?.access as RepoAccess | undefined) ?? "write");
  }

  // ── Webhooks (internal design note) ────────────────────────────────────────────────

  listWebhooks(orgId: string): Promise<WebhookRow[]> {
    const rows = this.db
      .prepare(
        `SELECT id, org_id AS orgId, url, events, active, created_at AS createdAt
         FROM webhooks WHERE org_id = ? ORDER BY created_at DESC`,
      )
      .all(orgId) as Array<{ id: string; orgId: string; url: string; events: string; active: number; createdAt: string }>;
    return Promise.resolve(
      rows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        url: r.url,
        events: parseJson<string[]>(r.events) ?? [],
        active: toBool(r.active),
        createdAt: toDate(r.createdAt),
      })),
    );
  }

  createWebhook(data: CreateWebhookData): Promise<WebhookRow> {
    this.db.prepare("INSERT OR IGNORE INTO orgs (id) VALUES (?)").run(data.orgId);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO webhooks (id, org_id, url, events) VALUES (?, ?, ?, ?)")
      .run(id, data.orgId, data.url, JSON.stringify(data.events));
    const row = this.db
      .prepare(
        `SELECT id, org_id AS orgId, url, events, active, created_at AS createdAt
         FROM webhooks WHERE id = ?`,
      )
      .get(id) as { id: string; orgId: string; url: string; events: string; active: number; createdAt: string };
    return Promise.resolve({
      id: row.id,
      orgId: row.orgId,
      url: row.url,
      events: parseJson<string[]>(row.events) ?? [],
      active: toBool(row.active),
      createdAt: toDate(row.createdAt),
    });
  }

  deleteWebhook(orgId: string, webhookId: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM webhooks WHERE org_id = ? AND id = ?")
      .run(orgId, webhookId);
    return Promise.resolve((result as { changes: number }).changes > 0);
  }
}
