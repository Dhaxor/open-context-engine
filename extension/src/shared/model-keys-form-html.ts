import { icon } from "../chat/webview/icons";

/** Model & API keys form — shared by chat quick panel and full settings page. */
export function modelKeysFormHtml(): string {
  return `
    <div class="model-keys-form">
      <div class="panel-section">
        <div class="panel-section-hdr">Chat model</div>
        <div class="pills" id="providerPills">
          <button type="button" class="pill" data-provider="openai">OpenAI</button>
          <button type="button" class="pill" data-provider="anthropic">Anthropic</button>
          <button type="button" class="pill" data-provider="google">Google</button>
          <button type="button" class="pill" data-provider="custom">Custom</button>
        </div>
        <div class="row major-only" id="modelSelRow"><label for="modelSel">Model</label><select id="modelSel"></select></div>
        <div class="row custom-only" id="modelCustomRow" hidden><label for="modelCustom">Model ID</label><input id="modelCustom" type="text" placeholder="e.g. meta-llama/llama-3-70b" /></div>
        <div class="row custom-only" id="baseUrlRow" hidden><label for="baseUrl">Base URL</label><input id="baseUrl" type="text" placeholder="https://openrouter.ai/api/v1" /></div>
        <div class="emb-hint custom-only" id="baseUrlHint" hidden>OpenAI-compatible endpoint (OpenRouter, LM Studio, etc.)</div>
        <div class="row"><label for="apiKey">API key</label><input id="apiKey" type="password" placeholder="sk-… (stored securely)" /><span id="keyStatus" class="key-status"></span></div>
      </div>
      <div class="panel-section">
        <div class="panel-section-hdr">Web search</div>
        <div class="row"><label for="tavilyKey">Tavily</label><input id="tavilyKey" type="password" placeholder="tvly-… (web search)" /><span id="tavilyStatus" class="key-status"></span></div>
      </div>
      <div class="panel-section embedding-card">
        <div class="panel-section-hdr emb-title">${icon("sparkle")} Embeddings</div>
        <div class="emb-blurb">Powers codebase indexing and semantic search across your workspace.</div>
        <div class="emb-meta muted" id="embeddingMeta">—</div>
        <div class="row"><label for="embeddingKey">API key</label><input id="embeddingKey" type="password" placeholder="Voyage, OpenAI, etc." /><span id="embeddingStatus" class="key-status"></span></div>
      </div>
      <div class="actions model-keys-actions"><button type="button" id="settingsCancel" class="btn">Close</button><button type="button" id="saveCfg" class="btn primary">Save</button></div>
    </div>`;
}
