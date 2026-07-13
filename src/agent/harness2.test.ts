import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContextAgent } from "./agent";
import { AgentMessage, StreamEvent, ToolDefinition } from "./types";
import { LLMCaller, LLMResponse } from "./providers";
import { AgentPlan, planTool } from "./plan";
import { PermissionManager, describeToolCall } from "./permissions";
import { delegateTool } from "./delegate";
import { collectEnvironment, renderEnvironment } from "./env";
import { SessionStore } from "./session-store";
import { splitForCompaction, renderTranscript } from "./utils";

/** Second-wave harness features: plan, permissions, delegation, environment,
 *  sessions, and summarizing compaction. */

function scripted(responses: LLMResponse[], onCall?: (messages: AgentMessage[], system: string) => void): LLMCaller {
  const queue = [...responses];
  return {
    call: async (messages, _tools, system): Promise<LLMResponse> => {
      onCall?.(messages, system);
      const next = queue.shift();
      if (!next) throw new Error("scripted caller exhausted");
      return next;
    },
  };
}

function agentWith(caller: LLMCaller, tools: ToolDefinition[], extra: Partial<ConstructorParameters<typeof ContextAgent>[0]> = {}): ContextAgent {
  const router = { getCallerForQuery: () => ({ caller, tier: { name: "standard", provider: "custom", model: "scripted" } }) } as any;
  return new ContextAgent({ provider: "custom", model: "scripted", tools, router, ...extra });
}

const final = (text = "done"): LLMResponse => ({ text, toolCalls: [], stopReason: "stop" });
const calls = (cs: { id: string; name: string; arguments?: any }[]): LLMResponse =>
  ({ text: "", toolCalls: cs.map(c => ({ id: c.id, name: c.name, arguments: c.arguments ?? {} })), stopReason: "tool_use" });

describe("AgentPlan + planTool", () => {
  it("replaces the plan, notifies listeners, and renders a checklist", async () => {
    const plan = new AgentPlan();
    const seen: any[] = [];
    plan.onUpdate(steps => seen.push(steps));
    const tool = planTool(plan);
    const out = await tool.handler({
      steps: [
        { step: "find the bug", status: "completed" },
        { step: "fix it", status: "in_progress" },
        { step: "add a test", status: "pending" },
      ],
    });
    expect(out).toContain("[x] find the bug");
    expect(out).toContain("[~] fix it");
    expect(out).toContain("[ ] add a test");
    expect(seen).toHaveLength(1);
    expect(plan.getSteps()[1].status).toBe("in_progress");
  });

  it("normalizes junk statuses to pending", async () => {
    const plan = new AgentPlan();
    await planTool(plan).handler({ steps: [{ step: "x", status: "bogus" }] });
    expect(plan.getSteps()[0].status).toBe("pending");
  });
});

describe("PermissionManager", () => {
  const editCall = { id: "1", name: "str-replace", arguments: { path: "a.ts", old_str: "x", new_str: "y" } };
  const shellCall = { id: "2", name: "run-command", arguments: { command: "rm -rf /tmp/x" } };
  const readCall = { id: "3", name: "codebase-retrieval", arguments: {} };

  function manager(mode: "suggest" | "auto-edit" | "full-auto", decisions: ("allow" | "always" | "deny")[]) {
    const asked: string[] = [];
    const pm = new PermissionManager({
      mode,
      ask: async (req) => { asked.push(req.title); return decisions.shift() ?? "deny"; },
    });
    pm.registerMutatingTools(["str-replace", "create-file", "remove-file", "run-command"]);
    return { pm, asked };
  }

  it("suggest mode asks for every mutating call, never for reads", async () => {
    const { pm, asked } = manager("suggest", ["allow", "deny"]);
    expect((await pm.check(editCall)).behavior).toBe("allow");
    expect((await pm.check(shellCall)).behavior).toBe("deny");
    expect((await pm.check(readCall)).behavior).toBe("allow");
    expect(asked).toHaveLength(2);
  });

  it("auto-edit mode auto-approves edits but asks for shell", async () => {
    const { pm, asked } = manager("auto-edit", ["allow"]);
    expect((await pm.check(editCall)).behavior).toBe("allow");
    expect(asked).toHaveLength(0);
    await pm.check(shellCall);
    expect(asked).toHaveLength(1);
  });

  it("full-auto never asks", async () => {
    const { pm, asked } = manager("full-auto", []);
    expect((await pm.check(shellCall)).behavior).toBe("allow");
    expect(asked).toHaveLength(0);
  });

  it("'always' persists for the tool within the session", async () => {
    const { pm, asked } = manager("suggest", ["always"]);
    expect((await pm.check(editCall)).behavior).toBe("allow");
    expect((await pm.check(editCall)).behavior).toBe("allow"); // no second ask
    expect(asked).toHaveLength(1);
  });

  it("denies mutating calls when no approver is attached", async () => {
    const pm = new PermissionManager({ mode: "suggest" });
    pm.registerMutatingTools(["run-command"]);
    const d = await pm.check(shellCall);
    expect(d.behavior).toBe("deny");
    expect((d as any).reason).toMatch(/approval/);
  });

  it("integrates with the agent through asHooks", async () => {
    const pm = new PermissionManager({ mode: "suggest", ask: async () => "deny" });
    pm.registerMutatingTools(["danger"]);
    let ran = false;
    const tool: ToolDefinition = { name: "danger", description: "d", parameters: {}, mutates: true, handler: async () => { ran = true; return "boom"; } };
    const agent = agentWith(scripted([calls([{ id: "1", name: "danger" }]), final()]), [tool], { hooks: pm.asHooks() });
    await agent.run("q");
    expect(ran).toBe(false);
    expect(agent.getMessages().find(m => m.role === "tool")?.content).toMatch(/declined/);
  });

  it("describeToolCall renders a diff preview for edits and the command for shell", () => {
    const edit = describeToolCall(editCall as any);
    expect(edit.title).toBe("edit a.ts");
    expect(edit.preview).toContain("-x");
    expect(edit.preview).toContain("+y");
    const shell = describeToolCall(shellCall as any);
    expect(shell.preview).toContain("$ rm -rf /tmp/x");
  });
});

describe("delegateTool", () => {
  it("runs the child and returns its final answer", async () => {
    const child = { run: async (task: string) => `report about: ${task}` };
    const tool = delegateTool({ makeAgent: () => child });
    expect(await tool.handler({ task: "map auth" })).toBe("report about: map auth");
  });

  it("truncates oversized child answers and survives child crashes", async () => {
    const big = delegateTool({ makeAgent: () => ({ run: async () => "x".repeat(10_000) }), maxResultChars: 100 });
    expect((await big.handler({ task: "t" })).length).toBeLessThan(200);
    const boom = delegateTool({ makeAgent: () => ({ run: async () => { throw new Error("child died"); } }) });
    expect(await boom.handler({ task: "t" })).toContain("child died");
  });

  it("is available to the model end-to-end via defaultAgentTools wiring", async () => {
    const childAnswer = "the auth flow starts in src/auth.ts";
    const tool = delegateTool({ makeAgent: () => ({ run: async () => childAnswer }) });
    const agent = agentWith(scripted([calls([{ id: "1", name: "delegate", arguments: { task: "map the auth flow" } }]), final("summary")]), [tool]);
    await agent.run("how does auth work?");
    expect(agent.getMessages().find(m => m.role === "tool")?.content).toBe(childAnswer);
  });
});

describe("environment context", () => {
  it("collects platform + git facts and renders a block", () => {
    const info = collectEnvironment(process.cwd(), { chunks: 42, searchMode: "hybrid" });
    expect(info.platform).toContain(process.platform);
    expect(info.nodeVersion).toBe(process.version);
    const block = renderEnvironment(info);
    expect(block).toContain("## Environment");
    expect(block).toContain("42 chunks");
  });

  it("reaches the system prompt via environmentProvider", async () => {
    const systems: string[] = [];
    const caller = scripted([final()], (_m, system) => systems.push(system));
    const agent = agentWith(caller, [], { environmentProvider: () => "## Environment\n- Planet: earth" });
    await agent.run("q");
    expect(systems[0]).toContain("Planet: earth");
  });
});

describe("SessionStore", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-sess-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("saves, lists (newest first), loads, and resumes into an agent", async () => {
    const store = new SessionStore(dir);
    const agent = agentWith(scripted([{ ...final("hello"), usage: { inputTokens: 3, outputTokens: 5 } }]), []);
    await agent.run("hi there");
    const id = store.newId();
    store.save(id, "hi there", agent.exportSession(), 1);
    await new Promise(r => setTimeout(r, 10)); // distinct updatedAt for ordering
    store.save(store.newId(), "second", agentWith(scripted([final()]), []).exportSession(), 0);

    const metas = store.list();
    expect(metas).toHaveLength(2);
    expect(metas[0].title).toBe("second"); // newest first

    const loaded = store.load(id)!;
    const resumed = agentWith(scripted([final("again")]), []);
    resumed.importSession(loaded.session);
    expect(resumed.getMessages().map(m => m.role)).toEqual(["user", "assistant"]);
    expect(resumed.getTotalUsage()).toEqual({ inputTokens: 3, outputTokens: 5 });
  });

  it("latest() returns the most recent, remove() deletes", () => {
    const store = new SessionStore(dir);
    const a = store.newId();
    store.save(a, "a", JSON.stringify({ version: 1, messages: [] }), 0);
    expect(store.latest()?.id).toBe(a);
    expect(store.remove(a)).toBe(true);
    expect(store.latest()).toBeNull();
  });
});

describe("summarizing compaction", () => {
  function longHistory(turns: number): AgentMessage[] {
    const msgs: AgentMessage[] = [{ role: "user", content: "original task: refactor the retriever" }];
    for (let i = 0; i < turns; i++) {
      msgs.push({ role: "assistant", content: `working on part ${i} ` + "detail ".repeat(200) });
      msgs.push({ role: "user", content: `feedback ${i} ` + "notes ".repeat(200) });
    }
    return msgs;
  }

  it("splitForCompaction keeps the first user message and a bounded tail", () => {
    const msgs = longHistory(10);
    const { firstUser, middle, tail } = splitForCompaction(msgs, 500);
    expect(firstUser?.content).toContain("original task");
    expect(middle.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
    expect(middle.length + tail.length).toBe(msgs.length - 1);
  });

  it("renderTranscript clips tool dumps", () => {
    const t = renderTranscript([
      { role: "tool", content: "y".repeat(5000), toolName: "read-file", toolCallId: "1" },
    ], 100);
    expect(t.length).toBeLessThan(300);
    expect(t).toContain("…");
  });

  it("compacts over-budget history into a context note via the model", async () => {
    // Caller 1st response = the summary; 2nd = the actual answer.
    const systems: string[] = [];
    const caller = scripted([
      final("SUMMARY-NOTE: refactor decisions so far"),
      final("real answer"),
    ], (_m, system) => systems.push(system));
    const agent = agentWith(caller, [], { historyTokenBudget: 800, compaction: "summarize" });
    agent.loadMessages(longHistory(8));

    const events: StreamEvent[] = [];
    const answer = await agent.run("continue", { onStream: e => events.push(e) });
    expect(answer).toBe("real answer");

    const compacted = events.find(e => e.type === "history_compacted");
    expect(compacted?.summarized).toBe(true);
    expect(compacted?.droppedMessages).toBeGreaterThan(0);
    const note = agent.getMessages().find(m => m.content.includes("[Context note"));
    expect(note?.content).toContain("SUMMARY-NOTE");
    // The summarizer was steered by the compression system prompt.
    expect(systems[0]).toContain("compress conversation history");
  });

  it("falls back to drop-oldest when the summarizer fails", async () => {
    let callNum = 0;
    const caller: LLMCaller = {
      call: async () => {
        callNum++;
        if (callNum === 1) throw new Error("summarizer down");
        return final("answer");
      },
    };
    const agent = agentWith(caller, [], { historyTokenBudget: 800, compaction: "summarize", maxRetries: 0 });
    agent.loadMessages(longHistory(8));
    const events: StreamEvent[] = [];
    const answer = await agent.run("continue", { onStream: e => events.push(e) });
    expect(answer).toBe("answer");
    const compacted = events.find(e => e.type === "history_compacted");
    expect(compacted?.summarized).toBe(false);
  });

  it("compaction: 'drop' preserves the legacy behavior (no extra LLM call)", async () => {
    let llmCalls = 0;
    const caller: LLMCaller = { call: async () => { llmCalls++; return final("ok"); } };
    const agent = agentWith(caller, [], { historyTokenBudget: 800, compaction: "drop" });
    agent.loadMessages(longHistory(8));
    await agent.run("continue");
    expect(llmCalls).toBe(1);
  });

  it("manual compact() summarizes on demand", async () => {
    const caller = scripted([final("condensed note")]);
    const agent = agentWith(caller, [], { compaction: "summarize" });
    agent.loadMessages(longHistory(6));
    const result = await agent.compact();
    expect(result.summarized).toBe(true);
    expect(agent.getMessages().some(m => m.content.includes("condensed note"))).toBe(true);
  });
});
