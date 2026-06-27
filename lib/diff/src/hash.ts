// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Fast FNV-1a (32-bit) hash over a normalised set of lines.
 * Used to fingerprint hunk content for move detection.
 */
export function hashLines(lines: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      h ^= line.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
