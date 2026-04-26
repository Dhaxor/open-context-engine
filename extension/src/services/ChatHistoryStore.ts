import * as vscode from "vscode";

export interface StoredMessage {
    role: "user" | "assistant";
    text: string;
    ts: number;
}

export interface StoredSession {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    provider?: string;
    model?: string;
    messages: StoredMessage[];
}

export interface SessionSummary {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    provider?: string;
    model?: string;
}

const KEY = "openContext.chatSessions.v1";
const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 200;

export class ChatHistoryStore {
    constructor(private readonly ctx: vscode.ExtensionContext) {}

    list(): SessionSummary[] {
        return this.readAll()
            .map(s => ({
                id: s.id,
                title: s.title,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                messageCount: s.messages.length,
                provider: s.provider,
                model: s.model,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    get(id: string): StoredSession | undefined {
        return this.readAll().find(s => s.id === id);
    }

    create(provider?: string, model?: string): StoredSession {
        const now = Date.now();
        const session: StoredSession = {
            id: "s_" + now.toString(36) + Math.random().toString(36).slice(2, 6),
            title: "New chat",
            createdAt: now,
            updatedAt: now,
            provider,
            model,
            messages: [],
        };
        const all = this.readAll();
        all.unshift(session);
        this.writeAll(all);
        return session;
    }

    appendMessage(id: string, role: "user" | "assistant", text: string): StoredSession | undefined {
        const trimmed = text.trim();
        if (!trimmed) return this.get(id);
        const all = this.readAll();
        const idx = all.findIndex(s => s.id === id);
        if (idx < 0) return undefined;
        const session = all[idx];
        session.messages.push({ role, text: trimmed, ts: Date.now() });
        if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
            session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
        }
        session.updatedAt = Date.now();
        if (session.title === "New chat" && role === "user") {
            session.title = deriveTitle(trimmed);
        }
        all.splice(idx, 1);
        all.unshift(session);
        this.writeAll(all);
        return session;
    }

    updateMeta(id: string, patch: Partial<Pick<StoredSession, "title" | "provider" | "model">>): void {
        const all = this.readAll();
        const idx = all.findIndex(s => s.id === id);
        if (idx < 0) return;
        all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() };
        this.writeAll(all);
    }

    delete(id: string): void {
        const all = this.readAll().filter(s => s.id !== id);
        this.writeAll(all);
    }

    clearAll(): void {
        this.writeAll([]);
    }

    private readAll(): StoredSession[] {
        const raw = this.ctx.workspaceState.get<StoredSession[]>(KEY, []);
        return Array.isArray(raw) ? raw : [];
    }

    private writeAll(sessions: StoredSession[]): void {
        const capped = sessions.slice(0, MAX_SESSIONS);
        void this.ctx.workspaceState.update(KEY, capped);
    }
}

function deriveTitle(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= 60) return oneLine;
    return oneLine.slice(0, 57) + "…";
}
