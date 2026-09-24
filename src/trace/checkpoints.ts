/**
 * Checkpoints — the audit hash chain as a navigable timeline.
 *
 * The chain already exists and is tamper-evident (core/audit.ts). This layer
 * makes each link a place you can go back to, which turns the spine from a
 * decoration into the primary navigation axis: you move through the session by
 * time, not by file.
 *
 * Rewind needs no filesystem snapshots. Every EditProposal already carries the
 * WHOLE `oldContents` and `newContents` of the file it touched (see
 * agent/edit-tools.ts), so a checkpoint is just the list of edits made since
 * the previous one, and rewinding is applying their inverses newest-first.
 * Nothing is copied, nothing is stored twice, and git is never touched — which
 * matters, because a harness that stashes or commits behind your back is a
 * harness you cannot trust with a dirty tree.
 *
 * Safety: an edit is only undone if the file still holds what the agent wrote.
 * If you changed it yourself in the meantime, that file is reported as skipped
 * rather than clobbered.
 */

import { EditApplier } from "../agent/edit-tools";
import { EditProposal } from "../agent/types";
import { Checkpoint } from "./protocol";

export interface CheckpointRecord extends Checkpoint {
  /** Edits made during the turn that ENDED at this checkpoint. */
  edits: EditProposal[];
}

export interface RewindResult {
  toHash: string;
  /** Checkpoints unwound, newest-first. */
  checkpointsDropped: number;
  filesRestored: string[];
  /** Files left alone because they no longer matched what the agent wrote. */
  filesSkipped: { path: string; reason: string }[];
  /** Turn number the session is now at. */
  turn: number;
}

export interface CheckpointStoreOptions {
  applier: EditApplier;
  /** Called after a rewind so the index reflects the restored files. */
  onRestored?: (paths: string[]) => void | Promise<void>;
}

export class CheckpointStore {
  private checkpoints: CheckpointRecord[] = [];
  private pending: EditProposal[] = [];

  constructor(private opts: CheckpointStoreOptions) {}

  /** Record an edit against the turn currently in flight. */
  noteEdit(edit: EditProposal): void {
    this.pending.push(edit);
  }

  /**
   * Close a turn at an audit-chain position. `hash`/`prev`/`seq` come straight
   * from the AuditLogger; when auditing is off, pass a synthetic chain and mark
   * the checkpoint non-restorable rather than inventing a hash that implies
   * tamper-evidence the session does not have.
   */
  commit(input: { seq: number; hash: string; prev: string; label: string; turn: number; ts?: string }): CheckpointRecord {
    const edits = this.pending;
    this.pending = [];
    const record: CheckpointRecord = {
      seq: input.seq,
      hash: input.hash,
      prev: input.prev,
      short: input.hash.slice(0, 4) || String(input.seq),
      ts: input.ts ?? new Date().toISOString(),
      label: input.label,
      turn: input.turn,
      filesTouched: new Set(edits.map(e => e.path)).size,
      restorable: edits.length > 0,
      edits,
    };
    this.checkpoints.push(record);
    return record;
  }

  list(): Checkpoint[] {
    return this.checkpoints.map(({ edits: _edits, ...c }) => c);
  }

  get(hash: string): CheckpointRecord | undefined {
    return this.checkpoints.find(c => c.hash === hash);
  }

  /**
   * Undo every edit made AFTER the given checkpoint, newest-first so that
   * repeated edits to one file unwind in the right order and the file lands on
   * the contents it had when that checkpoint was taken.
   */
  async rewindTo(hash: string): Promise<RewindResult> {
    const index = this.checkpoints.findIndex(c => c.hash === hash);
    if (index === -1) throw new Error(`No checkpoint ${hash.slice(0, 8)} in this session.`);

    const dropped = this.checkpoints.slice(index + 1);
    // Edits made in the turn currently in flight are unwound too — a rewind
    // mid-turn must not leave half a turn's changes on disk.
    const toUndo = [...dropped.flatMap(c => c.edits), ...this.pending].reverse();

    const filesRestored: string[] = [];
    const filesSkipped: RewindResult["filesSkipped"] = [];
    const seen = new Set<string>();

    for (const edit of toUndo) {
      const outcome = await this.undo(edit);
      if (outcome.ok) {
        if (!seen.has(edit.path)) { seen.add(edit.path); filesRestored.push(edit.path); }
      } else if (!seen.has(edit.path)) {
        seen.add(edit.path);
        filesSkipped.push({ path: edit.path, reason: outcome.reason });
      }
    }

    this.checkpoints = this.checkpoints.slice(0, index + 1);
    this.pending = [];
    if (filesRestored.length) await this.opts.onRestored?.(filesRestored);

    return {
      toHash: hash,
      checkpointsDropped: dropped.length,
      filesRestored,
      filesSkipped,
      turn: this.checkpoints[index].turn,
    };
  }

  /** Everything edited since a checkpoint, for "what would rewinding undo?". */
  changedSince(hash: string): string[] {
    const index = this.checkpoints.findIndex(c => c.hash === hash);
    if (index === -1) return [];
    const edits = [...this.checkpoints.slice(index + 1).flatMap(c => c.edits), ...this.pending];
    return [...new Set(edits.map(e => e.path))];
  }

  clear(): void {
    this.checkpoints = [];
    this.pending = [];
  }

  private async undo(edit: EditProposal): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { applier } = this.opts;
    try {
      const current = await applier.readFile(edit.path);
      // Only undo what we still recognise. A file the user edited by hand since
      // is theirs, and silently overwriting it would be the worst thing this
      // feature could do.
      if (edit.kind === "create") {
        if (current === null) return { ok: true };
        if (current !== edit.newContents) return { ok: false, reason: "modified since the agent created it" };
        return (await applier.removeFile(edit.path)) ? { ok: true } : { ok: false, reason: "could not remove" };
      }
      if (edit.kind === "remove") {
        if (current !== null) return { ok: false, reason: "recreated since the agent removed it" };
        await applier.writeFile(edit.path, edit.oldContents ?? "");
        return { ok: true };
      }
      if (current === null) return { ok: false, reason: "file no longer exists" };
      if (current !== edit.newContents) return { ok: false, reason: "modified since the agent edited it" };
      await applier.writeFile(edit.path, edit.oldContents ?? "");
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: String(err?.message ?? err) };
    }
  }
}
