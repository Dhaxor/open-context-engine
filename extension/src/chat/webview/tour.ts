export type TourStep = {
  target: string;
  title: string;
  body: string;
  placement?: "top" | "bottom" | "auto";
  /** Show the mirror "Chat toolbar" strip (VS Code chrome lives above the webview). */
  chromeBar?: boolean;
  /** Inject temporary welcome chips if the real welcome was replaced by chat history. */
  ensureWelcome?: boolean;
};

export const CHAT_TOUR_STEPS: TourStep[] = [
  {
    target: "#tourBarIndex",
    title: "Index workspace",
    body: "Re-index your workspace from the Chat toolbar — builds the local semantic search index used by Agent and Search.",
    placement: "bottom",
    chromeBar: true,
  },
  {
    target: "#tourBarFolder",
    title: "Select folder to index",
    body: "Pick a different folder to index when your repo root isn't what you want searched.",
    placement: "bottom",
    chromeBar: true,
  },
  {
    target: "#tourBarHealth",
    title: "Index health",
    body: "Open diagnostics for your index — chunk counts, embedding status, and any degraded search modes.",
    placement: "bottom",
    chromeBar: true,
  },
  {
    target: "#tourBarDebug",
    title: "Debug retrieval",
    body: "Test how a query ranks against your index — useful for tuning search quality.",
    placement: "bottom",
    chromeBar: true,
  },
  {
    target: "#tourBarSettings",
    title: "Open settings",
    body: "Open full extension settings — model providers, API keys, and indexing options.",
    placement: "bottom",
    chromeBar: true,
  },
  {
    target: "#welcome .chips, #tourWelcome .chips",
    title: "Quick-start prompts",
    body: "Try a suggested prompt to explore your codebase — overview, auth flow, tests, or dead code.",
    placement: "top",
    ensureWelcome: true,
  },
  {
    target: "#modeSeg",
    title: "Agent vs Search",
    body: "Agent mode chats, edits files, and runs tools. Search mode returns raw code snippets from your index.",
    placement: "top",
  },
  {
    target: "#composer",
    title: "Ask anything",
    body: "Type a question or describe an edit. Press Enter to send, Shift+Enter for a new line.",
    placement: "top",
  },
  {
    target: "#modelBadge",
    title: "Chat model",
    body: "Switch the LLM used for this conversation — click to open model and provider settings.",
    placement: "top",
  },
  {
    target: "#settingsBtn",
    title: "Model & API keys",
    body: "Configure API keys and embedding providers required for chat and semantic search.",
    placement: "bottom",
  },
  {
    target: "#accountBtn",
    title: "Account & license",
    body: "Open Account & License settings to view your plan, activate a Team license, and unlock multi-repo search.",
    placement: "bottom",
  },
  {
    target: "#historyBtn",
    title: "Chat history",
    body: "Browse and resume past conversations for this workspace.",
    placement: "bottom",
  },
  {
    target: "#newBtn",
    title: "New chat",
    body: "Start a fresh conversation anytime without losing your history.",
    placement: "bottom",
  },
];

type TourCallbacks = {
  onComplete?: () => void;
  onSkip?: () => void;
  onPrepareStep?: (step: TourStep) => void;
  onCleanup?: () => void;
};

const PAD = 6;
const RING_PAD = 3;

export class SpotlightTour {
  private root: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private maskHole: SVGRectElement | null = null;
  private ring: HTMLElement | null = null;
  private popover: HTMLElement | null = null;
  private step = 0;
  private active = false;
  private steps: TourStep[] = [];
  private callbacks: TourCallbacks = {};
  private navDir: 1 | -1 = 1;
  private onResize = () => this.reposition();
  private onKey = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.key === "Escape") this.skip();
    else if (e.key === "ArrowRight" || e.key === "Enter") this.next();
    else if (e.key === "ArrowLeft") this.back();
  };

  start(steps: TourStep[], callbacks?: TourCallbacks, fromStep = 0): boolean {
    if (!steps.length) return false;
    this.stop(false);
    this.steps = steps;
    this.callbacks = callbacks ?? {};
    this.step = Math.max(0, Math.min(fromStep, steps.length - 1));
    this.navDir = 1;
    this.active = true;
    this.mount();
    this.showStep();
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKey);
    return true;
  }

  stop(notify = false): void {
    if (!this.active && !this.root) return;
    this.active = false;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKey);
    this.setChromeBar(false);
    this.callbacks.onCleanup?.();
    this.root?.remove();
    this.root = this.svg = this.maskHole = this.ring = this.popover = null;
    if (notify) this.callbacks.onSkip?.();
  }

  skip(): void {
    this.stop(true);
  }

  complete(): void {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKey);
    this.setChromeBar(false);
    this.callbacks.onCleanup?.();
    this.root?.remove();
    this.root = this.svg = this.maskHole = this.ring = this.popover = null;
    this.callbacks.onComplete?.();
  }

  isActive(): boolean {
    return this.active;
  }

  next(): void {
    if (!this.active) return;
    this.navDir = 1;
    if (this.step >= this.steps.length - 1) this.complete();
    else { this.step++; this.showStep(); }
  }

  back(): void {
    if (!this.active || this.step <= 0) return;
    this.navDir = -1;
    this.step--;
    this.showStep();
  }

  private setChromeBar(show: boolean): void {
    const bar = document.getElementById("tourChromeBar");
    if (bar) {
      bar.hidden = !show;
      bar.setAttribute("aria-hidden", show ? "false" : "true");
    }
  }

  private mount(): void {
    const root = document.createElement("div");
    root.className = "tour-root";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("tour-overlay");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.innerHTML = `
      <defs>
        <mask id="tour-spot-mask">
          <rect class="tour-mask-bg" width="100%" height="100%" fill="white"/>
          <rect class="tour-mask-hole" rx="6" fill="black"/>
        </mask>
      </defs>
      <rect class="tour-dim" width="100%" height="100%" mask="url(#tour-spot-mask)"/>
    `;
    this.svg = svg;
    this.maskHole = svg.querySelector(".tour-mask-hole") as SVGRectElement;
    svg.addEventListener("click", (e) => { if (e.target === svg || (e.target as Element).classList?.contains("tour-dim")) e.preventDefault(); });

    const ring = document.createElement("div");
    ring.className = "tour-ring";
    this.ring = ring;

    const pop = document.createElement("div");
    pop.className = "tour-popover";
    pop.innerHTML = `
      <button type="button" class="tour-close iconbtn" title="Close" aria-label="Close tour">&times;</button>
      <div class="tour-title"></div>
      <div class="tour-body"></div>
      <div class="tour-foot">
        <span class="tour-progress muted"></span>
        <div class="tour-actions">
          <button type="button" class="tour-skip linkish">Skip tour</button>
          <button type="button" class="tour-back btn ghost">Back</button>
          <button type="button" class="tour-next btn primary">Next</button>
        </div>
      </div>
    `;
    this.popover = pop;

    pop.querySelector(".tour-close")!.addEventListener("click", () => this.skip());
    pop.querySelector(".tour-skip")!.addEventListener("click", () => this.skip());
    pop.querySelector(".tour-back")!.addEventListener("click", () => this.back());
    pop.querySelector(".tour-next")!.addEventListener("click", () => this.next());

    root.append(svg, ring, pop);
    document.body.appendChild(root);
    this.root = root;
  }

  private getTargetRect(sel: string): DOMRect | null {
    const parts = sel.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      let union: DOMRect | null = null;
      for (const s of parts) {
        const r = this.getTargetRect(s);
        if (!r) continue;
        if (!union) union = r;
        else {
          const x1 = Math.min(union.left, r.left);
          const y1 = Math.min(union.top, r.top);
          const x2 = Math.max(union.right, r.right);
          const y2 = Math.max(union.bottom, r.bottom);
          union = new DOMRect(x1, y1, x2 - x1, y2 - y1);
        }
      }
      return union;
    }
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return null;
    return r;
  }

  private showStep(): void {
    const def = this.steps[this.step];
    if (!def || !this.popover || !this.maskHole || !this.ring) return;

    this.setChromeBar(!!def.chromeBar);
    this.callbacks.onPrepareStep?.(def);

    const rect = this.getTargetRect(def.target);
    if (!rect) {
      const next = this.step + this.navDir;
      if (next >= 0 && next < this.steps.length) {
        this.step = next;
        this.showStep();
        return;
      }
      if (this.navDir === 1 && this.step < this.steps.length - 1) {
        this.step++;
        this.showStep();
        return;
      }
      this.complete();
      return;
    }
    this.navDir = 1;

    const x = Math.max(0, rect.left - PAD);
    const y = Math.max(0, rect.top - PAD);
    const w = rect.width + PAD * 2;
    const h = rect.height + PAD * 2;

    this.maskHole.setAttribute("x", String(x));
    this.maskHole.setAttribute("y", String(y));
    this.maskHole.setAttribute("width", String(w));
    this.maskHole.setAttribute("height", String(h));

    Object.assign(this.ring.style, {
      left: `${x - RING_PAD}px`,
      top: `${y - RING_PAD}px`,
      width: `${w + RING_PAD * 2}px`,
      height: `${h + RING_PAD * 2}px`,
    });

    this.popover.querySelector(".tour-title")!.textContent = def.title;
    this.popover.querySelector(".tour-body")!.textContent = def.body;
    this.popover.querySelector(".tour-progress")!.textContent = `${this.step + 1} / ${this.steps.length}`;

    const backBtn = this.popover.querySelector(".tour-back") as HTMLButtonElement;
    const nextBtn = this.popover.querySelector(".tour-next") as HTMLButtonElement;
    backBtn.hidden = this.step === 0;
    nextBtn.textContent = this.step >= this.steps.length - 1 ? "Got it" : "Next";

    this.positionPopover(rect, def.placement ?? "auto");
  }

  private positionPopover(rect: DOMRect, placement: "top" | "bottom" | "auto"): void {
    if (!this.popover) return;
    const pop = this.popover;
    pop.style.visibility = "hidden";
    pop.style.left = "0";
    pop.style.top = "0";
    pop.style.maxWidth = `${Math.min(320, window.innerWidth - 24)}px`;

    const pr = pop.getBoundingClientRect();
    const margin = 12;
    let top: number;
    let left = Math.max(margin, Math.min(rect.left + rect.width / 2 - pr.width / 2, window.innerWidth - pr.width - margin));

    const preferTop = placement === "top" || (placement === "auto" && rect.top > window.innerHeight * 0.45);
    if (preferTop) {
      top = rect.top - pr.height - margin;
      if (top < margin) top = rect.bottom + margin;
    } else {
      top = rect.bottom + margin;
      if (top + pr.height > window.innerHeight - margin) top = rect.top - pr.height - margin;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - pr.height - margin));

    pop.classList.toggle("tour-popover-above", top + pr.height < rect.top);
    pop.classList.toggle("tour-popover-below", top > rect.bottom);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.visibility = "visible";
  }

  private reposition(): void {
    if (!this.active) return;
    this.showStep();
  }
}

export const chatTour = new SpotlightTour();

export function canStartChatTour(): boolean {
  return true;
}
