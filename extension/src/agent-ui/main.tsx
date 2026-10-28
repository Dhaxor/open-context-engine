import "./styles.css";
import { createRoot } from "react-dom/client";
import type { TraceEnvelope } from "../../../src/trace/protocol";
import { App } from "./App";
import { VsCodeTransport } from "./transport";

type Bound = { onEvent: (e: TraceEnvelope) => void; onConnection: (c: boolean) => void; onError: (m: string) => void; onReset: () => void };

// The transport exists before the React tree that consumes its events; App
// binds these forwarders before it connects, so nothing arrives unhandled.
let bound: Bound = { onEvent: () => {}, onConnection: () => {}, onError: () => {}, onReset: () => {} };
const transport = new VsCodeTransport("sidebar", {
  onEvent: e => bound.onEvent(e),
  onConnectionChange: c => bound.onConnection(c),
  onError: m => bound.onError(m),
  onReset: () => bound.onReset(),
});
const bind = (h: Bound) => { bound = h; };

createRoot(document.getElementById("root")!).render(<App transport={transport} bindHandlers={bind} />);
