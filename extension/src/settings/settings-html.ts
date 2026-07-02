import { icon } from "../chat/webview/icons";
import { modelKeysFormHtml } from "../shared/model-keys-form-html";

export const settingsBody = `
<div class="settings-page">
  <aside class="settings-nav">
    <div class="settings-brand">${icon("sparkle")}<span>Open Context</span></div>
    <nav class="settings-nav-list">
      <button type="button" class="nav-item active" data-section="model-keys">${icon("key")}<span>Model &amp; API keys</span></button>
      <button type="button" class="nav-item soon" data-section="general" disabled>${icon("account")}<span>General</span><em class="soon-tag">Soon</em></button>
      <button type="button" class="nav-item soon" data-section="indexing" disabled>${icon("repos")}<span>Indexing</span><em class="soon-tag">Soon</em></button>
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
    <section id="section-general" class="settings-section" hidden>
      <header class="section-head">
        <h1>General</h1>
        <p class="section-desc">Workspace preferences and defaults — coming soon.</p>
      </header>
      <div class="placeholder-card">More settings will appear here in a future update.</div>
    </section>
    <section id="section-indexing" class="settings-section" hidden>
      <header class="section-head">
        <h1>Indexing</h1>
        <p class="section-desc">Index behavior and embedding options — coming soon.</p>
      </header>
      <div class="placeholder-card">More settings will appear here in a future update.</div>
    </section>
  </main>
</div>
<div id="settingsNotice" class="settings-notice" hidden></div>
`;
