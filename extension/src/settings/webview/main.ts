import "../../chat/webview/styles.css";
import "./styles.css";
import { wireModelKeysForm } from "../../shared/model-keys-form";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const V = acquireVsCodeApi();
const $ = (id: string) => document.getElementById(id);
const post = (m: unknown) => V.postMessage(m);

const noticeEl = $("settingsNotice");
let noticeTimer = 0;
function notice(text: string) {
  if (!noticeEl) return;
  noticeEl.textContent = text;
  noticeEl.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { noticeEl.hidden = true; }, 3200);
}

const form = wireModelKeysForm({
  $: (id) => $(id),
  post,
  notice,
  showCancel: false,
});

const sections: Record<string, HTMLElement | null> = {
  "model-keys": $("section-model-keys"),
  general: $("section-general"),
  indexing: $("section-indexing"),
};

function showSection(id: string) {
  document.querySelectorAll(".nav-item:not(.soon)").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.section === id);
  });
  Object.entries(sections).forEach(([key, el]) => {
    if (el) el.hidden = key !== id;
  });
}

document.querySelector(".settings-nav-list")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".nav-item:not(.soon):not([disabled])") as HTMLElement | null;
  if (btn?.dataset.section) showSection(btn.dataset.section);
});

$("openVscodeSettings")?.addEventListener("click", () => post({ type: "openVscodeSettings" }));

window.addEventListener("message", (e) => {
  const m = e.data;
  switch (m.type) {
    case "config":
      form.applyConfig(m);
      break;
    case "navigate":
      if (m.section) showSection(String(m.section));
      break;
  }
});

post({ type: "ready" });
