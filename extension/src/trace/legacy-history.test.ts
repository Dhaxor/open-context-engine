import { describe, expect, it } from "vitest";
import { convertLegacy, migrateLegacyChats } from "./legacy-history";

const legacy = [
    { id: "s_a", title: "Explain auth", createdAt: 1, updatedAt: Date.UTC(2026, 8, 1), messages: [
        { role: "user", text: "Explain auth", ts: 1 },
        { role: "assistant", text: "It lives in src/auth.", ts: 2 },
    ] },
    { id: "s_empty", title: "New chat", createdAt: 1, updatedAt: 1, messages: [] },
];

function memento(initial: Record<string, unknown>) {
    const data = new Map(Object.entries(initial));
    return { data, get: <T>(k: string, f?: T) => (data.has(k) ? data.get(k) as T : f), update: async (k: string, v: unknown) => { data.set(k, v); } };
}

function fakeStore() {
    const saved: any[] = [];
    return { saved, list: () => saved.map(s => ({ id: s[0] })), save: (...args: any[]) => { saved.push(args); } } as any;
}

describe("legacy chat migration", () => {
    it("converts text turns into the agent's export format, skipping empty chats", () => {
        const [s, ...rest] = convertLegacy(legacy);
        expect(rest).toHaveLength(0);
        expect(s).toMatchObject({ id: "chat-s_a", title: "Explain auth", turns: 1, updatedAt: "2026-09-01T00:00:00.000Z" });
        expect(JSON.parse(s.exported)).toEqual({
            version: 1,
            messages: [{ role: "user", content: "Explain auth" }, { role: "assistant", content: "It lives in src/auth." }],
            totalUsage: { inputTokens: 0, outputTokens: 0 },
        });
        expect(convertLegacy("not an array")).toEqual([]);
    });

    it("copies once per workspace and keeps the originals", () => {
        const state = memento({ "openContext.chatSessions.v1": legacy });
        const store = fakeStore();
        expect(migrateLegacyChats(state, store)).toBe(1);
        expect(store.saved[0].slice(0, 2)).toEqual(["chat-s_a", "Explain auth"]);
        expect(migrateLegacyChats(state, store)).toBe(0);
        expect(state.data.get("openContext.chatSessions.v1")).toBe(legacy);
    });
});
