// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export class KodelaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class PathTraversalError extends KodelaError {
  constructor(message: string) {
    super(message);
  }
}

export class SchemaVersionError extends KodelaError {
  readonly receivedVersion: unknown;
  readonly expectedVersion: string;

  constructor(received: unknown, expected: string) {
    super(
      `Unsupported schema version: expected "${expected}", got "${String(received)}". ` +
        `This file may have been written by a newer version of Kodela.`,
    );
    this.receivedVersion = received;
    this.expectedVersion = expected;
  }
}

export class StorageCorruptionError extends KodelaError {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(
      `Storage file is corrupt or invalid at "${filePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.filePath = filePath;
  }
}

export class BaselineAlreadyExistsError extends KodelaError {
  constructor(kodelaDirPath: string) {
    super(
      `Kodela baseline already exists at "${kodelaDirPath}". ` +
        `Call initBaseline with { force: true } to reinitialise (this will not delete existing context entries).`,
    );
  }
}

export class MappingLayerError extends KodelaError {
  readonly layer: string;

  constructor(layer: string, cause: unknown) {
    super(
      `Mapping layer "${layer}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.layer = layer;
  }
}
