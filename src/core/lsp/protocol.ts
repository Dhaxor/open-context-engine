/**
 * Minimal LSP wire protocol (JSON-RPC 2.0 over stdio with Content-Length
 * framing) — only what symbol lookup needs. No dependency on vscode-languageserver:
 * the engine must stay light, and we only ever call four methods.
 */

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Encode one message with LSP base-profile framing. */
export function encodeMessage(msg: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

/**
 * Incremental frame reader. stdin delivers arbitrary chunks; a frame may be
 * split anywhere (header mid-byte, body mid-JSON). feed() buffers and emits
 * exactly one event per complete frame.
 */
export function createMessageReader(onMessage: (msg: JsonRpcMessage) => void): {
  feed: (chunk: Buffer) => void;
  /** Bytes buffered but not yet consumed by a complete frame (error surface). */
  pending: () => number;
} {
  let buffer = Buffer.alloc(0);
  const HEADER_END = "\r\n\r\n";
  return {
    feed(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headEnd = buffer.indexOf(HEADER_END);
        if (headEnd === -1) return;
        const header = buffer.slice(0, headEnd).toString("utf8");
        const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
        if (!lengthMatch) {
          // Unframeable garbage: drop through the header so we don't wedge forever.
          buffer = buffer.slice(headEnd + HEADER_END.length);
          continue;
        }
        const bodyLength = Number(lengthMatch[1]);
        const bodyStart = headEnd + HEADER_END.length;
        if (buffer.length < bodyStart + bodyLength) return; // wait for the rest of the body
        const body = buffer.slice(bodyStart, bodyStart + bodyLength).toString("utf8");
        buffer = buffer.slice(bodyStart + bodyLength);
        try {
          onMessage(JSON.parse(body));
        } catch {
          // A malformed frame must not kill the reader; skip it.
        }
      }
    },
    pending: () => buffer.length,
  };
}
