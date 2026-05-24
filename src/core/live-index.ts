import { OpenContext, ProgressCb } from "./context";
import { OpenContextConfig, IndexingResult } from "./types";
import { FileWatcher } from "./file-watcher";

export interface LiveIndexOptions {
  /** Keep the index live by watching the workspace for changes. Defaults to true. */
  watch?: boolean;
  /** Debounce window for batching filesystem changes before re-indexing. */
  debounceMs?: number;
  onProgress?: ProgressCb;
  onReindex?: (result: IndexingResult) => void;
  onError?: (err: Error) => void;
}

export interface LiveIndexHandle {
  context: OpenContext;
  watcher: FileWatcher | null;
  /** Result of the initial incremental index run. */
  initialIndex: IndexingResult;
  stop(): Promise<void>;
}

/**
 * Bring an existing context's index up to date, then (optionally) keep it live.
 *
 * Runs an incremental index — which behaves as a full index when the store is
 * empty — and then attaches a debounced FileWatcher so edits, creations, and
 * deletions are reflected without a manual re-index.
 */
export async function liveIndex(
  context: OpenContext,
  config: OpenContextConfig,
  opts: LiveIndexOptions = {},
): Promise<{ result: IndexingResult; watcher: FileWatcher | null }> {
  const result = await context.incrementalIndex(opts.onProgress);
  if (opts.watch === false) return { result, watcher: null };
  const watcher = new FileWatcher(context, config, opts.debounceMs);
  await watcher.start({ onReindex: opts.onReindex, onError: opts.onError });
  return { result, watcher };
}

/**
 * Create a context, index the workspace, and keep it live. The returned handle
 * owns both the context and the watcher; call stop() to release them.
 */
export async function createLiveContext(
  config: OpenContextConfig,
  opts: LiveIndexOptions = {},
): Promise<LiveIndexHandle> {
  const context = await OpenContext.create(config);
  try {
    const { result, watcher } = await liveIndex(context, config, opts);
    return {
      context,
      watcher,
      initialIndex: result,
      stop: async () => {
        await watcher?.stop();
        context.close();
      },
    };
  } catch (err) {
    context.close();
    throw err;
  }
}
