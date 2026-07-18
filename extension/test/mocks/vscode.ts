export class Position { constructor(public line: number, public character: number) {} }
export class Range { constructor(public start: Position, public end: Position) {} }
export class Uri {
  constructor(public fsPath: string, public scheme = "file", public path = fsPath) {}
  static file(p: string) { return new Uri(p, "file", p); }
  static from(v: { scheme: string; path: string }) { return new Uri(v.path, v.scheme, v.path); }
}
export class WorkspaceEdit {
  ops: any[] = [];
  createFile(uri: Uri, options?: any) { this.ops.push({ type: "createFile", uri, options }); }
  insert(uri: Uri, position: Position, text: string) { this.ops.push({ type: "insert", uri, position, text }); }
  replace(uri: Uri, range: Range, text: string) { this.ops.push({ type: "replace", uri, range, text }); }
  deleteFile(uri: Uri, options?: any) { this.ops.push({ type: "deleteFile", uri, options }); }
}
export class EventEmitter<T> { listeners: ((v: T) => void)[] = []; event = (fn: (v: T) => void) => { this.listeners.push(fn); return { dispose() {} }; }; fire(v: T) { this.listeners.forEach(fn => fn(v)); } }
export class CancellationError extends Error {}
export enum ConfigurationTarget { Global = 1 }
export const workspace: any = {
  workspaceFolders: [], textDocuments: [], visibleTextEditors: [],
  _config: new Map<string, any>(), _providers: new Map<string, any>(), _files: new Map<string, string>(), _stats: new Set<string>(),
  getConfiguration: () => ({ get: (k: string, d?: any) => workspace._config.has(k) ? workspace._config.get(k) : d, update: async (k: string, v: any) => workspace._config.set(k, v) }),
  registerTextDocumentContentProvider: (scheme: string, provider: any) => { workspace._providers.set(scheme, provider); return { dispose() { workspace._providers.delete(scheme); } }; },
  fs: {
    readFile: async (uri: Uri) => new TextEncoder().encode(workspace._files.get(uri.fsPath) ?? ""),
    stat: async (uri: Uri) => { if (!workspace._stats.has(uri.fsPath) && !workspace._files.has(uri.fsPath)) throw new Error("ENOENT"); return {}; },
    createDirectory: async () => {},
  },
  openTextDocument: async (uri: Uri) => ({ uri, isDirty: false, save: async () => true, getText: () => workspace._files.get(uri.fsPath) ?? "", lineCount: 1, lineAt: () => ({ range: { end: new Position(0, (workspace._files.get(uri.fsPath) ?? "").length) } }) }),
  applyEdit: async (edit: WorkspaceEdit) => { workspace._lastEdit = edit; for (const op of edit.ops) { if (op.type === "deleteFile") { workspace._files.delete(op.uri.fsPath); workspace._stats.delete(op.uri.fsPath); } if (op.type === "insert" || op.type === "replace") workspace._files.set(op.uri.fsPath, op.text); if (op.type === "createFile") workspace._stats.add(op.uri.fsPath); } return workspace._applyEditResult ?? true; },
};
export const window: any = { activeTextEditor: undefined, visibleTextEditors: [], showWarningMessage: async () => undefined };
export const commands: any = { _calls: [] as any[], executeCommand: async (...args: any[]) => { commands._calls.push(args); } };
export interface Disposable { dispose(): any }
