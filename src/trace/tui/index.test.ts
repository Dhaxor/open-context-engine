import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { ContextAgent } from "../../agent/agent";
import { AgentPlan } from "../../agent/plan";
import { PermissionManager } from "../../agent/permissions";
import { EditApplier } from "../../agent/edit-tools";
import { AgentMessage, AgentRunOptions, StreamEvent } from "../../agent/types";
import { CheckpointStore } from "../checkpoints";
import { ContextLedger } from "../ledger";
import { SessionMeta } from "../protocol";
import { TraceSession } from "../session";
import { runTui } from "./index";
import { Theme, stripAnsi } from "./theme";

// Control bytes as escapes, never as literal characters: an invisible byte in
// a test is impossible to review and trivially lost to an edit.
const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const CTRL_R = String.fromCharCode(18);
const BACKSPACE = String.fromCharCode(127);

class FakeOut extends EventEmitter {
  written: string[] = [];
  columns = 110;
  rows = 26;
  isTTY = true;
  write(s: string): boolean { this.written.push(s); return true; }
  get text(): string { return stripAnsi(this.written.join("")); }
  get raw(): string { return this.written.join(""); }
}

class FakeIn extends EventEmitter {
  isTTY = true;
  raw = false;
  setRawMode(v: boolean): this { this.raw = v; return this; }
  resume(): this { return this; }
  pause(): this { return this; }
  /** Deliver keystrokes the way a terminal does. */
  type(s: string): void { this.emit("data", Buffer.from(s, "utf8")); }
}

class StubAgent {
  messages: AgentMessage[] = [];
  script: (emit: (e: StreamEvent) => void, signal?: AbortSignal) => Promise<void> = async () => {};
  async run(query: string, opts: AgentRunOptions = {}): Promise<string> {
    this.messages.push({ role: "user", content: query });
    await this.script(e => opts.onStream?.(e), opts.signal);
    if (opts.signal?.aborted) throw new Error("aborted");
    return "done";
  }
  getMessages(): readonly AgentMessage[] { return this.messages; }
  loadMessages(m: AgentMessage[]) { this.messages = [...m]; }
  exportSession() { return "{}"; }
  reset() { this.messages = []; }
  async compact() { return { dropped: 0, summarized: false }; }
}

const applier: EditApplier = {
  async readFile() { return null; },
  async writeFile() {},
  async removeFile() { return false; },
  async fileExists() { return false; },
};

const META: Omit<SessionMeta, "turn" | "startedAt" | "mode"> = {
  id: "s1", title: "t", workspace: "/home/dev/demo", provider: "anthropic", model: "claude-opus-5",
  windowTokens: 200_000, indexedChunks: 4812, searchMode: "hybrid", indexFresh: true, auditing: false,
};

function harness(opts: { columns?: number } = {}) {
  const agent = new StubAgent();
  const permissions = new PermissionManager({ mode: "suggest" });
  const session = new TraceSession({
    id: "s1",
    agent: agent as unknown as ContextAgent,
    plan: new AgentPlan(),
    permissions,
    ledger: new ContextLedger({ windowTokens: 200_000, systemPrompt: () => "", toolSchemas: () => [] }),
    checkpoints: new CheckpointStore({ applier }),
    meta: META,
  });
  const out = new FakeOut();
  // Set before the first paint: the very first frame must already be at the
  // size under test, or the assertion sees the initial wide frame too.
  if (opts.columns !== undefined) out.columns = opts.columns;
  const input = new FakeIn();
  const finished = runTui({
    session,
    out: out as unknown as NodeJS.WriteStream,
    input: input as unknown as NodeJS.ReadStream,
    theme: new Theme({ mono: true }),
  });
  return { agent, permissions, session, out, input, finished };
}

const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

describe("runTui", () => {
  it("takes the alternate buffer and paints the session immediately", async () => {
    const { out, input, finished } = harness();
    await settle();
    expect(out.raw).toContain(`${ESC}[?1049h`);
    expect(out.text).toContain("trace");
    expect(out.text).toContain("demo");
    input.type(CTRL_D);
    await finished;
  });

  it("restores the terminal on exit", async () => {
    const { out, input, finished } = harness();
    await settle();
    input.type(CTRL_D);
    await finished;
    expect(out.raw).toContain(`${ESC}[?25h`);
    expect(out.raw).toContain(`${ESC}[?1049l`);
    expect(input.raw).toBe(false);
  });

  it("echoes typing and sends the prompt on Enter", async () => {
    const { agent, out, input, finished } = harness();
    await settle();
    input.type("why");
    await settle();
    expect(out.text).toContain("why");

    input.type("\r");
    await settle();
    expect(agent.messages.map(m => m.content)).toContain("why");
    input.type(CTRL_D);
    await finished;
  });

  it("backspace edits the composer", async () => {
    const { agent, input, finished } = harness();
    await settle();
    input.type("abc");
    input.type(BACKSPACE);
    input.type("\r");
    await settle();
    expect(agent.messages[0].content).toBe("ab");
    input.type(CTRL_D);
    await finished;
  });

  it("renders streamed output as it arrives", async () => {
    const { agent, out, input, finished } = harness();
    agent.script = async emit => {
      emit({ type: "text", text: "Because sqlite-vec failed to load." });
    };
    await settle();
    input.type("why\r");
    await settle(120);
    expect(out.text).toContain("Because sqlite-vec failed to load.");
    input.type(CTRL_D);
    await finished;
  });

  it("interrupts a running turn with Ctrl+C rather than quitting", async () => {
    const { agent, session, input, finished } = harness();
    agent.script = (_emit, signal) => new Promise<void>(resolve => {
      signal?.addEventListener("abort", () => resolve());
    });
    await settle();
    input.type("long\r");
    await settle();
    expect(session.isRunning()).toBe(true);

    input.type(CTRL_C);
    await settle(80);
    expect(session.isRunning()).toBe(false);
    // Still alive: one Ctrl+C interrupts the run, it does not exit the app.
    input.type(CTRL_D);
    await finished;
  });

  it("answers a pending approval from the keyboard", async () => {
    const { permissions, input, finished } = harness();
    permissions.registerMutatingTools(["str-replace"]);
    await settle();

    const decision = permissions.check({
      id: "t1", name: "str-replace",
      arguments: { path: "a.ts", old_str: "a", new_str: "b" },
    });
    await settle();
    input.type("y");
    await settle();
    expect(await decision).toMatchObject({ behavior: "allow" });

    input.type(CTRL_D);
    await finished;
  });

  it("does not let approval keys swallow composer input", async () => {
    const { agent, permissions, input, finished } = harness();
    permissions.registerMutatingTools(["str-replace"]);
    await settle();
    void permissions.check({ id: "t1", name: "str-replace", arguments: { path: "a.ts", old_str: "a", new_str: "b" } });
    await settle();

    // With text already typed, y/a/n are characters — not decisions.
    input.type("m");
    input.type("y");
    input.type("\r");
    await settle();
    expect(agent.messages.map(m => m.content)).toContain("my");
    input.type(CTRL_D);
    await finished;
  });

  it("toggles the rail with ctrl+r on a narrow terminal", async () => {
    const { out, input, finished } = harness({ columns: 80 });
    await settle();
    expect(out.text).not.toContain("in the window now");

    input.type(CTRL_R);
    await settle();
    expect(out.text).toContain("in the window now");
    input.type(CTRL_D);
    await finished;
  });

  it("repaints everything on resize", async () => {
    const { out, input, finished } = harness();
    await settle();
    out.written = [];
    out.columns = 90;
    out.emit("resize");
    await settle();
    // A resize discards the frame cache, so the whole screen is rewritten —
    // the same path that repairs any stray artifact.
    expect(out.raw).toContain(`${ESC}[2J`);
    input.type(CTRL_D);
    await finished;
  });

  it("handles slash commands without sending them to the model", async () => {
    const { agent, permissions, input, finished } = harness();
    await settle();
    input.type("/mode full-auto\r");
    await settle();
    expect(permissions.getMode()).toBe("full-auto");
    expect(agent.messages).toHaveLength(0);

    input.type("/exit\r");
    await finished;
  });

  it("runs a !command through the session instead of the model", async () => {
    const { agent, session, input, finished } = harness();
    let ran = "";
    (session as any).opts.runCommand = async (c: string) => { ran = c; return "3 passed"; };
    session.setMode("full-auto");
    await settle();

    input.type("!npm test\r");
    await settle(120);
    expect(ran).toBe("npm test");
    // It is a command, not a question — the model must not be prompted with it.
    expect(agent.messages).toHaveLength(0);
    input.type(CTRL_D);
    await finished;
  });

  it("offers file completions for @ and inserts the choice", async () => {
    const { agent, session, out, input, finished } = harness();
    (session as any).opts.listFiles = () => ["src/core/retriever.ts", "src/cli/index.ts"];
    (session as any).opts.readFile = async () => "contents";
    await settle();

    input.type("look at @retr");
    await settle();
    expect(out.text).toContain("src/core/retriever.ts");

    input.type("\t");
    await settle();
    input.type("\r");
    await settle(80);
    expect(agent.messages[0].content).toBe("look at @src/core/retriever.ts");
    input.type(CTRL_D);
    await finished;
  });

  it("shows the command menu for / and completes on Tab", async () => {
    const { out, input, finished, permissions } = harness();
    await settle();
    input.type("/mo");
    await settle();
    expect(out.text).toContain("mode");

    input.type("\t");
    await settle();
    input.type("full-auto\r");
    await settle(80);
    expect(permissions.getMode()).toBe("full-auto");
    input.type(CTRL_D);
    await finished;
  });

  it("submits on Enter when the highlighted entry is already typed", async () => {
    const { agent, input, finished } = harness();
    await settle();
    // "/reset" is complete; requiring a second Enter would be maddening.
    input.type("/reset\r");
    await settle(80);
    expect(agent.messages).toHaveLength(0);
    input.type(CTRL_D);
    await finished;
  });

  it("ignores an empty submit", async () => {
    const { agent, input, finished } = harness();
    await settle();
    input.type("   \r");
    await settle();
    expect(agent.messages).toHaveLength(0);
    input.type(CTRL_D);
    await finished;
  });
});
