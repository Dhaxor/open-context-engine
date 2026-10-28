import { icon } from "../shared/webview/icons";
import { modelKeysFormHtml } from "../shared/model-keys-form-html";
import { indexingFormHtml } from "../shared/indexing-form-html";

export const settingsBody = `
<div class="settings-page">
  <aside class="settings-nav">
    <div class="settings-brand">${icon("sparkle")}<span>Open Context</span></div>
    <nav class="settings-nav-list">
      <button type="button" class="nav-item active" data-section="model-keys">${icon("key")}<span>Model &amp; API keys</span></button>
      <button type="button" class="nav-item" data-section="indexing">${icon("repos")}<span>Indexing</span></button>
      <button type="button" class="nav-item" data-section="account">${icon("account")}<span>Account &amp; License</span></button>
    </nav>
    <button type="button" class="nav-link" id="openVscodeSettings">${icon("open")}<span>Advanced (VS Code settings)</span></button>
  </aside>
  <main class="settings-main">
    <section id="section-model-keys" class="settings-section active">
      <header class="section-head">
        <h1>Model &amp; API keys</h1>
        <p class="section-desc">Configure chat models, web search, and embedding keys for indexing.</p>
      </header>
      ${modelKeysFormHtml()}
    </section>
    <section id="section-indexing" class="settings-section" hidden>
      <header class="section-head">
        <h1>Indexing</h1>
        <p class="section-desc">Index behaviour, chunking, and live status for the semantic code index.</p>
      </header>
      ${indexingFormHtml()}
    </section>
    <section id="section-account" class="settings-section" hidden>
      <header class="section-head">
        <h1>Account &amp; License</h1>
        <p class="section-desc">View your plan, activate a Team license, and unlock multi-repo search.</p>
      </header>
      <div id="accountBody" class="account-section"></div>
    </section>
  </main>
</div>
<div id="settingsNotice" class="settings-notice" hidden></div>
`;
