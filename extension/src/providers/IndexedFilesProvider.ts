import * as pathModule from "path";
import * as vscode from "vscode";
import { ContextService } from "../services/ContextService";

export class IndexedFilesProvider implements vscode.TreeDataProvider<FileItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private _context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: FileItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: FileItem): Promise<FileItem[]> {
        if (element) return [];
        try {
            const ctx = await ContextService.getInstance().getContext();
            const paths = await ctx.listFiles();
            return paths.map((p: string) => new FileItem(ctx.getWorkspaceRoot(), p));
        } catch {
            return [];
        }
    }
}

class FileItem extends vscode.TreeItem {
    constructor(workspaceRoot: string, public readonly path: string) {
        super(path, vscode.TreeItemCollapsibleState.None);
        this.contextValue = "file";
        this.command = {
            command: "vscode.open",
            title: "Open File",
            arguments: [vscode.Uri.file(pathModule.resolve(workspaceRoot, path))],
        };
    }
}
