/**
 * Trace in the terminal.
 *
 * Subscribes to the same TraceSession the browser does, folds events through
 * the same view model, and paints with the same tokens. The difference between
 * this and Studio is a renderer — not a second implementation of the product.
 */

import { ApprovalDecision, ApprovalMode } from "../protocol";
import { activeToken, applyCompletion, matchCommands, parseComposer } from "../composer";
import { TraceSession } from "../session";
import { ViewState, initialState, reduce } from "../view-model";
import { renderFrame } from "./frame";
import { Screen, decodeKeys } from "./screen";
import { Theme, themeFor } from "./theme";

const MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];

export interface TuiOptions {
  session: TraceSession;
  out?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  theme?: Theme;
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const theme = opts.theme ?? themeFor(out);
  const screen = new Screen({ out, in: input });
  const { session } = opts;

  let state: ViewState = initialState;
  let text = "";
  let scroll = 0;
  let railOpen = false;
  let completions: string[] = [];
  let selected = 0;
  let exiting = false;
  let lastInterrupt = 0;

  // Repainting per event would repaint ~200 times for one streamed answer.
  // Coalescing to a frame keeps a long answer smooth without dropping the tail.
  let painting: ReturnType<typeof setTimeout> | null = null;
  const paint = (): void => {
    if (painting || exiting) return;
    painting = setTimeout(() => {
      painting = null;
      screen.render(renderFrame(state, screen.size, theme, frameOptions()));
    }, 16);
  };
  const frameOptions = () => ({ scroll, input: text, railOpen, completions, selected });
  const paintNow = (): void => {
    if (painting) { clearTimeout(painting); painting = null; }
    if (!exiting) screen.render(renderFrame(state, screen.size, theme, frameOptions()));
  };

  const unsubscribe = session.subscribe(envelope => {
    state = reduce(state, { type: "event", envelope });
    // New output belongs at the bottom; scrolling back is an explicit act.
    if (envelope.event.type === "turn_start") scroll = 0;
    paint();
  });
  state = reduce(state, { type: "connection", connected: true });

  screen.start();
  paintNow();

  const onResize = (): void => {
    // The cache is discarded so the whole screen repaints. Elsewhere "resize to
    // fix the rendering" is the workaround; here it is the same code path.
    screen.invalidate();
    paintNow();
  };
  out.on("resize", onResize);

  const done = new Promise<void>(resolve => {
    const onData = (chunk: Buffer | string): void => {
      for (const key of decodeKeys(chunk.toString("utf8"))) {
        if (exiting) return;
        handleKey(key);
      }
      paintNow();
    };

    function finish(): void {
      if (exiting) return;
      exiting = true;
      input.off("data", onData);
      out.off("resize", onResize);
      unsubscribe();
      screen.stop();
      resolve();
    }

    function handleKey(key: { name: string; ctrl: boolean; char?: string }): void {
      // Ctrl+C interrupts a run; twice in quick succession quits — the
      // convention every terminal agent has converged on.
      if (key.ctrl && key.name === "c") {
        const now = Date.now();
        if (session.isRunning()) { session.interrupt(); lastInterrupt = now; return; }
        if (now - lastInterrupt < 2000) return finish();
        lastInterrupt = now;
        return;
      }
      if (key.ctrl && key.name === "d" && !text) return finish();
      if (key.ctrl && key.name === "r") { railOpen = !railOpen; return; }
      if (key.ctrl && key.name === "l") { screen.invalidate(); return; }

      if (key.name === "escape") {
        if (session.isRunning()) session.interrupt();
        return;
      }

      // Approval shortcuts bind only while one is pending, so they never steal
      // a keystroke from the composer.
      if (state.approval && !text) {
        const decision: Record<string, ApprovalDecision> = { y: "allow", a: "always", n: "deny" };
        const choice = decision[key.name.toLowerCase()];
        if (choice) { session.approve(state.approval.id, choice); return; }
      }

      // While a completion menu is open it owns the arrows and Tab; otherwise
      // Enter would send a half-typed mention. Enter still submits when the
      // highlighted entry is already what was typed — accepting a completion
      // that changes nothing would make every complete command need two
      // presses.
      if (completions.length) {
        if (key.name === "up") { selected = (selected - 1 + completions.length) % completions.length; return; }
        if (key.name === "down") { selected = (selected + 1) % completions.length; return; }
        if (key.name === "tab") { acceptCompletion(); return; }
        if (key.name === "return" && !completionIsExact()) { acceptCompletion(); return; }
      }

      if (key.name === "up") { scroll += 1; return; }
      if (key.name === "down") { scroll = Math.max(0, scroll - 1); return; }
      if (key.name === "pageup") { scroll += Math.max(1, screen.size.rows - 4); return; }
      if (key.name === "pagedown") { scroll = Math.max(0, scroll - Math.max(1, screen.size.rows - 4)); return; }

      if (key.name === "backspace") { text = text.slice(0, -1); updateCompletions(); return; }
      if (key.name === "return") return submit();
      if (key.char && !key.ctrl) { text += key.char; updateCompletions(); }
    }

    function submit(): void {
      const value = text;
      // Enter always clears the composer, even on whitespace. Leaving invisible
      // spaces behind makes the input look empty while still counting as text —
      // which then silently blocks Ctrl+D from exiting.
      text = "";
      completions = [];
      const intent = parseComposer(value);
      if (intent.kind === "empty") return;
      scroll = 0;
      if (intent.kind === "shell") { void session.runShell(intent.command).catch(() => {}); return; }
      if (intent.kind === "prompt") { void session.prompt(intent.text).catch(() => {}); return; }
      runCommand(intent.name, intent.args);
    }

    function runCommand(name: string, arg: string): void {
      switch (name) {
        case "exit": case "quit": return finish();
        case "compact": void session.compact().catch(() => {}); return;
        case "reset": session.reset(); return;
        case "rail": railOpen = !railOpen; return;
        case "mode": {
          const next = MODES.includes(arg as ApprovalMode)
            ? (arg as ApprovalMode)
            : MODES[(MODES.indexOf(session.meta().mode) + 1) % MODES.length];
          session.setMode(next);
          return;
        }
        case "rewind": {
          const checkpoints = session.checkpoints();
          const target = arg
            ? checkpoints.find(c => c.hash.startsWith(arg))
            : checkpoints[checkpoints.length - 2];
          if (target) void session.rewind(target.hash).catch(() => {});
          return;
        }
        default:
          return;
      }
    }

    /** Refresh the completion list for whatever token the caret is in. */
    function updateCompletions(): void {
      const token = activeToken(text);
      if (!token) { completions = []; selected = 0; return; }
      completions = token.trigger === "/"
        ? matchCommands(token.query).map(c => c.name)
        : session.files(token.query, 8);
      selected = Math.min(selected, Math.max(0, completions.length - 1));
    }

    /** True when the highlighted entry is exactly what is already typed. */
    function completionIsExact(): boolean {
      const token = activeToken(text);
      return !!token && completions[selected] === token.query;
    }

    function acceptCompletion(): void {
      const token = activeToken(text);
      if (!token || !completions.length) return;
      text = applyCompletion(text, token, completions[selected]).text;
      completions = [];
      selected = 0;
    }

    input.on("data", onData);
  });

  await done;
}
