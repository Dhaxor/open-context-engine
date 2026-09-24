# Trace — desktop

The Open Context Engine agent workspace as an installable app.

This is a shell, not a fourth implementation. The Electron main process starts
the same `TraceSession` and the same server the CLI runs, then puts a window in
front of the same Studio bundle. What the shell adds is the part a browser tab
cannot do: desktop notifications when the agent is blocked on you, an
application menu, `trace://` deep links, and remembered window bounds.

## Why Electron

The index is a native SQLite handle (`better-sqlite3` + `sqlite-vec`) that has
to live in the same process as the server. Electron hosts that directly, and
this repo already rebuilds `better-sqlite3` against the Electron ABI for the VS
Code extension. A Rust shell would need Node shipped alongside it as a sidecar
process purely to hold the database open.

## Run it

From the repository root:

```bash
npm run build && npm run desktop
```

The first launch indexes the current working directory. Pass another with
`--workspace`:

```bash
npm run desktop -- --workspace ~/code/my-project
```

## Native modules

`better-sqlite3` is compiled for Node's ABI, and Electron uses a different one.
Rebuild once per Electron version:

```bash
cd desktop && npm install && npm run rebuild
```

That runs `electron-rebuild` against the root `node_modules`. (The VS Code
extension no longer needs this: it ships better-sqlite3 13, whose Node-API
binary loads in any Electron.)

## Packaging

```bash
cd desktop && npm run dist
```

`electron-builder` emits a DMG/zip on macOS, an NSIS installer on Windows, and
AppImage/deb on Linux, into `desktop/release/`. The published npm package does
not include any of this — the root `files` field ships `dist/` only.

## Where the logic lives

Electron code cannot be unit-tested without launching a browser and a GPU
process, so `main.js` holds only wiring. Everything with a decision in it lives
in `src/trace/desktop/` and runs in the normal test suite:

| Module | Responsibility |
| --- | --- |
| `shell.ts` | window-bounds validation, the menu template, deep links, navigation trust, when to notify |
| `config.ts` | resolving the workspace's embedding config without commander |

Two of those are worth calling out. `reconcileBounds` refuses to restore a
window onto a display that is no longer attached — reopening off-screen is
indistinguishable from the app failing to start. And `attentionFor` notifies on
exactly three things: an approval is waiting, a turn finished while you were
elsewhere, or an error. Notifying on ordinary progress teaches people to ignore
the app.

## The bridge to Studio

`preload.js` re-publishes menu and deep-link actions as DOM `CustomEvent`s.
Studio listens for them and is otherwise unaware it is in a shell — the same
bundle runs unmodified in a browser, where those events simply never fire.
Nothing from Node or Electron is exposed to the page.
