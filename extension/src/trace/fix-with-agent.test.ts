import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { cleanTerminalOutput, diagnosticPrompt, FIX_COMMAND, FixCodeActionProvider, terminalPrompt, terminalSelection } from "./fix-with-agent";

const pos = (line: number, character = 0) => new vscode.Position(line, character);
const diag = (message: string, severity: number, line = 2) =>
    ({ message, severity, source: "ts", code: 2322, range: new vscode.Range(pos(line, 4), pos(line, 9)) }) as any;

beforeEach(() => {
    vscode.workspace._config = new Map();
    vscode.commands._calls = [];
    vscode.commands._handlers = new Map();
});

describe("diagnosticPrompt", () => {
    it("carries the problem, where it is, and the code around it — and reads short in the transcript", () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
        const { text, label } = diagnosticPrompt({
            relPath: "src/auth/jwt.ts", languageId: "typescript", lines,
            diagnostic: { message: "Type 'string' is not assignable to type 'number'.", severity: "error", source: "ts", code: "2322", line: 14, character: 6 },
        });
        expect(text).toContain("Fix this error at `src/auth/jwt.ts:15:7` (ts 2322):");
        expect(text).toContain("```typescript");
        expect(text).toContain("15> line 15"); // the problem line is marked
        expect(text).toContain(" 7  line 7");
        expect(text).not.toContain("line 6\n");
        expect(text).toContain("line 23");
        expect(label).toBe("Fix: Type 'string' is not assignable to type 'number'. (jwt.ts:15)");
    });
});

describe("terminalPrompt", () => {
    it("quotes the failed command, its exit code, and the tail of its output", () => {
        const { text, label } = terminalPrompt({ commandLine: "npm test", exitCode: 1, cwd: "/repo", output: "\x1b[31mFAIL\x1b[0m src/a.test.ts\n  expected 2, got 3" });
        expect(text).toContain("This command failed with exit code 1 (in `/repo`):");
        expect(text).toContain("```sh\nnpm test\n```");
        expect(text).toContain("FAIL src/a.test.ts");
        expect(text).not.toContain("\x1b");
        expect(label).toBe("Fix failed command: npm test (exit 1)");
    });

    it("works from a bare selection", () => {
        const { text, label } = terminalPrompt({ output: "Error: Cannot find module 'zod'\n    at require" });
        expect(text.startsWith("Explain this terminal output and fix what caused it:")).toBe(true);
        expect(label).toBe("Fix from terminal: Error: Cannot find module 'zod'");
    });
});

describe("cleanTerminalOutput", () => {
    it("drops colour codes and shell-integration markers, and keeps a progress bar's last frame", () => {
        const raw = "\x1b]633;C\x07\x1b[1mbuild\x1b[22m\r\n10%\r50%\r100% done\r\n\x1b]633;D;1\x07";
        expect(cleanTerminalOutput(raw)).toBe("build\n100% done");
    });
});

describe("FixCodeActionProvider", () => {
    const doc = { uri: vscode.Uri.file("/repo/a.ts") } as any;

    it("offers one fix, for the most severe problem under the cursor", () => {
        const actions = new FixCodeActionProvider().provideCodeActions(doc, {} as any, {
            diagnostics: [diag("unused variable", vscode.DiagnosticSeverity.Warning), diag("type error", vscode.DiagnosticSeverity.Error)],
        } as any);
        expect(actions).toHaveLength(1);
        expect(actions[0].title).toBe("Fix with Open Context agent");
        expect(actions[0].command).toMatchObject({
            command: FIX_COMMAND,
            arguments: [doc.uri, { message: "type error", severity: "error", source: "ts", code: "2322", line: 2, character: 4 }],
        });
    });

    it("stays out of the light bulb for hints, or when turned off", () => {
        const provider = new FixCodeActionProvider();
        expect(provider.provideCodeActions(doc, {} as any, { diagnostics: [diag("consider const", vscode.DiagnosticSeverity.Hint)] } as any)).toEqual([]);
        vscode.workspace._config.set("agent.quickFix.enabled", false);
        expect(provider.provideCodeActions(doc, {} as any, { diagnostics: [diag("type error", vscode.DiagnosticSeverity.Error)] } as any)).toEqual([]);
    });
});

describe("terminalSelection", () => {
    it("reads the selection through the clipboard and puts the clipboard back", async () => {
        vscode.env.clipboard._text = "what the user had copied";
        vscode.commands._handlers.set("workbench.action.terminal.copySelection", () => { vscode.env.clipboard._text = "TypeError: x is undefined"; });
        expect(await terminalSelection()).toBe("TypeError: x is undefined");
        expect(vscode.env.clipboard._text).toBe("what the user had copied");
    });

    it("tells no selection apart from one that equals the clipboard", async () => {
        vscode.env.clipboard._text = "same";
        expect(await terminalSelection()).toBe(""); // copySelection did nothing
        expect(vscode.env.clipboard._text).toBe("same");
    });
});
