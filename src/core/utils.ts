import { createHash } from "crypto";

export function sha256(data: string | Buffer): string { return createHash("sha256").update(data).digest("hex"); }

export function computeBlobName(path: string, contents: string | Buffer): string {
  const h = createHash("sha256");
  h.update(path);
  h.update(typeof contents === "string" ? Buffer.from(contents, "utf8") : contents);
  return h.digest("hex");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector dimension mismatch");
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return true;
  }
  return false;
}

export function isBinaryContent(contents: string | Buffer): boolean {
  return isBinaryBuffer(typeof contents === "string" ? Buffer.from(contents, "utf8") : contents);
}

const KEYISH = [/\.pem$/i, /\.key$/i, /\.pfx$/i, /\.p12$/i, /\.jks$/i, /\.keystore$/i, /\.pkcs12$/i, /\.crt$/i, /\.cer$/i, /^id_rsa$/, /^id_ed25519$/, /^id_ecdsa$/, /^id_dsa$/];
export function isKeyishPath(p: string): boolean { const b = p.split("/").pop() || ""; return KEYISH.some(r => r.test(b)); }
export function formatResults(results: import("./types").SearchResult[]): string {
  if (!results.length) return "No results found.";
  return results.map(r => {
    const lines = r.chunk.contents.split("\n");
    const code = lines.map((l, i) => `${String(r.chunk.startLine + i).padStart(5)} │ ${l}`).join("\n");
    return `${r.chunk.path}:${r.chunk.startLine}-${r.chunk.endLine}\n${code}`;
  }).join("\n\n---\n\n");
}
