import { esc } from "../chat/webview/render";

export const MODELS: Record<string, string[]> = {
  openai: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5-codex", "gpt-5.3-codex", "gpt-5.1-codex-max", "gpt-5", "gpt-4.1"],
  anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-5"],
  google: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
};

export interface ModelKeysFormOptions {
  $: (id: string) => HTMLElement | null;
  post: (m: unknown) => void;
  notice: (text: string) => void;
  /** Root element containing provider pills (defaults to document). */
  root?: ParentNode;
  /** Show the Close button in the actions row. */
  showCancel?: boolean;
  /** Called after a successful save. */
  onSaved?: () => void;
}

export interface ModelKeysFormController {
  applyConfig: (m: Record<string, unknown>) => void;
  rebuildModels: () => void;
}

export function wireModelKeysForm(opts: ModelKeysFormOptions): ModelKeysFormController {
  const root = opts.root ?? document;
  const modelSel = opts.$("modelSel") as HTMLSelectElement | null;
  const modelCustom = opts.$("modelCustom") as HTMLInputElement | null;
  const baseUrl = opts.$("baseUrl") as HTMLInputElement | null;
  const apiKey = opts.$("apiKey") as HTMLInputElement | null;
  const keyStatus = opts.$("keyStatus");
  const tavilyKey = opts.$("tavilyKey") as HTMLInputElement | null;
  const tavilyStatus = opts.$("tavilyStatus");
  const embeddingKey = opts.$("embeddingKey") as HTMLInputElement | null;
  const embeddingStatus = opts.$("embeddingStatus");
  const embeddingMeta = opts.$("embeddingMeta");
  const modelSelRow = opts.$("modelSelRow");
  const modelCustomRow = opts.$("modelCustomRow");
  const baseUrlRow = opts.$("baseUrlRow");
  const baseUrlHint = opts.$("baseUrlHint");
  const saveBtn = opts.$("saveCfg");
  const cancelBtn = opts.$("settingsCancel");
  const providerPills = root.querySelector("#providerPills");

  let uiProvider = "openai";
  let uiHasKey: Record<string, boolean> = {};
  let uiHasTavily = false;
  let uiHasEmbedding = false;

  if (cancelBtn) cancelBtn.hidden = opts.showCancel === false;

  function rebuildModels() {
    if (!modelSel || uiProvider === "custom") return;
    modelSel.innerHTML = (MODELS[uiProvider] || []).map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  }

  function updateKeyStatus() {
    const has = !!uiHasKey[uiProvider];
    if (keyStatus) {
      keyStatus.className = "key-status " + (has ? "set" : "unset");
      keyStatus.textContent = has ? "set" : "not set";
    }
    if (apiKey) {
      apiKey.placeholder = has ? "•••••• (blank = keep)" : (uiProvider === "custom" ? "API key (stored securely)" : "sk-… (stored securely)");
      apiKey.value = "";
    }
    if (tavilyStatus) {
      tavilyStatus.className = "key-status " + (uiHasTavily ? "set" : "unset");
      tavilyStatus.textContent = uiHasTavily ? "set" : "not set";
    }
    if (tavilyKey) {
      tavilyKey.placeholder = uiHasTavily ? "•••••• (blank = keep)" : "tvly-… (web search)";
      tavilyKey.value = "";
    }
    if (embeddingStatus) {
      embeddingStatus.className = "key-status " + (uiHasEmbedding ? "set" : "unset");
      embeddingStatus.textContent = uiHasEmbedding ? "set" : "not set";
    }
    if (embeddingKey) {
      embeddingKey.placeholder = uiHasEmbedding ? "•••••• (blank = keep)" : "Voyage, OpenAI, etc.";
      embeddingKey.value = "";
    }
  }

  function setProviderUI(p: string) {
    uiProvider = p;
    const isCustom = p === "custom";
    providerPills?.querySelectorAll(".pill").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.provider === p));
    if (modelSelRow) modelSelRow.hidden = isCustom;
    if (modelCustomRow) modelCustomRow.hidden = !isCustom;
    if (baseUrlRow) baseUrlRow.hidden = !isCustom;
    if (baseUrlHint) baseUrlHint.hidden = !isCustom;
    if (!isCustom) rebuildModels();
    updateKeyStatus();
  }

  function applyConfig(m: Record<string, unknown>) {
    uiHasKey = (m.hasKey as Record<string, boolean>) || {};
    uiHasTavily = !!m.hasWebSearchKey;
    uiHasEmbedding = !!m.hasEmbeddingKey;
    setProviderUI(String(m.provider || "openai"));
    if (m.provider === "custom") {
      if (modelCustom) modelCustom.value = String(m.model || "");
      if (baseUrl) baseUrl.value = String(m.baseUrl || "");
    } else if (m.model && modelSel) {
      modelSel.value = String(m.model);
      if (!modelSel.value) {
        const opt = document.createElement("option");
        opt.value = String(m.model);
        opt.textContent = String(m.model);
        modelSel.appendChild(opt);
        modelSel.value = String(m.model);
      }
    }
    if (embeddingMeta && (m.embeddingProvider || m.embeddingModel)) {
      embeddingMeta.textContent = "Current: " + (m.embeddingProvider || "—") + " · " + (m.embeddingModel || "—");
    }
    updateKeyStatus();
  }

  function save() {
    const isCustom = uiProvider === "custom";
    const model = isCustom ? (modelCustom?.value.trim() || "") : (modelSel?.value || "");
    if (!model) {
      opts.notice(isCustom ? "Enter a model ID" : "Select a model");
      return;
    }
    if (isCustom && !baseUrl?.value.trim()) {
      opts.notice("Enter a base URL for custom endpoints");
      return;
    }
    opts.post({ type: "setLLMSelection", provider: uiProvider, model });
    if (isCustom) opts.post({ type: "setLLMBaseUrl", baseUrl: baseUrl?.value.trim() || "" });
    if (apiKey?.value) {
      opts.post({ type: "saveLLMKey", provider: uiProvider, apiKey: apiKey.value });
      apiKey.value = "";
    }
    if (embeddingKey?.value) {
      opts.post({ type: "saveEmbeddingKey", apiKey: embeddingKey.value });
      embeddingKey.value = "";
    }
    if (tavilyKey?.value) {
      opts.post({ type: "setWebSearchKey", apiKey: tavilyKey.value });
      tavilyKey.value = "";
    }
    opts.notice("Saved " + uiProvider + " · " + model);
    opts.post({ type: "getConfig" });
    opts.onSaved?.();
  }

  providerPills?.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest(".pill") as HTMLElement | null;
    if (t?.dataset.provider) setProviderUI(t.dataset.provider);
  });
  modelSel?.addEventListener("change", () => { if (modelCustom) modelCustom.value = ""; });
  saveBtn?.addEventListener("click", save);

  rebuildModels();

  return { applyConfig, rebuildModels };
}
