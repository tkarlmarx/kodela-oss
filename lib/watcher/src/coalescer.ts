// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { ChangeType } from "./types.js";
import type { ChangeType as ChangeTypeValue } from "./types.js";

export type RawEventType = "add" | "change" | "unlink";

export function coalesceChangeType(
  current: ChangeTypeValue | undefined,
  incoming: RawEventType,
): ChangeTypeValue {
  if (current === undefined) {
    if (incoming === "add") return ChangeType.create;
    if (incoming === "change") return ChangeType.modify;
    return ChangeType.delete;
  }

  if (current === ChangeType.create) {
    if (incoming === "change") return ChangeType.create;
    if (incoming === "unlink") return ChangeType.delete;
    return ChangeType.create;
  }

  if (current === ChangeType.modify) {
    if (incoming === "change") return ChangeType.modify;
    if (incoming === "unlink") return ChangeType.delete;
    if (incoming === "add") return ChangeType.modify;
    return ChangeType.modify;
  }

  if (current === ChangeType.delete) {
    if (incoming === "add") return ChangeType.modify;
    return ChangeType.delete;
  }

  return ChangeType.modify;
}
