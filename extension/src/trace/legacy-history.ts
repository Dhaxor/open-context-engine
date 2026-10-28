import type { SessionStore } from "../../../src/agent/session-store";

/**
 * Conversations from the pre-Trace chat sidebar, which kept plain text turns
 * in workspaceState. They are copied once into the SessionStore the agent now
 * uses, so the history panel still lists them and any of them can be resumed.
 * The old entries are left where they were — nothing is deleted.
 */

const LEGACY_KEY = "openContext.chatSessions.v1";
const MIGRATED_KEY = "openContext.trace.legacyChatsMigrated";

interface LegacySession {
    id: string;
    title: string;
    updatedAt: number;
    messages: { role: "user" | "assistant"; text: string }[];
}

interface MementoLike {
    get<T>(key: string, fallback?: T): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface ConvertedSession { id: string; title: string; exported: string; turns: number; updatedAt: string }

/** Legacy sessions in SessionStore's shape: the agent's own export format. */
export function convertLegacy(sessions: unknown): ConvertedSession[] {
    if (!Array.isArray(sessions)) return [];
    const out: ConvertedSession[] = [];
    for (const s of sessions as LegacySession[]) {
        if (!s || typeof s.id !== "string" || !Array.isArray(s.messages)) continue;
        const messages = s.messages
            .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
            .map(m => ({ role: m.role, content: m.text }));
        const turns = messages.filter(m => m.role === "user").length;
        if (!turns) continue;
        out.push({
            id: `chat-${s.id}`,
            title: s.title || "Untitled chat",
            exported: JSON.stringify({ version: 1, messages, totalUsage: { inputTokens: 0, outputTokens: 0 } }),
            turns,
            updatedAt: new Date(Number.isFinite(s.updatedAt) ? s.updatedAt : Date.now()).toISOString(),
        });
    }
    return out;
}

/** Copy the legacy chats into `store`, once per workspace. Returns how many. */
export function migrateLegacyChats(state: MementoLike | undefined, store: SessionStore): number {
    if (!state || state.get<boolean>(MIGRATED_KEY, false)) return 0;
    let copied = 0;
    try {
        const existing = new Set(store.list().map(s => s.id));
        for (const s of convertLegacy(state.get(LEGACY_KEY, []))) {
            if (existing.has(s.id)) continue;
            store.save(s.id, s.title, s.exported, s.turns, s.updatedAt);
            copied++;
        }
    } catch {
        // An unwritable store just means the old chats stay where they were;
        // try again next window rather than marking them done.
        return copied;
    }
    void state.update(MIGRATED_KEY, true);
    return copied;
}
