// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Typed mock of the VS Code extension API for use in unit and smoke tests.
 *
 * Loaded in place of the real VS Code runtime module via tsx path aliasing:
 *   tsconfig.test.json → compilerOptions.paths → "vscode": ["./src/__mocks__/vscode.ts"]
 *
 * Implements the subset of the VS Code API surface used by @kodela/vscode,
 * with enough type fidelity that `tsc -p tsconfig.test.json --noEmit` catches
 * API-shape drift between the mock and the production source files.
 */

// ─── Primitive types ──────────────────────────────────────────────────────────

export type Thenable<T> = Promise<T>;

/** A function that subscribes a listener and returns a Disposable. */
export type Event<T> = (listener: (e: T) => void) => { dispose(): void };

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
}

// ─── Disposable ───────────────────────────────────────────────────────────────
//
// Intentionally has NO private fields so that production classes that do
//   `implements vscode.Disposable`
// only need to provide a public `dispose()` method, matching @types/vscode.

export class Disposable {
  /** Closure-based disposal — no private fields to avoid 'implements' conflicts. */
  dispose: () => void;

  constructor(fn: () => void) {
    let called = false;
    this.dispose = (): void => {
      if (!called) {
        called = true;
        fn();
      }
    };
  }

  static from(...disposables: { dispose(): void }[]): Disposable {
    return new Disposable((): void => {
      for (const d of disposables) d.dispose();
    });
  }
}

// ─── EventEmitter ─────────────────────────────────────────────────────────────

type Listener<T> = (value: T) => void;

function makeEvent<T>() {
  const listeners: Listener<T>[] = [];

  const event = (listener: Listener<T>): { dispose(): void } => {
    listeners.push(listener);
    return {
      dispose: (): void => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
  };

  return {
    event: event as Event<T>,
    fire: (value: T): void => {
      for (const l of [...listeners]) l(value);
    },
  };
}

export class EventEmitter<T> {
  private readonly _impl: ReturnType<typeof makeEvent<T>>;
  readonly event: Event<T>;

  constructor() {
    this._impl = makeEvent<T>();
    this.event = this._impl.event;
  }

  fire(value: T): void {
    this._impl.fire(value);
  }

  dispose(): void {}
}

// ─── Uri ──────────────────────────────────────────────────────────────────────

export class Uri {
  readonly scheme: string;
  readonly path: string;
  readonly fsPath: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.path = fsPath;
    this.fsPath = fsPath;
  }

  static file(p: string): Uri {
    return new Uri("file", p);
  }

  static parse(s: string): Uri {
    return new Uri("file", s);
  }

  toString(): string {
    return this.fsPath;
  }
}

// ─── RelativePattern ──────────────────────────────────────────────────────────

export class RelativePattern {
  readonly base: Uri | string;
  readonly pattern: string;

  constructor(base: Uri | string, pattern: string) {
    this.base = base;
    this.pattern = pattern;
  }
}

// ─── Position / Range / Selection ─────────────────────────────────────────────

export class Position {
  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(
    startOrLine: Position | number,
    endOrStartChar: Position | number,
    endLine?: number,
    endChar?: number,
  ) {
    if (startOrLine instanceof Position) {
      this.start = startOrLine;
      this.end = endOrStartChar as Position;
    } else {
      this.start = new Position(startOrLine, endOrStartChar as number);
      this.end = new Position(endLine ?? 0, endChar ?? 0);
    }
  }

  contains(posOrRange: Position | Range): boolean {
    const p = posOrRange instanceof Position ? posOrRange : posOrRange.start;
    return this.start.line <= p.line && p.line <= this.end.line;
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchorLine: number, anchorChar: number, activeLine: number, activeChar: number);
  constructor(anchor: Position, active: Position);
  constructor(
    anchorOrLine: Position | number,
    activeOrAnchorChar: Position | number,
    activeLine?: number,
    activeChar?: number,
  ) {
    if (anchorOrLine instanceof Position) {
      super(anchorOrLine, activeOrAnchorChar as Position);
    } else {
      super(anchorOrLine, activeOrAnchorChar as number, activeLine ?? 0, activeChar ?? 0);
    }
    this.anchor = this.start;
    this.active = this.end;
  }

  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

// ─── MarkdownString ───────────────────────────────────────────────────────────

export class MarkdownString {
  value: string;
  isTrusted: boolean;

  constructor(value?: string) {
    this.value = value ?? "";
    this.isTrusted = false;
  }

  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }

  appendText(s: string): this {
    this.value += s;
    return this;
  }
}

// ─── Hover ────────────────────────────────────────────────────────────────────

export class Hover {
  readonly contents: MarkdownString[];
  readonly range: Range | undefined;

  constructor(contents: MarkdownString | MarkdownString[], range?: Range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

// ─── CodeLens ─────────────────────────────────────────────────────────────────

type Command = { title: string; command: string; tooltip?: string; arguments?: unknown[] };

export class CodeLens {
  readonly range: Range;
  readonly command: Command | undefined;
  readonly isResolved: boolean;

  constructor(range: Range, command?: Command) {
    this.range = range;
    this.command = command;
    this.isResolved = !!command;
  }
}

// ─── ThemeColor / ThemeIcon ───────────────────────────────────────────────────

export class ThemeColor {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }
}

export class ThemeIcon {
  readonly id: string;
  readonly color: ThemeColor | undefined;
  static readonly File: ThemeIcon = new ThemeIcon("file");
  static readonly Folder: ThemeIcon = new ThemeIcon("folder");

  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

// ─── TreeItem ─────────────────────────────────────────────────────────────────

export class TreeItem {
  label: string | undefined;
  resourceUri: Uri | undefined;
  collapsibleState: number;
  iconPath: ThemeIcon | Uri | string | undefined;
  description: string | boolean | undefined;
  tooltip: string | MarkdownString | undefined;
  contextValue: string | undefined;
  command: Command | undefined;

  constructor(labelOrUri: string | Uri, collapsibleState?: number) {
    if (typeof labelOrUri === "string") {
      this.label = labelOrUri;
    } else {
      this.resourceUri = labelOrUri;
    }
    this.collapsibleState = collapsibleState ?? 0;
  }
}

// ─── Diagnostic ───────────────────────────────────────────────────────────────

export class Diagnostic {
  readonly range: Range;
  readonly message: string;
  readonly severity: number;
  source: string | undefined;
  code: string | number | { value: string | number; target: Uri } | undefined;

  constructor(range: Range, message: string, severity?: number) {
    this.range = range;
    this.message = message;
    this.severity = severity ?? 0;
  }
}

// ─── Const enumerations ───────────────────────────────────────────────────────

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export type StatusBarAlignment = (typeof StatusBarAlignment)[keyof typeof StatusBarAlignment];

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export type TreeItemCollapsibleState = (typeof TreeItemCollapsibleState)[keyof typeof TreeItemCollapsibleState];

export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 } as const;
export type OverviewRulerLane = (typeof OverviewRulerLane)[keyof typeof OverviewRulerLane];

export const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const;
export type TextEditorRevealType = (typeof TextEditorRevealType)[keyof typeof TextEditorRevealType];

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export type ProgressLocation = (typeof ProgressLocation)[keyof typeof ProgressLocation];

// ─── Shape types (used as type annotations in production code) ────────────────

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

export interface TextDocument {
  readonly uri: Uri;
  readonly fileName: string;
  readonly lineCount: number;
  getText(): string;
}

export interface TextDocumentChangeEvent {
  readonly document: TextDocument;
  readonly contentChanges: ReadonlyArray<{ readonly text: string }>;
}

export interface TextEditorDecorationType {
  readonly key: string;
  dispose(): void;
}

export interface TextEditor {
  readonly document: TextDocument;
  selection: Selection;
  readonly selections: Selection[];
  revealRange(range: Range, revealType?: number): void;
  edit(callback: (builder: unknown) => void): Thenable<boolean>;
  setDecorations(
    decorationType: TextEditorDecorationType,
    rangesOrOptions: readonly Range[],
  ): void;
}

export interface StatusBarItem {
  text: string;
  tooltip: string | MarkdownString;
  command: string | undefined;
  backgroundColor: ThemeColor | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface OutputChannel {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  replace(value: string): void;
  clear(): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  dispose(): void;
}

export interface FileSystemWatcher {
  readonly onDidCreate: Event<Uri>;
  readonly onDidChange: Event<Uri>;
  readonly onDidDelete: Event<Uri>;
  dispose(): void;
}

export interface DiagnosticCollection {
  readonly name: string;
  set(uri: Uri, diagnostics: ReadonlyArray<Diagnostic>): void;
  delete(uri: Uri): void;
  clear(): void;
  dispose(): void;
  forEach(
    callback: (
      uri: Uri,
      diagnostics: ReadonlyArray<Diagnostic>,
      collection: DiagnosticCollection,
    ) => void,
  ): void;
}

export interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined;
  get<T>(section: string, defaultValue: T): T;
  has(section: string): boolean;
  inspect<T>(section: string): { globalValue?: T; workspaceValue?: T } | undefined;
  update(section: string, value: unknown): Thenable<void>;
}

export interface Memento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
}

export interface ExtensionContext {
  readonly subscriptions: { dispose(): void }[];
  readonly extensionUri?: Uri;
  readonly extensionPath?: string;
  readonly globalStoragePath?: string;
  readonly globalStorageUri?: Uri;
  readonly storagePath?: string;
  readonly storageUri?: Uri;
  readonly logPath?: string;
  readonly workspaceState: Memento;
  readonly globalState: Memento;
  asAbsolutePath(relativePath: string): string;
}

export interface Extension<T = unknown> {
  readonly id: string;
  readonly extensionPath: string;
  readonly packageJSON: Record<string, unknown>;
  readonly isActive: boolean;
  readonly exports: T;
  activate(): Thenable<T>;
}

// ─── Chat & LM types ────────────────────────────────────────────────────────

export interface ChatPromptReference {
  readonly id: string;
  readonly value: unknown;
}

export interface ChatRequest {
  readonly prompt: string;
  readonly command: string | undefined;
  readonly references: readonly ChatPromptReference[];
  readonly model: LanguageModelChat;
}

export interface ChatContext {
  readonly history: readonly unknown[];
}

export interface ChatResult {
  readonly metadata?: { readonly [key: string]: unknown };
}

export interface ChatResponseStream {
  markdown(value: string | MarkdownString): void;
}

export type ChatRequestHandler = (
  request: ChatRequest,
  context: ChatContext,
  response: ChatResponseStream,
  token: CancellationToken,
) => Thenable<ChatResult | void> | ChatResult | void;

export interface ChatParticipant {
  readonly id: string;
  requestHandler: ChatRequestHandler;
  iconPath?: ThemeIcon | Uri | string;
  dispose(): void;
}

export interface LanguageModelChatResponse {
  readonly text: AsyncIterable<string>;
  readonly stream: AsyncIterable<unknown>;
}

export interface LanguageModelChat {
  readonly name: string;
  readonly id: string;
  readonly vendor: string;
  readonly family: string;
  readonly version: string;
  readonly maxInputTokens: number;
  sendRequest(
    messages: LanguageModelChatMessage[],
    options?: unknown,
    token?: CancellationToken,
  ): Thenable<LanguageModelChatResponse>;
  countTokens(text: string | LanguageModelChatMessage): Thenable<number>;
}

export interface LanguageModelChatSelector {
  vendor?: string;
  family?: string;
  version?: string;
  id?: string;
}

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export class LanguageModelChatMessage {
  readonly role: LanguageModelChatMessageRole;
  readonly content: string;

  constructor(role: LanguageModelChatMessageRole, content: string) {
    this.role = role;
    this.content = content;
  }

  static User(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content);
  }

  static Assistant(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content);
  }
}

// ─── Provider interfaces ───────────────────────────────────────────────────────
//
// Return types are unions (e.g. `Hover | null | Thenable<Hover | null>`) so
// production providers that return synchronously still satisfy the interface.

export interface HoverProvider {
  provideHover(
    document: TextDocument,
    position: Position,
    token: CancellationToken,
  ): Hover | null | Thenable<Hover | null>;
}

export interface CodeLensProvider {
  provideCodeLenses(
    document: TextDocument,
    token: CancellationToken,
  ): CodeLens[] | Thenable<CodeLens[]>;
}

export interface TreeDataProvider<T> {
  readonly onDidChangeTreeData?: Event<T | undefined | void>;
  getTreeItem(element: T): TreeItem;
  getChildren(element?: T): readonly T[] | Thenable<readonly T[]>;
}

export interface TreeView<T> {
  reveal(
    element: T,
    options?: { select?: boolean; focus?: boolean; expand?: boolean | number },
  ): Thenable<void>;
  readonly onDidChangeSelection: Event<{ selection: readonly T[] }>;
  dispose(): void;
}

// ─── Factory helpers (internal) ───────────────────────────────────────────────

function makeFileSystemWatcher(): FileSystemWatcher & {
  _fireCreate(v: Uri): void;
  _fireChange(v: Uri): void;
  _fireDelete(v: Uri): void;
} {
  const onCreate = makeEvent<Uri>();
  const onChange = makeEvent<Uri>();
  const onDelete = makeEvent<Uri>();
  return {
    onDidCreate: onCreate.event,
    onDidChange: onChange.event,
    onDidDelete: onDelete.event,
    dispose: (): void => {},
    _fireCreate: (v: Uri): void => onCreate.fire(v),
    _fireChange: (v: Uri): void => onChange.fire(v),
    _fireDelete: (v: Uri): void => onDelete.fire(v),
  };
}

function makeStatusBarItem(): StatusBarItem {
  return {
    text: "",
    tooltip: "",
    command: undefined,
    backgroundColor: undefined,
    show: (): void => {},
    hide: (): void => {},
    dispose: (): void => {},
  };
}

function makeOutputChannel(name: string): OutputChannel {
  return {
    name,
    append: (): void => {},
    appendLine: (): void => {},
    replace: (): void => {},
    clear: (): void => {},
    show: (): void => {},
    hide: (): void => {},
    dispose: (): void => {},
  };
}

function makeMockExtension(id: string, exportsValue: unknown = {}): Extension<unknown> {
  return {
    id,
    extensionPath: "/mock/extensions",
    packageJSON: { name: id },
    isActive: true,
    exports: exportsValue,
    activate: async (): Promise<unknown> => exportsValue,
  };
}

// ─── commands ─────────────────────────────────────────────────────────────────

const _registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const _onDidExecuteCommand = makeEvent<{ command: string; arguments?: readonly unknown[] }>();

export const commands = {
  registerCommand: (
    id: string,
    fn: (...args: unknown[]) => unknown,
  ): { dispose(): void } => {
    _registeredCommands.set(id, fn);
    return { dispose: (): void => { _registeredCommands.delete(id); } };
  },
  executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T | undefined> => {
    const fn = _registeredCommands.get(id);
    if (fn) return fn(...args) as T;
    return undefined;
  },
  onDidExecuteCommand: _onDidExecuteCommand.event,
};

/** Test helper: simulate a VS Code command execution (fires onDidExecuteCommand). */
export function _testFireExecuteCommand(commandId: string, args?: readonly unknown[]): void {
  _onDidExecuteCommand.fire({ command: commandId, arguments: args });
}

const _installedExtensions = new Map<string, Extension<unknown>>();

export const extensions = {
  get all(): ReadonlyArray<Extension<unknown>> {
    return Array.from(_installedExtensions.values());
  },
  getExtension: <T = unknown>(id: string): Extension<T> | undefined =>
    _installedExtensions.get(id) as Extension<T> | undefined,
};

/** Test helper: replace the installed extension IDs exposed by vscode.extensions. */
export function _testSetInstalledExtensions(ids: readonly string[]): void {
  _installedExtensions.clear();
  for (const id of ids) {
    _installedExtensions.set(id, makeMockExtension(id));
  }
}

/** Test helper: install one extension with explicit exports payload. */
export function _testSetExtensionWithExports(id: string, exportsValue: unknown): void {
  _installedExtensions.set(id, makeMockExtension(id, exportsValue));
}

/** Test helper: clear all mocked installed extensions. */
export function _testResetInstalledExtensions(): void {
  _installedExtensions.clear();
}

// ─── chat / lm ──────────────────────────────────────────────────────────────

const _chatParticipants = new Map<string, ChatParticipant>();

function toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

function makeMockModel(options?: {
  id?: string;
  vendor?: string;
  family?: string;
  version?: string;
  textChunks?: readonly string[];
}): LanguageModelChat {
  const textChunks = [...(options?.textChunks ?? [])];
  return {
    name: options?.id ?? "mock-copilot",
    id: options?.id ?? "mock-copilot",
    vendor: options?.vendor ?? "copilot",
    family: options?.family ?? "gpt-4o",
    version: options?.version ?? "test",
    maxInputTokens: 128_000,
    sendRequest: async (): Promise<LanguageModelChatResponse> => ({
      text: toAsyncIterable(textChunks),
      stream: toAsyncIterable(textChunks),
    }),
    countTokens: async (text: string | LanguageModelChatMessage): Promise<number> =>
      typeof text === "string" ? text.length : text.content.length,
  };
}

const _onDidChangeChatModels = makeEvent<void>();
let _chatModels: LanguageModelChat[] = [makeMockModel()];

export const chat = {
  createChatParticipant: (id: string, handler: ChatRequestHandler): ChatParticipant => {
    const participant: ChatParticipant = {
      id,
      requestHandler: handler,
      iconPath: undefined,
      dispose: (): void => {
        _chatParticipants.delete(id);
      },
    };
    _chatParticipants.set(id, participant);
    return participant;
  },
};

export const lm = {
  onDidChangeChatModels: _onDidChangeChatModels.event,
  selectChatModels: async (
    selector?: LanguageModelChatSelector,
  ): Promise<LanguageModelChat[]> => {
    return _chatModels.filter((model) => {
      if (selector?.id && selector.id !== model.id) return false;
      if (selector?.vendor && selector.vendor !== model.vendor) return false;
      if (selector?.family && selector.family !== model.family) return false;
      if (selector?.version && selector.version !== model.version) return false;
      return true;
    });
  },
};

/** Test helper: replace available chat models used by vscode.lm.selectChatModels. */
export function _testSetChatModels(models: readonly LanguageModelChat[]): void {
  _chatModels = [...models];
  _onDidChangeChatModels.fire();
}

/** Test helper: reset chat models to one default Copilot model. */
export function _testResetChatModels(): void {
  _chatModels = [makeMockModel()];
  _onDidChangeChatModels.fire();
}

/** Test helper: create a model with deterministic streamed text chunks. */
export function _testCreateChatModel(options?: {
  id?: string;
  vendor?: string;
  family?: string;
  version?: string;
  textChunks?: readonly string[];
}): LanguageModelChat {
  return makeMockModel(options);
}

/**
 * Test helper: invoke a registered chat participant and capture streamed markdown output.
 */
export async function _testInvokeChatParticipant(
  participantId: string,
  request: { prompt: string; command?: string; references?: readonly ChatPromptReference[]; model?: LanguageModelChat },
  context?: { history?: readonly unknown[] },
): Promise<{ result: ChatResult | void; markdown: string[] }> {
  const participant = _chatParticipants.get(participantId);
  if (!participant) {
    throw new Error(`Chat participant not found: ${participantId}`);
  }

  const markdown: string[] = [];
  const stream: ChatResponseStream = {
    markdown: (value: string | MarkdownString): void => {
      markdown.push(typeof value === "string" ? value : value.value);
    },
  };

  const model = request.model ?? _chatModels[0] ?? makeMockModel();
  const fullRequest: ChatRequest = {
    prompt: request.prompt,
    command: request.command,
    references: request.references ?? [],
    model,
  };

  const fullContext: ChatContext = {
    history: context?.history ?? [],
  };

  const result = await participant.requestHandler(
    fullRequest,
    fullContext,
    stream,
    { isCancellationRequested: false },
  );

  return { result, markdown };
}

/** Test helper: clear all registered chat participants. */
export function _testResetChatParticipants(): void {
  _chatParticipants.clear();
}

// ─── languages ────────────────────────────────────────────────────────────────

const _diagnosticCollections = new Map<string, DiagnosticCollection>();

export const languages = {
  registerHoverProvider: (
    _selector: unknown,
    _provider: HoverProvider,
  ): { dispose(): void } => ({ dispose: (): void => {} }),
  registerCodeLensProvider: (
    _selector: unknown,
    _provider: CodeLensProvider,
  ): { dispose(): void } => ({ dispose: (): void => {} }),
  createDiagnosticCollection: (name: string): DiagnosticCollection => {
    const items = new Map<string, ReadonlyArray<Diagnostic>>();
    const coll: DiagnosticCollection = {
      name,
      set: (uri: Uri, diags: ReadonlyArray<Diagnostic>): void => {
        items.set(uri.toString(), diags);
      },
      delete: (uri: Uri): void => { items.delete(uri.toString()); },
      clear: (): void => { items.clear(); },
      dispose: (): void => { items.clear(); },
      forEach: (cb): void => {
        items.forEach((v, k) => cb(Uri.file(k), v, coll));
      },
    };
    _diagnosticCollections.set(name, coll);
    return coll;
  },
};

// ─── workspace ────────────────────────────────────────────────────────────────

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

const _onDidChangeTextDocument = makeEvent<TextDocumentChangeEvent>();
const _onDidSaveTextDocument = makeEvent<TextDocument>();
const _onDidOpenTextDocument = makeEvent<TextDocument>();
const _onDidChangeConfiguration = makeEvent<ConfigurationChangeEvent>();

export const workspace = {
  workspaceFolders: undefined as ReadonlyArray<WorkspaceFolder> | undefined,
  textDocuments: [] as ReadonlyArray<TextDocument>,
  createFileSystemWatcher: (_pattern: RelativePattern | string): FileSystemWatcher =>
    makeFileSystemWatcher(),
  getConfiguration: (_section?: string): WorkspaceConfiguration => ({
    get: ((_key: string, defaultVal?: unknown) => defaultVal) as WorkspaceConfiguration["get"],
    has: (): boolean => false,
    inspect: (): undefined => undefined,
    update: async (): Promise<void> => {},
  }),
  onDidChangeTextDocument: _onDidChangeTextDocument.event,
  onDidSaveTextDocument: _onDidSaveTextDocument.event,
  onDidOpenTextDocument: _onDidOpenTextDocument.event,
  onDidChangeConfiguration: _onDidChangeConfiguration.event,
  openTextDocument: async (_uri: Uri): Promise<TextDocument> => ({
    uri: _uri,
    fileName: _uri.fsPath,
    lineCount: 0,
    getText: (): string => "",
  }),
  asRelativePath: (pathOrUri: string | Uri): string =>
    typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath,
};

/** Test helper: fire the onDidOpenTextDocument event. */
export function _testFireOpen(document: TextDocument): void {
  _onDidOpenTextDocument.fire(document);
}

/** Test helper: fire the onDidSaveTextDocument event. */
export function _testFireSave(document: TextDocument): void {
  _onDidSaveTextDocument.fire(document);
}

/** Test helper: fire the onDidChangeConfiguration event. */
export function _testFireConfigChange(event: ConfigurationChangeEvent): void {
  _onDidChangeConfiguration.fire(event);
}

// ─── window ───────────────────────────────────────────────────────────────────

const _onDidChangeActiveTextEditor = makeEvent<TextEditor | undefined>();

export const window = {
  createStatusBarItem: (_alignment?: number, _priority?: number): StatusBarItem =>
    makeStatusBarItem(),
  createTextEditorDecorationType: (_opts: unknown): TextEditorDecorationType =>
    ({ key: "mock", dispose: (): void => {} }),
  showInformationMessage: async (
    _message: string,
    ..._rest: unknown[]
  ): Promise<string | undefined> => undefined,
  showWarningMessage: async (
    _message: string,
    ..._rest: unknown[]
  ): Promise<string | undefined> => undefined,
  showErrorMessage: async (
    _message: string,
    ..._rest: unknown[]
  ): Promise<string | undefined> => undefined,
  showInputBox: async (_opts?: {
    title?: string;
    prompt?: string;
    placeHolder?: string;
    value?: string;
    ignoreFocusOut?: boolean;
    password?: boolean;
    validateInput?: (value: string) => string | null | undefined;
  }): Promise<string | undefined> => undefined,
  showQuickPick: async <T>(
    _items: readonly T[] | T[],
    _opts?: { title?: string; placeHolder?: string; canPickMany?: boolean; ignoreFocusOut?: boolean },
  ): Promise<T | undefined> => undefined,
  showTextDocument: async (_document: TextDocument): Promise<TextEditor> => ({
    document: _document,
    selection: new Selection(0, 0, 0, 0),
    selections: [],
    revealRange: (): void => {},
    edit: async (): Promise<boolean> => true,
    setDecorations: (): void => {},
  }),
  createOutputChannel: (name: string): OutputChannel => makeOutputChannel(name),
  createTreeView: <T>(
    _id: string,
    _opts: { treeDataProvider: TreeDataProvider<T>; showCollapseAll?: boolean },
  ): TreeView<T> => {
    const selectionEvent = makeEvent<{ selection: readonly T[] }>();
    return {
      reveal: async (): Promise<void> => {},
      onDidChangeSelection: selectionEvent.event,
      dispose: (): void => {},
    };
  },
  withProgress: async <T>(
    _opts: unknown,
    task: (
      progress: { report(v: unknown): void },
      token: CancellationToken,
    ) => Thenable<T>,
  ): Promise<T> =>
    task({ report: (): void => {} }, { isCancellationRequested: false }),
  activeTextEditor: undefined as TextEditor | undefined,
  onDidChangeActiveTextEditor: _onDidChangeActiveTextEditor.event,
  visibleTextEditors: [] as TextEditor[],
};

// ─── env ──────────────────────────────────────────────────────────────────────
// Gap 21 — telemetry opt-in flag.
// Tests default to enabled; individual tests can override via the module mock.

export const env = {
  /** Gap 21 — mirrors vscode.env.isTelemetryEnabled. Defaults to true in tests. */
  isTelemetryEnabled: true as boolean,
  openExternal: async (_uri: Uri): Promise<boolean> => true,
};
