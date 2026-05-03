export const chatCss = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--vscode-sideBar-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:13px;display:flex;flex-direction:column;overflow:hidden}
#hdr{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
#hdr .title{font-weight:600;font-size:12px;letter-spacing:.02em;opacity:.9}
#hdr .spacer{flex:1}
#hdr .badge{font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(128,128,128,.15);color:var(--vscode-descriptionForeground);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
#hdr .badge:hover{background:rgba(128,128,128,.28);color:var(--vscode-editor-foreground)}
#hdr .iconbtn{background:transparent;border:none;color:var(--vscode-descriptionForeground);width:26px;height:24px;border-radius:4px;cursor:pointer;font-size:14px;display:inline-flex;align-items:center;justify-content:center}
#hdr .iconbtn:hover{background:rgba(128,128,128,.18);color:var(--vscode-editor-foreground)}
#messages{flex:1;overflow-y:auto;padding:10px 12px 6px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
#messages::-webkit-scrollbar{width:8px}
#messages::-webkit-scrollbar-thumb{background:rgba(128,128,128,.3);border-radius:4px}
.msg{max-width:100%;word-wrap:break-word;line-height:1.55}
.msg.user{align-self:flex-end;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:88%;white-space:pre-wrap}
.msg.bot{align-self:stretch;max-width:100%}
	.msg.bot.streaming::after{content:"";display:inline-block;width:2px;height:14px;background:var(--vscode-editor-foreground);animation:bl 1s steps(1,end) infinite;vertical-align:text-bottom;margin-left:2px}
.msg.bot p{margin:4px 0}
.msg.bot pre{background:var(--vscode-textCodeBlock-background,rgba(0,0,0,.25));border:1px solid var(--vscode-panel-border);border-radius:6px;margin:8px 0;overflow:hidden;font-size:12px}
.msg.bot pre code{display:block;padding:10px 12px;overflow-x:auto;font-family:var(--vscode-editor-font-family,monospace);white-space:pre}
.msg.bot code{font-family:var(--vscode-editor-font-family,monospace);font-size:.9em;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,.2));padding:1px 5px;border-radius:3px}
.msg.bot strong{font-weight:600}
.msg.bot em{font-style:italic}
.msg.bot a{color:var(--vscode-textLink-foreground);text-decoration:none}
.msg.bot a:hover{text-decoration:underline}
	.msg.bot a.file-link{cursor:pointer;font-family:var(--vscode-editor-font-family,monospace);font-size:.95em}
.msg.bot h1,.msg.bot h2,.msg.bot h3{margin:10px 0 4px;font-weight:600}
.msg.bot ul,.msg.bot ol{margin:4px 0 4px 22px}
.msg.bot li{margin:2px 0}
.msg.bot blockquote{border-left:3px solid var(--vscode-panel-border);padding-left:10px;opacity:.8;margin:6px 0}
.code-bar{display:flex;justify-content:space-between;align-items:center;gap:4px;padding:3px 8px;background:rgba(128,128,128,.12);font-size:11px;border-bottom:1px solid var(--vscode-panel-border)}
.code-bar .lang{opacity:.7;text-transform:lowercase}
.code-bar .acts{display:flex;gap:4px}
.code-bar button{background:transparent;border:none;color:var(--vscode-descriptionForeground);padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px}
.code-bar button:hover{background:rgba(128,128,128,.22);color:var(--vscode-editor-foreground)}
.notice{align-self:stretch;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 8px;border-left:2px solid rgba(128,128,128,.4);opacity:.85}
.notice.err{border-left-color:var(--vscode-errorForeground,#f48771);color:var(--vscode-errorForeground,#f48771)}
.tool{align-self:stretch;display:flex;flex-direction:column;gap:4px;border:1px solid var(--vscode-panel-border);border-radius:6px;background:rgba(128,128,128,.06);padding:6px 10px}
.tool .hdr{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer}
.tool .hdr .name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool .hdr .chev{opacity:.6;font-size:10px;transition:transform .15s}
.tool.open .hdr .chev{transform:rotate(90deg)}
.tool .body{display:none;margin-top:4px;font-size:11px;color:var(--vscode-descriptionForeground)}
.tool.open .body{display:block}
.tool .body .k{opacity:.7;margin-right:4px}
.tool .body pre{background:rgba(0,0,0,.25);border-radius:4px;padding:6px 8px;margin-top:4px;overflow-x:auto;white-space:pre-wrap;max-height:160px;overflow-y:auto}
.tool.running .dot{color:var(--vscode-charts-blue,#3b82f6)}
.tool.complete .dot{color:var(--vscode-charts-green,#10b981)}
.tool.error .dot{color:var(--vscode-errorForeground,#f48771)}
	.task-plan{align-self:stretch;border:1px solid var(--vscode-panel-border);border-radius:6px;background:rgba(59,130,246,.08);overflow:hidden}
	.task-plan .hdr{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;cursor:pointer}.task-plan .name{flex:1;font-weight:600}.task-plan ol{display:none;margin:0;padding:4px 12px 10px 28px;color:var(--vscode-descriptionForeground);font-size:12px}.task-plan.open ol{display:block}.task-plan li{margin:4px 0}.task-plan .dot{color:var(--vscode-charts-blue,#60a5fa)}
	.agent-step{align-self:stretch;display:flex;align-items:center;gap:8px;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 8px;border-left:2px solid rgba(128,128,128,.35)}.agent-step.complete .dot{color:var(--vscode-charts-green,#10b981)}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--vscode-descriptionForeground);border-top-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px}
@keyframes sp{to{transform:rotate(360deg)}}
	.cursor{display:inline-block;width:2px;height:14px;background:var(--vscode-editor-foreground);animation:bl 1s steps(1,end) infinite;vertical-align:text-bottom;margin-left:1px}
@keyframes bl{50%{opacity:0}}
.edit{align-self:stretch;border:1px solid var(--vscode-panel-border);border-radius:6px;background:rgba(128,128,128,.06);overflow:hidden}
.edit .hdr{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;cursor:pointer;border-bottom:1px solid transparent}
.edit .hdr:hover{background:rgba(128,128,128,.1)}
.edit.open .hdr{border-bottom-color:var(--vscode-panel-border)}
.edit .kind{font-size:10px;text-transform:uppercase;padding:2px 6px;border-radius:3px;letter-spacing:.03em}
.edit .kind.str-replace{background:rgba(59,130,246,.18);color:var(--vscode-charts-blue,#60a5fa)}
.edit .kind.create{background:rgba(16,185,129,.2);color:var(--vscode-charts-green,#34d399)}
.edit .kind.remove{background:rgba(244,135,113,.2);color:var(--vscode-errorForeground,#f48771)}
.edit .path{flex:1;font-family:var(--vscode-editor-font-family,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.edit .chev{opacity:.6;font-size:10px;transition:transform .15s}
.edit.open .chev{transform:rotate(90deg)}
.edit .body{display:none}
.edit.open .body{display:block}
.edit .acts{display:flex;gap:4px;padding:6px 10px;border-top:1px solid var(--vscode-panel-border);background:rgba(128,128,128,.04)}
.edit .acts button{background:transparent;border:1px solid var(--vscode-panel-border);color:var(--vscode-editor-foreground);padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer}
.edit .acts button:hover{background:rgba(128,128,128,.18)}
.edit .diff{font-family:var(--vscode-editor-font-family,monospace);font-size:11.5px;padding:0;margin:0;max-height:360px;overflow:auto;white-space:pre;line-height:1.45}
.edit .diff .l{display:block;padding:0 10px}
.edit .diff .add{background:rgba(16,185,129,.12);color:var(--vscode-charts-green,#34d399)}
.edit .diff .rem{background:rgba(244,135,113,.14);color:var(--vscode-errorForeground,#f48771)}
.edit .diff .hunk{background:rgba(128,128,128,.18);color:var(--vscode-descriptionForeground);font-weight:500}
.edit .diff .ctx{color:var(--vscode-descriptionForeground)}
.welcome{margin:auto 0;text-align:center;padding:24px 14px;color:var(--vscode-descriptionForeground);display:flex;flex-direction:column;align-items:center;gap:10px}
.welcome .wel-title{color:var(--vscode-editor-foreground);font-size:15px;font-weight:600}
.welcome .wel-sub{font-size:12px;max-width:340px;line-height:1.5}
.welcome .wel-chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:6px}
.welcome .chip{background:rgba(128,128,128,.14);border:1px solid var(--vscode-panel-border);color:var(--vscode-editor-foreground);padding:5px 10px;border-radius:14px;font-size:11.5px;cursor:pointer;transition:background .1s}
.welcome .chip:hover{background:rgba(128,128,128,.28)}
.welcome .wel-tip{font-size:11px;opacity:.7;margin-top:8px}
.welcome .wel-tip code{background:rgba(128,128,128,.2);padding:1px 5px;border-radius:3px;font-family:var(--vscode-editor-font-family,monospace)}
#bar{padding:8px 10px;border-top:1px solid var(--vscode-panel-border);display:flex;gap:6px;align-items:flex-end;background:var(--vscode-sideBar-background)}
#q{flex:1;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:8px;padding:8px 10px;font-family:inherit;font-size:13px;line-height:1.45;min-height:36px;max-height:140px;outline:none}
#q:focus{border-color:var(--vscode-focusBorder)}
#q::placeholder{color:var(--vscode-input-placeholderForeground)}
#go{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:8px;width:36px;height:36px;cursor:pointer;font-size:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
#go:hover{background:var(--vscode-button-hoverBackground)}
#go:disabled{opacity:.5;cursor:default}
.mode{display:inline-flex;align-self:stretch;background:rgba(128,128,128,.12);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:2px;gap:2px;height:36px;align-items:center;flex-shrink:0}
.mode .mode-opt{font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;color:var(--vscode-descriptionForeground);user-select:none;line-height:1}
.mode .mode-opt.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.mode .mode-opt:not(.active):hover{color:var(--vscode-editor-foreground)}
.settings{border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:10px 12px;display:flex;flex-direction:column;gap:8px;animation:fade .18s ease-out}
.settings[hidden]{display:none}
@keyframes fade{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.set-row{display:flex;align-items:center;gap:8px;font-size:12px}
.set-row label{width:60px;color:var(--vscode-descriptionForeground);font-size:11px}
.set-row input,.set-row select{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:4px 6px;font-family:inherit;font-size:12px;outline:none;min-width:0}
.set-row input:focus,.set-row select:focus{border-color:var(--vscode-focusBorder)}
.set-tabs{gap:4px;flex-wrap:wrap}
.set-tabs .pill{background:rgba(128,128,128,.12);border:1px solid var(--vscode-panel-border);color:var(--vscode-editor-foreground);padding:4px 10px;border-radius:12px;font-size:11.5px;cursor:pointer}
.set-tabs .pill.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent;font-weight:600}
.set-tabs .pill:hover:not(.active){background:rgba(128,128,128,.22)}
.set-row .key-status{font-size:10px;padding:1px 6px;border-radius:8px;flex-shrink:0}
.set-row .key-status.set{background:rgba(16,185,129,.22);color:var(--vscode-charts-green,#34d399)}
.set-row .key-status.unset{background:rgba(244,135,113,.22);color:var(--vscode-errorForeground,#f48771)}
.set-actions{justify-content:flex-end}
.set-actions button{background:transparent;border:1px solid var(--vscode-panel-border);color:var(--vscode-editor-foreground);padding:4px 12px;border-radius:4px;font-size:11.5px;cursor:pointer}
.set-actions button:hover{background:rgba(128,128,128,.18)}
.set-actions button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.set-actions button.primary:hover{background:var(--vscode-button-hoverBackground)}
.sr{align-self:stretch;border:1px solid var(--vscode-panel-border);border-radius:6px;background:rgba(128,128,128,.06);overflow:hidden}
.sr .hdr{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;cursor:pointer}
.sr .hdr:hover{background:rgba(128,128,128,.1)}
.sr .hdr .score{font-size:10px;padding:1px 6px;background:rgba(128,128,128,.2);border-radius:8px;color:var(--vscode-descriptionForeground)}
.sr .path{flex:1;font-family:var(--vscode-editor-font-family,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-textLink-foreground)}
.sr .chev{opacity:.6;font-size:10px;transition:transform .15s}
.sr.open .chev{transform:rotate(90deg)}
.sr pre{display:none;margin:0;padding:8px 10px;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,.25));border-top:1px solid var(--vscode-panel-border);font-family:var(--vscode-editor-font-family,monospace);font-size:11.5px;overflow:auto;max-height:240px;white-space:pre}
.sr.open pre{display:block}
.sr-empty{align-self:stretch;font-size:12px;color:var(--vscode-descriptionForeground);padding:12px;text-align:center}
.history{border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);display:flex;flex-direction:column;max-height:320px;animation:fade .18s ease-out}
.history[hidden]{display:none}
.history .hist-hdr{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border)}
.history .hist-hdr .hist-title{font-weight:600;font-size:12px}
.history .hist-hdr .spacer{flex:1}
.history .hist-hdr .iconbtn{background:transparent;border:none;color:var(--vscode-descriptionForeground);width:24px;height:22px;border-radius:3px;cursor:pointer;font-size:12px}
.history .hist-hdr .iconbtn:hover{background:rgba(128,128,128,.18);color:var(--vscode-editor-foreground)}
.hist-list{flex:1;overflow-y:auto;padding:4px}
.hist-item{display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:5px;cursor:pointer;transition:background .1s}
.hist-item:hover{background:rgba(128,128,128,.12)}
.hist-item.active{background:rgba(59,130,246,.14);border-left:2px solid var(--vscode-charts-blue,#3b82f6);padding-left:8px}
.hist-item .hist-main{flex:1;min-width:0}
.hist-item .hist-ttl{font-size:12px;color:var(--vscode-editor-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hist-item .hist-meta{font-size:10.5px;color:var(--vscode-descriptionForeground);margin-top:1px}
.hist-item .hist-del{background:transparent;border:none;color:var(--vscode-descriptionForeground);padding:2px 6px;border-radius:3px;cursor:pointer;font-size:11px;opacity:0;transition:opacity .1s}
.hist-item:hover .hist-del{opacity:1}
.hist-item .hist-del:hover{background:rgba(244,135,113,.2);color:var(--vscode-errorForeground,#f48771)}
.hist-empty{padding:20px 12px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px}
.set-sep{height:1px;background:var(--vscode-panel-border);margin:4px 0;opacity:.6}
.msg.bot .empty{color:var(--vscode-descriptionForeground);font-style:italic;font-size:12px}
.msg.user{animation:slideUp .15s ease-out}
.msg.bot{animation:slideUp .15s ease-out}
@keyframes slideUp{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
`;
