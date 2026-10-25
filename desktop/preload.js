// The only bridge between the shell and Studio.
//
// Studio is the same bundle the browser loads, so it must not depend on
// Electron existing. Menu and deep-link actions are therefore re-published as
// ordinary DOM CustomEvents: in the desktop app they fire, in a browser they
// simply never do, and Studio needs no branch for either case.
//
// Nothing from Node or Electron is exposed to the page — the bridge is
// one-directional and carries only a string.

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = [
  "trace:new-session",
  "trace:command-palette",
  "trace:interrupt",
  "trace:toggle-rail",
  "trace:session",
  "trace:rewind",
];

for (const channel of CHANNELS) {
  ipcRenderer.on(channel, (_event, value) => {
    window.dispatchEvent(new CustomEvent(channel, { detail: value }));
  });
}

// A flag so Studio can show desktop-only affordances if it ever needs to.
contextBridge.exposeInMainWorld("traceDesktop", { version: 1 });
