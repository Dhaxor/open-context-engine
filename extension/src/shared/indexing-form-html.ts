import { icon } from "../chat/webview/icons";

/** Indexing section body — status card, behaviour toggles, chunking inputs.
 *  Dynamic values are set via textContent by indexing-form.ts; this HTML is
 *  fully static. */
export function indexingFormHtml(): string {
  return `
    <div class="model-keys-form">
      <div class="panel-section">
        <div class="panel-section-hdr">${icon("repos")} Index status</div>
        <div class="idx-status">
          <div class="idx-stat"><span class="idx-label">Workspace</span><span class="idx-value" id="idxStatusRoot">—</span></div>
          <div class="idx-stat"><span class="idx-label">Files · chunks</span><span class="idx-value" id="idxStatusCounts">—</span></div>
          <div class="idx-stat"><span class="idx-label">Search mode</span><span class="idx-value" id="idxStatusMode">—</span></div>
          <div class="idx-stat"><span class="idx-label">Embeddings</span><span class="idx-value" id="idxStatusModel">—</span></div>
        </div>
        <div class="emb-hint" id="idxStatusReason" hidden></div>
        <div class="actions idx-actions">
          <button type="button" id="idxRebuild" class="btn primary">Rebuild index</button>
        </div>
      </div>
      <div class="panel-section">
        <div class="panel-section-hdr">Behaviour</div>
        <div class="row idx-toggle"><label for="settingIdxStartup">Index on startup</label><input id="settingIdxStartup" type="checkbox" /></div>
        <div class="row idx-toggle"><label for="settingIdxAutoIndex">Re-index on file changes</label><input id="settingIdxAutoIndex" type="checkbox" /></div>
        <div class="row idx-toggle"><label for="settingIdxCache">Embedding cache</label><input id="settingIdxCache" type="checkbox" /></div>
        <div class="emb-hint">The cache stores embeddings by content hash in ~/.open-context/embed-cache.db — identical code never embeds twice.</div>
      </div>
      <div class="panel-section">
        <div class="panel-section-hdr">Chunking</div>
        <div class="row"><label for="settingIdxChunkSize">Chunk size (lines)</label><input id="settingIdxChunkSize" type="number" min="10" max="400" step="1" /></div>
        <div class="row"><label for="settingIdxChunkOverlap">Chunk overlap (lines)</label><input id="settingIdxChunkOverlap" type="number" min="0" max="400" step="1" /></div>
        <div class="emb-hint">Applies to non-AST files; code files are chunked by syntax. Changing these rebuilds chunks on the next index.</div>
      </div>
    </div>`;
}
