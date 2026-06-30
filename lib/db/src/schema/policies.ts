// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, boolean, real, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { orgsTable } from "./orgs";

export const policiesTable = pgTable("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("default"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const policyRulesTable = pgTable("policy_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyId: uuid("policy_id")
    .notNull()
    .references(() => policiesTable.id, { onDelete: "cascade" }),
  pathGlob: text("path_glob").notNull(),
  minConfidence: real("min_confidence"),
  requireContext: boolean("require_context").notNull().default(false),
  allowedAiTools: jsonb("allowed_ai_tools").$type<string[] | null>(),
  minSeverity: text("min_severity", {
    enum: ["critical", "high", "medium", "low"],
  }),
  requireReview: boolean("require_review").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPolicySchema = createInsertSchema(policiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPolicyRuleSchema = createInsertSchema(policyRulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Policy = typeof policiesTable.$inferSelect;
export type PolicyRule = typeof policyRulesTable.$inferSelect;
export type InsertPolicyRule = z.infer<typeof insertPolicyRuleSchema>;
