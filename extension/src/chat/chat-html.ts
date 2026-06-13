import { icon } from "./webview/icons";

// Static webview body. Behavior is wired by the compiled client (dist/webview.js).
export const chatBody = `
<header id="hdr">
  <div class="brand"><span class="logo">${icon("sparkle")}</span><span class="brand-name">Open Context</span></div>
  <div class="spacer"></div>
  <button id="newBtn" class="iconbtn" title="New chat">${icon("add")}</button>
  <button id="historyBtn" class="iconbtn" title="History">${icon("history")}</button>
  <button id="accountBtn" class="iconbtn" title="Account & license">${icon("account")}</button>
  <button id="settingsBtn" class="iconbtn" title="Model & keys">${icon("gear")}</button>
</header>

<section id="settingsPanel" class="panel" hidden>
  <div class="panel-hdr">${icon("gear")}<span>Model &amp; API keys</span><div class="spacer"></div><button id="settingsClose" class="iconbtn" title="Close">${icon("close")}</button></div>
  <div class="panel-body">
    <div class="pills" id="providerPills">
      <button class="pill" data-provider="openai">OpenAI</button>
      <button class="pill" data-provider="anthropic">Anthropic</button>
      <button class="pill" data-provider="google">Google</button>
    </div>
    <div class="row"><label for="modelSel">Model</label><select id="modelSel"></select></div>
    <div class="row"><label for="modelCustom">Custom</label><input id="modelCustom" type="text" placeholder="e.g. gpt-5-codex" /></div>
    <div class="row"><label for="apiKey">API key</label><input id="apiKey" type="password" placeholder="sk-… (stored securely)" /><span id="keyStatus" class="key-status"></span></div>
    <div class="sep"></div>
    <div class="row"><label for="tavilyKey">Tavily</label><input id="tavilyKey" type="password" placeholder="tvly-… (web search)" /><span id="tavilyStatus" class="key-status"></span></div>
    <div class="actions"><button id="settingsCancel" class="btn">Close</button><button id="saveCfg" class="btn primary">Save</button></div>
  </div>
</section>

<section id="historyPanel" class="panel" hidden>
  <div class="panel-hdr">${icon("history")}<span>Recent chats</span><div class="spacer"></div><button id="historyClose" class="iconbtn" title="Close">${icon("close")}</button></div>
  <div class="panel-body" style="padding-top:0">
    <div id="histList"></div>
    <div id="histEmpty" class="muted" style="text-align:center;padding:14px;font-size:12px" hidden>No chats yet — start a conversation below.</div>
  </div>
</section>

<section id="accountPanel" class="panel" hidden>
  <div class="panel-hdr">${icon("account")}<span>Account</span><div class="spacer"></div><button id="accountClose" class="iconbtn" title="Close">${icon("close")}</button></div>
  <div class="panel-body" id="accountBody"></div>
</section>

<div id="messages">
  <div class="welcome" id="welcome">
    <div class="w-logo">${icon("sparkle")}</div>
    <div class="w-title">Open Context</div>
    <div class="w-sub">Agentic chat grounded in a local index of your code.</div>
    <div class="chips">
      <button class="chip" data-prompt="Give me a high-level overview of this codebase.">${icon("repos")}<span>Explain this codebase</span></button>
      <button class="chip" data-prompt="Where is authentication handled and what are the key entry points?">${icon("search")}<span>Find the auth flow</span></button>
      <button class="chip" data-prompt="Run the test suite and summarize any failures.">${icon("check")}<span>Run the tests</span></button>
      <button class="chip" data-prompt="Find dead code and unused exports in this project.">${icon("trash")}<span>Find dead code</span></button>
    </div>
  </div>
</div>
<button id="jumpBottom" class="jump-bottom" hidden title="Jump to latest">${icon("chevronDown")} <span>Latest</span></button>

<div id="composer">
  <div class="input-frame">
    <div id="contextBar" class="context-bar"></div>
    <textarea id="q" rows="1" placeholder="Ask anything, or describe an edit…"></textarea>
    <div class="input-foot">
      <div class="seg" id="modeSeg">
        <span class="opt active" data-mode="agent" title="Agent mode — chat, edits, commands">${icon("sparkle")} Agent</span>
        <span class="opt" data-mode="search" title="Search mode — raw code snippets">${icon("search")} Search</span>
      </div>
      <button id="modelBadge" class="model-badge" title="Change model"><span class="txt">—</span>${icon("chevronDown")}</button>
      <button id="planBadge" class="plan free" title="Account & license">Free</button>
      <div class="spacer"></div>
      <button id="reposBtn" class="iconbtn small" title="Search across all workspace folders (Team)">${icon("repos")}</button>
      <button id="stopBtn" class="send stop" title="Stop" hidden>${icon("stop")}</button>
      <button id="sendBtn" class="send" title="Send (Enter)">${icon("send")}</button>
    </div>
  </div>
</div>
`;
