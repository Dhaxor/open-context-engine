import * as vscode from "vscode";
import { ContextService } from "../services/ContextService";

export class SearchProvider {
    public static async search(): Promise<void> {
        const query = await vscode.window.showInputBox({
            prompt: "Search codebase",
            placeHolder: "Describe what you are looking for...",
        });
        if (!query) return;

        try {
            const ctx = await ContextService.getInstance().getContext();
            const results = await ctx.searchRaw(query);
            if (!results.length) {
                vscode.window.showInformationMessage("No results found.");
                return;
            }

            const items = results.slice(0, 15).map((r: any) => ({
                label: r.chunk.path,
                description: "L" + r.chunk.startLine + "-" + r.chunk.endLine + " (" + (r.score * 100).toFixed(1) + "%)",
                detail: r.chunk.contents.split("\n").slice(0, 3).join("  ").trim(),
            }));

            await vscode.window.showQuickPick(items, { title: "Search Results" });
        } catch (err: any) {
            vscode.window.showErrorMessage("Search failed: " + err.message);
        }
    }
}
