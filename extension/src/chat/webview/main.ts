import "./styles.css";
import { icon } from "./icons";
import { esc, md, fmtDiff, relTime, shortPath } from "./render";
import { wireModelKeysForm } from "../../shared/model-keys-form";

declare function acquireVsCodeApi(): { postMessage(m: any): void };
const V = acquireVsCodeApi();
const $ = (id: string) => document.getElementById(id) as any;
const post = (m: any) => V.postMessage(m);

const GET_TEAM_URL = "https://opencontext.dev/pricing";

// --- element refs ---
const msgs = $("messages"), q = $("q"), sendBtn = $("sendBtn"), stopBtn = $("stopBtn");
const modelBadge = $("modelBadge"), planBadge = $("planBadge"), modeSeg = $("modeSeg");
const settingsPanel = $("settingsPanel"), historyPanel = $("historyPanel"), accountPanel = $("accountPanel");
const histList = $("histList"), histEmpty = $("histEmpty"), accountBody = $("accountBody"), reposBtn = $("reposBtn"), contextBar = $("contextBar");

const modelKeysForm = wireModelKeysForm({
  $,
  post,
  notice,
  root: settingsPanel,
  showCancel: true,
});

// --- state ---
let cur: any = null, fullText = "", busy = false, mode: "agent" | "search" = "agent", renderTimer = 0;
let tools: Record<string, any> = {}, edits: Record<string, any> = {};
let activityEl: HTMLElement | null = null, currentStepEl: HTMLElement | null = null;
let stepCards: Record<number, HTMLElement> = {}, stepCount = 0, toolCount = 0;
let license: any = { plan: "free", valid: false }, multiOn = false;
let lastUserText = "", contextInfo: any = { activeFile: "", hasSelection: false };
const isTeam = () => !!license.valid && (license.plan === "team" || license.plan === "enterprise");

// --- basics ---
// Auto-scroll respects intent: if the user has scrolled up to read, we stop
// yanking them back down. They reattach by scrolling close to the bottom again
// or clicking the floating "Latest" pill.
const jumpBottom = $("jumpBottom");
let stickToBottom = true;
function isNearBottom() { return msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 40; }
function refreshJumpPill() { if (jumpBottom) jumpBottom.hidden = stickToBottom; }
msgs.addEventListener("scroll", () => { stickToBottom = isNearBottom(); refreshJumpPill(); });
const scroll = () => { if (stickToBottom) msgs.scrollTop = msgs.scrollHeight; refreshJumpPill(); };
const forceScroll = () => { stickToBottom = true; msgs.scrollTop = msgs.scrollHeight; refreshJumpPill(); };
if (jumpBottom) jumpBottom.onclick = () => forceScroll();
const removeWelcome = () => { const w = $("welcome"); if (w) w.remove(); };
function setBusy(b: boolean) { busy = b; sendBtn.style.display = b ? "none" : "flex"; stopBtn.hidden = !b; }

/**
 * Find the largest prefix of `text` that's safe to commit as final markdown:
 * through the closing line of any code fence, or the last paragraph break
 * (`\n\n`) outside a fence. Everything past this point stays in the live tail
 * as plain text — it may still be re-flowing markdown (an open `**`, an
 * unclosed code fence, etc.) and we don't want the rendered structure
 * shifting under the user every animation frame.
 */
function findSafeCommitPoint(text: string): number {
  let lastSafe = 0, i = 0, inFence = false;
  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === "\n";
    if (atLineStart && text.charCodeAt(i) === 96 && text.charCodeAt(i + 1) === 96 && text.charCodeAt(i + 2) === 96) {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return lastSafe;
      inFence = !inFence;
      i = nl + 1;
      if (!inFence) lastSafe = i;
      continue;
    }
    if (!inFence && text.charCodeAt(i) === 10 && text.charCodeAt(i + 1) === 10) {
      lastSafe = i + 2; i += 2; continue;
    }
    i++;
  }
  return lastSafe;
}

function addUser(t: string) {
  removeWelcome();
  lastUserText = t;
  const d = document.createElement("div"); d.className = "msg user"; d.textContent = t;
  attachUserActions(d, t);
  msgs.appendChild(d); forceScroll();
}
function actionBtn(ic: string, label: string, onClick: () => void) {
  const b = document.createElement("button"); b.innerHTML = icon(ic) + " " + label; b.onclick = onClick; return b;
}
function attachBotActions(el: any, raw: string) {
  const bar = document.createElement("div"); bar.className = "msg-actions";
  bar.appendChild(actionBtn("copy", "Copy", () => post({ type: "copyText", text: raw })));
  bar.appendChild(actionBtn("redo", "Retry", () => { if (lastUserText) send(lastUserText); }));
  el.appendChild(bar);
}
function attachUserActions(el: any, text: string) {
  const bar = document.createElement("div"); bar.className = "msg-actions";
  bar.appendChild(actionBtn("insert", "Edit", () => { q.value = text; q.focus(); q.dispatchEvent(new Event("input")); }));
  el.appendChild(bar);
}
function insertAtCursor(text: string) {
  const start = q.selectionStart ?? q.value.length, end = q.selectionEnd ?? q.value.length;
  q.value = q.value.slice(0, start) + text + q.value.slice(end);
  q.selectionStart = q.selectionEnd = start + text.length; q.focus(); q.dispatchEvent(new Event("input"));
}
function renderContext() {
  let html = "";
  if (contextInfo.activeFile) html += `<span class="ctx-pill" title="Current file (auto-included): ${esc(contextInfo.activeFile)}">${icon("open")}<span class="nm">${esc(contextInfo.activeFile.split("/").pop())}</span></span>`;
  if (contextInfo.hasSelection) html += `<span class="ctx-pill" title="Your selection is included">${icon("sparkle")}<span class="nm">selection</span></span>`;
  html += `<button class="ctx-add" id="ctxAdd" title="Reference a file">${icon("add")} Add file</button>`;
  contextBar.innerHTML = html;
  const add = $("ctxAdd"); if (add) add.onclick = () => post({ type: "pickContextFile" });
}
function renderSources(files: any[]) {
  if (!files || !files.length) return;
  sealBubble();
  const el = document.createElement("div"); el.className = "card sources";
  el.innerHTML = `<div class="chead">${icon("repos")}<span class="ttl">${files.length} source${files.length === 1 ? "" : "s"}</span><span class="chev">${icon("chevron")}</span></div>` +
    `<div class="cbody">${files.map((f) => `<div class="src-file" data-open="${esc(f.path)}" data-line="${esc((f.lines || "").split("-")[0] || "")}">${icon("open")} ${esc(f.path)}${f.lines ? ":" + esc(f.lines) : ""}</div>`).join("")}</div>`;
  el?.querySelector?.(".chead")?.addEventListener("click", () => el.classList.toggle("open"));
  msgs.appendChild(el); scroll();
}
/**
 * Streaming render uses a committed prefix + live tail pattern:
 *  - .committed is the already-finalized markdown (rewritten only when we
 *    advance the safe commit point, not every frame).
 *  - .tail is a plain-text span that grows by textNode append per chunk —
 *    fast, layout-stable, no full reflow.
 *  - .cursor is a dedicated span at a fixed anchor (end of tail), so the
 *    blinking caret no longer bounces with each innerHTML rewrite.
 */
function startBot() {
  removeWelcome();
  const el: any = document.createElement("div"); el.className = "msg bot streaming";
  const committed = document.createElement("div"); committed.className = "committed";
  const tail = document.createElement("span"); tail.className = "tail";
  const cursor = document.createElement("span"); cursor.className = "cursor";
  el.append(committed, tail, cursor);
  el._committed = committed; el._tail = tail; el._cursor = cursor; el._committedLen = 0;
  msgs.appendChild(el);
  cur = el; fullText = ""; scroll();
}
function tryCommit() {
  if (!cur) return;
  const safe = findSafeCommitPoint(fullText);
  if (safe <= cur._committedLen) return;
  cur._committedLen = safe;
  cur._committed.innerHTML = md(fullText.slice(0, safe));
  // Reset tail to the unrendered remainder (cheap textContent assign).
  cur._tail.textContent = fullText.slice(safe);
}
function chunk(t: string) {
  if (!cur) startBot();
  fullText += t;
  cur._tail.appendChild(document.createTextNode(t));
  if (!renderTimer) renderTimer = requestAnimationFrame(() => { renderTimer = 0; tryCommit(); scroll(); });
}
function finalize() {
  if (renderTimer) { cancelAnimationFrame(renderTimer); renderTimer = 0; }
  if (cur) {
    const el = cur, raw = fullText;
    cur._committed.innerHTML = md(raw) || '<em class="empty">(no response)</em>';
    cur._tail.textContent = "";
    cur._cursor.remove();
    el.classList.remove("streaming");
    attachBotActions(el, raw);
    cur = null; fullText = "";
  }
  setBusy(false); scroll();
}
function sealBubble() {
  if (!cur) return;
  cur._committed.innerHTML = md(fullText) || '<em class="empty">(thinking…)</em>';
  cur._tail.textContent = "";
  cur._cursor.remove();
  cur.classList.remove("streaming");
  cur = null; fullText = "";
}
function showError(t: string) { if (cur) { cur.remove(); cur = null; } const d = document.createElement("div"); d.className = "notice err"; d.textContent = "Error: " + t; msgs.appendChild(d); setBusy(false); scroll(); }
function notice(t: string, cls?: string) { const d = document.createElement("div"); d.className = "notice" + (cls ? " " + cls : ""); d.textContent = t; msgs.appendChild(d); scroll(); }

// --- agent activity (per-turn grouping) ---
function resetActivityState() {
  activityEl = null; currentStepEl = null; stepCards = {}; stepCount = 0; toolCount = 0;
}
function activityBody(): HTMLElement {
  return activityEl!.querySelector(".act-body") as HTMLElement;
}
function updateActivitySummary() {
  if (!activityEl) return;
  const s = activityEl.querySelector(".act-summary");
  if (!s) return;
  const parts: string[] = [];
  if (stepCount) parts.push(stepCount + " step" + (stepCount === 1 ? "" : "s"));
  if (toolCount) parts.push(toolCount + " action" + (toolCount === 1 ? "" : "s"));
  s.textContent = parts.join(" · ");
}
function ensureActivity() {
  if (activityEl) return;
  sealBubble();
  const card = document.createElement("div");
  activityEl = card;
  card.className = "card activity open";
  card.innerHTML = `<div class="chead"><span class="status-ic"><span class="spin"></span></span><span class="ttl">Agent activity</span><span class="act-summary"></span><span class="chev">${icon("chevron")}</span></div><div class="act-body"></div>`;
  card.querySelector(".chead")!.addEventListener("click", (e) => { e.stopPropagation(); card.classList.toggle("open"); });
  msgs.appendChild(card);
  scroll();
}
function sealActivity() {
  if (!activityEl) return;
  activityEl.classList.remove("open");
  const ic = activityEl.querySelector(".status-ic");
  if (ic) ic.innerHTML = icon("check");
  updateActivitySummary();
  resetActivityState();
}
function wireCardToggle(card: HTMLElement) {
  card.querySelector(".chead")!.addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("open");
  });
}
function toolParent(): HTMLElement {
  ensureActivity();
  return currentStepEl || activityBody();
}

// --- agent cards ---
// The one-line argument that makes a collapsed tool card self-describing:
// which file, what query, which command. Without it every call reads as a
// generic "Searched codebase" with no hint of what it actually did.
function toolDetail(name: string, args: any): string {
  if (!args) return "";
  const pick = (...keys: string[]) => { for (const k of keys) if (args[k] != null && String(args[k]).trim()) return String(args[k]).trim(); return ""; };
  let d = "";
  if (name === "read-file" || name === "view-range" || name === "str-replace" || name === "create-file" || name === "remove-file") {
    d = pick("path");
    const s = args.start_line, e = args.end_line;
    if (d && s != null) d += e != null ? `:${s}-${e}` : `:${s}`;
  } else if (name === "list-files") {
    d = pick("pattern", "directory") || "all";
  } else if (name === "find-symbol-definition" || name === "find-symbol-references") {
    d = pick("symbol");
  } else if (name === "run-command") {
    d = pick("command");
  } else if (name === "web-search") {
    d = pick("query");
  } else {
    // codebase-retrieval and anything else: show the main text argument.
    d = pick("information_request", "query", "command", "path", "symbol");
  }
  return d;
}
function toolBody(args: any, summary?: string) {
  let rows = "";
  if (args) for (const k in args) { let v: any = args[k]; if (typeof v !== "string") v = JSON.stringify(v); rows += `<div><span class="k">${esc(k)}:</span>${esc(v.length > 600 ? v.slice(0, 600) + "…" : v)}</div>`; }
  if (summary) rows += `<div class="k" style="margin-top:6px">result</div><pre>${esc(summary)}</pre>`;
  return rows || '<div class="k">no arguments</div>';
}
function toolUpdate(id: string, name: string, status: string, label: string, summary?: string, args?: any) {
  let t = tools[id];
  if (!t) {
    sealBubble();
    t = document.createElement("div"); t.className = "card tool running";
    t.innerHTML = `<div class="chead"><span class="status-ic"><span class="spin"></span></span><span class="ttl"></span><span class="tdetail"></span><span class="chev">${icon("chevron")}</span></div><div class="cbody"></div>`;
    toolParent().appendChild(t); tools[id] = t;
    toolCount++; updateActivitySummary();
    wireCardToggle(t);
  }
  t.classList.remove("running", "complete", "error"); t.classList.add(status);
  t.querySelector(".ttl").textContent = label;
  const detail = toolDetail(name, args);
  const de = t.querySelector(".tdetail"); de.textContent = detail; de.title = detail;
  if (status !== "running") { t.querySelector(".status-ic").innerHTML = status === "error" ? icon("warning") : icon("check"); }
  t.querySelector(".cbody").innerHTML = toolBody(args, summary);
  scroll();
}
function renderTaskPlan(plan: string[]) {
  sealBubble();
  ensureActivity();
  const el = document.createElement("div"); el.className = "card plan";
  el.innerHTML = `<div class="chead">${icon("sparkle")}<span class="ttl">Agent plan</span><span class="chev">${icon("chevron")}</span></div><div class="cbody"><ol style="margin-left:18px">${plan.map((p) => `<li>${esc(p)}</li>`).join("")}</ol></div>`;
  wireCardToggle(el);
  activityBody().appendChild(el); scroll();
}
function agentStep(step: number, status: string) {
  sealBubble();
  ensureActivity();
  let el = stepCards[step];
  if (!el) {
    stepCount++; updateActivitySummary();
    el = document.createElement("div"); el.id = "agent-step-" + step; el.className = "card step";
    el.innerHTML = `<div class="chead"><span class="status-ic"><span class="spin"></span></span><span class="ttl">Reasoning step ${step + 1}</span><span class="chev">${icon("chevron")}</span></div><div class="cbody"></div>`;
    wireCardToggle(el);
    activityBody().appendChild(el);
    stepCards[step] = el;
  }
  el.classList.remove("running", "complete");
  el.classList.add(status);
  currentStepEl = el.querySelector(".cbody") as HTMLElement;
  if (status === "running") {
    el.classList.add("open");
    el.querySelector(".status-ic")!.innerHTML = '<span class="spin"></span>';
  } else {
    el.classList.remove("open");
    el.querySelector(".status-ic")!.innerHTML = icon("check");
  }
  scroll();
}
function addEdit(e: any) {
  if (edits[e.id]) return;
  sealBubble();
  const el = document.createElement("div"); el.className = "card edit open"; el.dataset.editId = e.id; el._diff = e.diff;
  const title = e.kind === "create" ? "Created" : e.kind === "remove" ? "Deleted" : "Edited";
  const count = e.replacedOccurrences ? ` (${e.replacedOccurrences})` : "";
  const openBtn = e.kind === "remove" ? "" : `<button class="mini" data-open="${esc(e.path)}">${icon("open")} Open</button>`;
  el.innerHTML = `<div class="chead"><span class="kind ${e.kind}">${e.kind === "str-replace" ? "edit" : e.kind}</span><span class="path">${esc(e.path)}</span><span class="state">${title}${count}</span><span class="chev">${icon("chevron")}</span></div>` +
    `<div class="cbody"><div class="diff">${fmtDiff(e.diff)}</div></div>` +
    `<div class="acts"><button class="mini" data-diff="${e.id}">${icon("diff")} Diff</button>${openBtn}<span class="spacer"></span><button class="mini undo" data-undo="${e.id}">${icon("undo")} Undo</button></div>`;
  el?.querySelector?.(".chead")?.addEventListener("click", () => el.classList.toggle("open"));
  edits[e.id] = el; msgs.appendChild(el); scroll();
}
function setEditStatus(id: string, status: string) {
  const el = edits[id]; if (!el) return;
  const undone = status === "undone"; el.classList.toggle("undone", undone);
  const st = el.querySelector(".state"); if (st) st.textContent = undone ? "Reverted" : (el.querySelector(".kind.create") ? "Created" : el.querySelector(".kind.remove") ? "Deleted" : "Edited");
  const btn = el.querySelector(".acts .undo, .acts .redo");
  if (btn) {
    if (undone) { btn.className = "mini redo"; btn.innerHTML = icon("redo") + " Redo"; btn.setAttribute("data-redo", id); btn.removeAttribute("data-undo"); }
    else { btn.className = "mini undo"; btn.innerHTML = icon("undo") + " Undo"; btn.setAttribute("data-undo", id); btn.removeAttribute("data-redo"); }
  }
}
function showEditSummary(ids: string[]) {
  if (!ids || !ids.length) return;
  const bar = document.createElement("div"); bar.className = "summary";
  bar.innerHTML = `${icon("check")}<span>${ids.length} file${ids.length === 1 ? "" : "s"} changed this turn</span><span class="spacer"></span><button class="btn">${icon("undo")} Undo all</button>`;
  bar?.querySelector?.("button")?.addEventListener("click", function (this: any) { post({ type: "undoEdits", ids }); this.textContent = "Reverted"; this.disabled = true; });
  msgs.appendChild(bar); scroll();
}

// --- search ---
function renderSearchResults(results: any[]) {
  if (!results || !results.length) { const e = document.createElement("div"); e.className = "notice"; e.textContent = "No matches found."; msgs.appendChild(e); scroll(); return; }
  results.forEach((r) => {
    const el = document.createElement("div"); el.className = "card sr";
    const loc = esc(r.path) + ":" + r.startLine + "-" + r.endLine;
    const repo = r.repo ? `<span class="repo">${esc(r.repo)}</span>` : "";
    const lines = (r.contents || "").split("\n").map((l: string, i: number) => String(r.startLine + i).padStart(5) + " │ " + l).join("\n");
    el.innerHTML = `<div class="chead">${repo}<span class="path">${loc}</span><span class="score">${(r.score * 100).toFixed(0)}%</span><span class="chev">${icon("chevron")}</span></div><pre>${esc(lines)}</pre>`;
    el?.querySelector?.(".chead")?.addEventListener("click", (ev: any) => { if (ev.target.classList.contains("path")) { post({ type: "openFile", path: r.path, line: r.startLine }); return; } el.classList.toggle("open"); });
    msgs.appendChild(el);
  });
  scroll();
}

// --- panels ---
function closePanels(except?: any) { [settingsPanel, historyPanel, accountPanel].forEach((p) => { if (p !== except) p.hidden = true; }); }
function togglePanel(p: any, onOpen?: () => void) { const show = p.hidden; closePanels(show ? p : null); p.hidden = !show; if (show && onOpen) onOpen(); }

// --- history ---
function renderHistory(sessions: any[], currentId: string) {
  if (!sessions || !sessions.length) { histList.innerHTML = ""; histEmpty.hidden = false; return; }
  histEmpty.hidden = true;
  histList.innerHTML = sessions.map((s) => {
    const active = s.id === currentId ? " active" : "";
    const meta = (s.messageCount || 0) + " msg · " + relTime(s.updatedAt);
    return `<div class="checkbox hist-item${active}" data-id="${esc(s.id)}" style="justify-content:space-between"><div style="min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title || "Untitled")}</div><div class="muted" style="font-size:10.5px">${esc(meta)}</div></div><button class="iconbtn" data-del="${esc(s.id)}" title="Delete">${icon("trash")}</button></div>`;
  }).join("");
}
function replaySession(session: any) {
  msgs.innerHTML = ""; cur = null; fullText = ""; setBusy(false); tools = {}; edits = {}; resetActivityState();
  if (!session.messages || !session.messages.length) { msgs.innerHTML = `<div class="welcome" id="welcome"><div class="w-title">${esc(session.title || "Chat")}</div><div class="w-sub">Empty conversation — send a message to continue.</div></div>`; return; }
  session.messages.forEach((m: any) => {
    if (m.role === "user") addUser(m.text);
    else { const d = document.createElement("div"); d.className = "msg bot"; d.innerHTML = md(m.text); attachBotActions(d, m.text); msgs.appendChild(d); }
  });
  scroll();
}

// --- account / license ---
function renderAccount() {
  const lic = license || { plan: "free" };
  if (lic.valid) {
    const exp = lic.exp ? new Date(lic.exp * 1000).toISOString().slice(0, 10) : "perpetual";
    accountBody.innerHTML =
      `<div class="lic-status">` +
      `<div class="lic-line"><span class="lic-k">Plan</span><b style="text-transform:capitalize">${esc(lic.plan)}</b></div>` +
      (lic.org ? `<div class="lic-line"><span class="lic-k">Org</span>${esc(lic.org)}</div>` : "") +
      (lic.seats ? `<div class="lic-line"><span class="lic-k">Seats</span>${esc(lic.seats)}</div>` : "") +
      `<div class="lic-line"><span class="lic-k">Expires</span>${esc(exp)}</div>` +
      (lic.inGrace ? `<div class="notice err" style="border:none;padding-left:0">In grace period — ${esc(lic.daysLeft)} day(s) left.</div>` : "") +
      `</div><div class="actions"><button class="btn" id="deactivateBtn">Deactivate</button></div>`;
    $("deactivateBtn").onclick = () => post({ type: "deactivateLicense" });
  } else {
    accountBody.innerHTML =
      `<div class="upsell"><div class="up-title">${icon("sparkle")} Open Context Team</div><ul>` +
      `<li>${icon("check")} Multi-repo search across all your repositories</li>` +
      `<li>${icon("check")} Shared team index — index once, everyone benefits</li>` +
      `<li>${icon("check")} Commercial-use license &amp; priority support</li></ul>` +
      `<button class="btn primary block" id="getTeamBtn">Get Team</button>` +
      `<div class="up-note">Your code stays on your machine — license keys verify offline.</div></div>` +
      `<div class="sep"></div><div class="row"><input id="licKey" type="text" placeholder="Paste license key…" /></div>` +
      `<div class="actions"><button class="btn primary" id="activateBtn">Activate</button></div>`;
    $("getTeamBtn").onclick = () => post({ type: "openExternal", url: GET_TEAM_URL });
    $("activateBtn").onclick = () => { const k = $("licKey").value.trim(); if (k) post({ type: "activateLicense", key: k }); };
  }
}
function setLicense(lic: any) {
  license = lic || { plan: "free", valid: false };
  const plan = license.valid ? license.plan : "free";
  planBadge.textContent = plan.charAt(0).toUpperCase() + plan.slice(1);
  planBadge.className = "plan " + plan;
  if (!isTeam()) multiOn = false;
  updateRepos();
  if (!accountPanel.hidden) renderAccount();
}

// --- send / mode ---
function send(text?: string) {
  const t = (text != null ? text : q.value).trim(); if (!t || busy) return;
  if (t === "/clear") { post({ type: "clear" }); q.value = ""; return; }
  if (t === "/model") { togglePanel(settingsPanel, () => post({ type: "getConfig" })); q.value = ""; return; }
  setBusy(true); if (text == null) { q.value = ""; q.style.height = "auto"; }
  addUser(t);
  post({ type: "query", text: t, mode, multi: mode === "search" && multiOn });
}
function setMode(m: string) {
  mode = m === "search" ? "search" : "agent";
  modeSeg.querySelectorAll(".opt").forEach((o: any) => o.classList.toggle("active", o.dataset.mode === mode));
  q.placeholder = mode === "search" ? "Search the codebase (raw snippets)…" : "Ask anything, or describe an edit…";
}

// --- event wiring ---
msgs.addEventListener("click", (e: any) => {
  const t = e.target.closest("[data-cp],[data-ins],[data-apply],[data-diff],[data-undo],[data-redo],[data-open],.chip") || e.target;
  const d = t.dataset || {};
  if (d.cp) { const c = $(d.cp); if (c) post({ type: "copyText", text: c.textContent }); }
  else if (d.ins) { const c = $(d.ins); if (c) post({ type: "insertCode", code: c.textContent }); }
  else if (d.apply) { const c = $(d.apply); if (c) post({ type: "applyCode", code: c.textContent, file: d.file || "" }); }
  else if (d.diff) post({ type: "openDiff", id: d.diff });
  else if (d.undo) post({ type: "undoEdit", id: d.undo });
  else if (d.redo) post({ type: "redoEdit", id: d.redo });
  else if (d.open) post({ type: "openFile", path: d.open, line: Number(d.line || 0) });
  else if (t.classList.contains("chip") && d.prompt) send(d.prompt);
});
sendBtn.onclick = () => send();
stopBtn.onclick = () => { post({ type: "cancel" }); setBusy(false); if (cur) finalize(); sealActivity(); notice("Stopped"); };
$("newBtn").onclick = () => post({ type: "newSession" });
modelBadge.onclick = () => togglePanel(settingsPanel, () => post({ type: "getConfig" }));
$("settingsBtn").onclick = () => post({ type: "openSettings" });
$("openFullSettings")?.addEventListener("click", () => post({ type: "openSettings" }));
$("historyBtn").onclick = () => togglePanel(historyPanel, () => post({ type: "listHistory" }));
$("accountBtn").onclick = () => togglePanel(accountPanel, renderAccount);
planBadge.onclick = () => togglePanel(accountPanel, renderAccount);
$("settingsClose").onclick = () => (settingsPanel.hidden = true);
$("settingsCancel").onclick = () => (settingsPanel.hidden = true);
$("historyClose").onclick = () => (historyPanel.hidden = true);
$("accountClose").onclick = () => (accountPanel.hidden = true);
histList.addEventListener("click", (e: any) => {
  const del = e.target.closest("[data-del]");
  if (del) { post({ type: "deleteHistory", id: del.dataset.del }); e.stopPropagation(); return; }
  const item = e.target.closest(".hist-item"); if (item && item.dataset.id) { post({ type: "loadHistory", id: item.dataset.id }); historyPanel.hidden = true; }
});
modeSeg.addEventListener("click", (e: any) => { const t = e.target.closest(".opt"); if (t && t.dataset.mode) setMode(t.dataset.mode); });
function updateRepos() { reposBtn.classList.toggle("active", multiOn); reposBtn.title = multiOn ? "Multi-repo search ON — all workspace folders" : "Search across all workspace folders (Team)"; }
reposBtn.onclick = () => { if (!isTeam()) { togglePanel(accountPanel, renderAccount); return; } multiOn = !multiOn; if (multiOn && mode !== "search") setMode("search"); updateRepos(); };
q.onkeydown = (e: any) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
q.oninput = function (this: any) { this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 150) + "px"; };

// --- host messages ---
window.addEventListener("message", (e: any) => {
  const m = e.data;
  switch (m.type) {
    case "chunk": chunk(m.text); break;
    case "done": finalize(); sealActivity(); tools = {}; break;
    case "error": showError(m.text); sealActivity(); break;
    case "tool_update": toolUpdate(m.id, m.name, m.status, m.label, m.summary, m.args); break;
    case "task_plan": renderTaskPlan(m.plan || []); break;
    case "agent_step": agentStep(m.step || 0, m.status || "running"); break;
    case "edit": addEdit(m.edit); break;
    case "edit_status": setEditStatus(m.id, m.status); break;
    case "edit_summary": showEditSummary(m.ids); break;
    case "retry": notice("Retrying (attempt " + m.attempt + ", " + Math.round(m.delayMs) + "ms): " + m.reason); break;
    case "model_routed": notice("Routed to " + m.tier.name + " tier (" + m.tier.model + ")"); break;
    case "compaction": notice("Compacted " + m.dropped + " older messages to fit context"); break;
    case "addUserMessage": addUser(m.text); break;
    case "model": modelBadge.querySelector(".txt").textContent = m.model; modelBadge.title = "Model: " + m.provider + "/" + m.model + " (click to change)"; break;
    case "license": setLicense(m.status); break;
    case "context": contextInfo = { activeFile: m.activeFile || "", hasSelection: !!m.hasSelection }; renderContext(); break;
    case "sources": renderSources(m.files || []); break;
    case "insertMention": if (m.path) insertAtCursor("@" + m.path + " "); break;
    case "config":
      modelKeysForm.applyConfig(m); break;
    case "search_start": removeWelcome(); break;
    case "search_result": renderSearchResults(m.results); break;
    case "history_list": renderHistory(m.sessions, m.currentId); break;
    case "history_load": replaySession(m.session); historyPanel.hidden = true; break;
    case "clear":
      msgs.innerHTML = `<div class="welcome" id="welcome"><div class="w-logo">${icon("sparkle")}</div><div class="w-title">New chat</div><div class="w-sub">Ask a question, or switch to Search for raw snippet lookup.</div></div>`;
      cur = null; fullText = ""; setBusy(false); tools = {}; edits = {}; resetActivityState(); break;
  }
});

updateRepos();
renderContext();
post({ type: "ready" });
