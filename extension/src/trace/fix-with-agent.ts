import * as path from "path";
import * as vscode from "vscode";

/**
 * "Fix with agent" from where the problem shows up: a squiggle in the editor
 * (a quick fix on the diagnostic) or a command that failed in the terminal.
 *
 * Each becomes an ordinary agent turn — streamed, with its retrievals and
 * edits visible, saved, rewindable — whose prompt carries the evidence (the
 * diagnostic and the code around it, or the command and its output) and whose
 * transcript shows a short label instead of that wall of text.
 */

export interface FixPrompt {
    /** What the model is sent. */
    text: string;
    /** What the transcript shows. */
    label: string;
}

export interface DiagnosticInfo {
    message: string;
    severity: "error" | "warning";
    source?: string;
    code?: string;
    /** 0-based, as VS Code reports it. */
    line: number;
    character: number;
}

const SNIPPET_RADIUS = 8;
const MAX_OUTPUT_CHARS = 12_000;

export function diagnosticPrompt(input: { relPath: string; languageId: string; lines: string[]; diagnostic: DiagnosticInfo }): FixPrompt {
    const { relPath, diagnostic: d } = input;
    const from = Math.max(0, d.line - SNIPPET_RADIUS);
    const to = Math.min(input.lines.length, d.line + SNIPPET_RADIUS + 1);
    const width = String(to).length;
    const snippet = input.lines.slice(from, to)
        .map((text, i) => `${String(from + i + 1).padStart(width)}${from + i === d.line ? ">" : " "} ${text}`)
        .join("\n");
    const origin = [d.source, d.code].filter(Boolean).join(" ");
    const where = `${relPath}:${d.line + 1}:${d.character + 1}`;
    const text = [
        `Fix this ${d.severity} at \`${where}\`${origin ? ` (${origin})` : ""}:`,
        "",
        d.message,
        "",
        "```" + (input.languageId || ""),
        snippet,
        "```",
        "",
        "Find the actual cause — it may be in another file — make the smallest correct change, and say what you changed and why.",
    ].join("\n");
    return { text, label: `Fix: ${firstLine(d.message, 70)} (${path.basename(relPath)}:${d.line + 1})` };
}

export function terminalPrompt(input: { commandLine?: string; exitCode?: number; cwd?: string; output: string }): FixPrompt {
    const output = tail(cleanTerminalOutput(input.output), MAX_OUTPUT_CHARS);
    const command = input.commandLine?.trim();
    const text = [
        command
            ? `This command failed${input.exitCode !== undefined ? ` with exit code ${input.exitCode}` : ""}${input.cwd ? ` (in \`${input.cwd}\`)` : ""}:`
            : "Explain this terminal output and fix what caused it:",
        ...(command ? ["", "```sh", command, "```", "", "Its output:"] : []),
        "",
        "```",
        output || "(no output was captured)",
        "```",
        "",
        "Find out why it failed. If the cause is in the code, fix it with the smallest correct change; if it is the environment or the command itself, say what to change. Then say how to re-run it.",
    ].join("\n");
    const label = command
        ? `Fix failed command: ${firstLine(command, 60)}${input.exitCode !== undefined ? ` (exit ${input.exitCode})` : ""}`
        : `Fix from terminal: ${firstLine(output, 60) || "selection"}`;
    return { text, label };
}

/** Terminal output as a person read it: no colour codes, no shell-integration
 *  markers, carriage-return redraws (progress bars) collapsed to their last state. */
export function cleanTerminalOutput(raw: string): string {
    const noEscapes = raw
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (titles, VS Code's 633 markers)
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI (colours, cursor moves)
        .replace(/\x1b[@-Z\\-_]/g, ""); // other two-byte escapes
    return noEscapes
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.slice(line.lastIndexOf("\r") + 1))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function firstLine(s: string, max: number): string {
    const line = s.trim().split("\n")[0]?.trim() ?? "";
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function tail(s: string, max: number): string {
    return s.length > max ? `…\n${s.slice(-max)}` : s;
}

// ─── the quick fix ───────────────────────────────────────────────────────────

export const FIX_COMMAND = "openContext.fixWithAgent";

/** One "Fix with agent" entry on the light bulb, for the most severe problem
 *  under the cursor — not one per diagnostic, which would bury the real fixes. */
export class FixCodeActionProvider implements vscode.CodeActionProvider {
    static readonly kinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
        if (!vscode.workspace.getConfiguration("openContext").get<boolean>("agent.quickFix.enabled", true)) return [];
        const target = [...context.diagnostics]
            .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
            .sort((a, b) => a.severity - b.severity)[0];
        if (!target) return [];
        const action = new vscode.CodeAction("Fix with Open Context agent", vscode.CodeActionKind.QuickFix);
        action.diagnostics = [target];
        action.command = { command: FIX_COMMAND, title: "Fix with Open Context agent", arguments: [document.uri, toInfo(target)] };
        return [action];
    }
}

export function toInfo(d: vscode.Diagnostic): DiagnosticInfo {
    const code = typeof d.code === "object" && d.code !== null ? String(d.code.value) : d.code !== undefined ? String(d.code) : undefined;
    return {
        message: d.message,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
        ...(d.source ? { source: d.source } : {}),
        ...(code ? { code } : {}),
        line: d.range.start.line,
        character: d.range.start.character,
    };
}

/** The problem a palette invocation means: the worst one on the cursor's line,
 *  else the worst one in the file. */
export function diagnosticAtCursor(editor: vscode.TextEditor): DiagnosticInfo | undefined {
    const all = vscode.languages.getDiagnostics(editor.document.uri)
        .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
        .sort((a, b) => a.severity - b.severity);
    const line = editor.selection.active.line;
    const here = all.find(d => d.range.start.line <= line && d.range.end.line >= line);
    const d = here ?? all[0];
    return d ? toInfo(d) : undefined;
}

// ─── failed terminal commands ────────────────────────────────────────────────

const MAX_CAPTURE = 64_000;
/** Ctrl+C: the user stopped it, it did not fail. */
const INTERRUPTED = 130;

export interface TerminalFailure {
    commandLine: string;
    exitCode: number;
    cwd?: string;
    /** Read when asked for — the stream may still be draining at exit. */
    output: () => string;
}

/**
 * Remembers the last command that failed in any terminal with shell
 * integration, with the tail of its output. Nothing leaves the machine until
 * you ask the agent about it; nothing pops up when a command fails.
 */
export class TerminalFailures implements vscode.Disposable {
    private buffers = new WeakMap<vscode.TerminalShellExecution, { text: string }>();
    private last: TerminalFailure | null = null;
    private disposables: vscode.Disposable[] = [];

    constructor() {
        const w = vscode.window as Partial<typeof vscode.window>;
        if (!w.onDidStartTerminalShellExecution || !w.onDidEndTerminalShellExecution) return;
        this.disposables.push(
            w.onDidStartTerminalShellExecution(e => this.capture(e.execution)),
            w.onDidEndTerminalShellExecution(e => this.ended(e.execution, e.exitCode)),
        );
    }

    lastFailure(): TerminalFailure | null { return this.last; }

    private capture(execution: vscode.TerminalShellExecution): void {
        const buffer = { text: "" };
        this.buffers.set(execution, buffer);
        void (async () => {
            try {
                for await (const data of execution.read()) {
                    buffer.text += data;
                    if (buffer.text.length > MAX_CAPTURE * 2) buffer.text = buffer.text.slice(-MAX_CAPTURE);
                }
            } catch { /* the terminal closed */ }
        })();
    }

    private ended(execution: vscode.TerminalShellExecution, exitCode: number | undefined): void {
        if (exitCode === undefined || exitCode === 0 || exitCode === INTERRUPTED) return;
        const commandLine = execution.commandLine.value?.trim();
        if (!commandLine) return;
        const buffer = this.buffers.get(execution) ?? { text: "" };
        this.last = {
            commandLine,
            exitCode,
            ...(execution.cwd ? { cwd: execution.cwd.fsPath } : {}),
            output: () => buffer.text.slice(-MAX_CAPTURE),
        };
        void vscode.commands.executeCommand("setContext", "openContext.terminalFailed", true);
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
    }
}

/**
 * The terminal's selected text. The stable API has no `Terminal.selection`,
 * so this copies through the clipboard — and puts back what was there.
 */
export async function terminalSelection(): Promise<string> {
    const previous = await vscode.env.clipboard.readText();
    const sentinel = `oce-no-selection-${Date.now()}`;
    await vscode.env.clipboard.writeText(sentinel);
    try {
        await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
        const copied = await vscode.env.clipboard.readText();
        return copied === sentinel ? "" : copied;
    } finally {
        await vscode.env.clipboard.writeText(previous);
    }
}
