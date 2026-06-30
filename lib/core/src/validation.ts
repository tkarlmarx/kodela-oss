// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { z } from "zod";

export const RepoRootSchema = z
  .string()
  .min(1, "repoRoot must not be empty")
  .refine((s) => !s.includes("\0"), {
    message: "repoRoot must not contain null bytes",
  });

export const FilePathInputSchema = z
  .string()
  .min(1, "filePath must not be empty")
  .refine((p) => !p.includes("\0"), {
    message: "filePath must not contain null bytes",
  })
  .refine((p) => !/(^|[/\\])\.\.(\/|\\|$)/.test(p), {
    message:
      "filePath must not contain directory traversal segments (..)",
  });

export const RelativePathSchema = z
  .string()
  .min(1, "relativePath must not be empty")
  .refine((p) => !p.includes("\0"), {
    message: "relativePath must not contain null bytes",
  });

export const EntryIdSchema = z
  .string()
  .uuid("entryId must be a valid UUID v4");

export const FileContentSchema = z.string();

export const InitBaselineOptionsSchema = z
  .object({
    force: z.boolean().optional(),
    fileGlobs: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function validateRepoRoot(repoRoot: unknown): string {
  return RepoRootSchema.parse(repoRoot);
}

export function validateFilePath(filePath: unknown): string {
  return FilePathInputSchema.parse(filePath);
}

export function validateEntryId(id: unknown): string {
  return EntryIdSchema.parse(id);
}

export function validateFileContent(content: unknown): string {
  return FileContentSchema.parse(content);
}
