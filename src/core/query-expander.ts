const SYNONYM_GROUPS: string[][] = [
  ["delete", "remove", "unlink", "destroy", "drop", "erase", "clear"],
  ["create", "make", "build", "initialize", "generate", "construct", "new", "add"],
  ["get", "fetch", "retrieve", "load", "find", "query", "lookup", "read", "obtain"],
  ["update", "modify", "patch", "change", "edit", "mutate", "set", "alter"],
  ["send", "dispatch", "emit", "publish", "broadcast", "push", "notify"],
  ["receive", "listen", "subscribe", "consume", "handle", "accept"],
  ["validate", "check", "verify", "assert", "ensure", "test", "confirm"],
  ["parse", "decode", "deserialize", "extract", "unwrap"],
  ["format", "serialize", "encode", "stringify", "render", "marshal"],
  ["connect", "open", "establish", "init", "start", "begin", "launch"],
  ["disconnect", "close", "terminate", "stop", "end", "shutdown", "teardown"],
  ["authenticate", "login", "signin", "authorize", "auth"],
  ["cache", "memoize", "store", "buffer", "persist", "save"],
  ["transform", "convert", "map", "translate", "adapt"],
  ["filter", "select", "where", "exclude", "reject", "omit"],
  ["sort", "order", "rank", "arrange"],
  ["merge", "combine", "join", "concat", "aggregate", "union"],
  ["split", "separate", "divide", "chunk", "partition"],
  ["error", "exception", "failure", "fault", "issue", "problem"],
  ["log", "trace", "debug", "print", "output", "record"],
  ["config", "configuration", "settings", "options", "preferences", "params"],
  ["middleware", "interceptor", "hook", "plugin", "handler"],
  ["route", "endpoint", "path", "url", "uri"],
  ["component", "widget", "element", "view", "template"],
  ["service", "provider", "manager", "controller", "handler"],
  ["model", "entity", "schema", "type", "interface", "struct"],
  ["repository", "store", "dao", "storage", "persistence"],
  ["event", "signal", "message", "notification", "callback"],
];

const SYNONYM_MAP = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) {
    const existing = SYNONYM_MAP.get(word) ?? new Set<string>();
    for (const other of group) {
      if (other !== word) existing.add(other);
    }
    SYNONYM_MAP.set(word, existing);
  }
}

export interface ExpandedQuery {
  original: string;
  expanded: string;
  terms: string[];
}

export function expandQuery(query: string): ExpandedQuery {
  const tokens = tokenize(query);
  const expansions = new Set<string>();

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const synonyms = SYNONYM_MAP.get(lower);
    if (synonyms) {
      for (const syn of [...synonyms].slice(0, 3)) {
        expansions.add(syn);
      }
    }
    for (const part of splitIdentifier(token)) {
      if (part.length >= 3) expansions.add(part);
    }
  }

  const terms = [...expansions].filter(t => !tokens.some(tok => tok.toLowerCase() === t));
  const expanded = terms.length ? `${query} ${terms.join(" ")}` : query;

  return { original: query, expanded, terms };
}

function splitIdentifier(id: string): string[] {
  const parts: string[] = [];
  // camelCase split
  const camelParts = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/);
  if (camelParts.length > 1) {
    for (const p of camelParts) if (p.length >= 3) parts.push(p.toLowerCase());
  }
  // snake_case split
  const snakeParts = id.split(/_+/);
  if (snakeParts.length > 1) {
    for (const p of snakeParts) if (p.length >= 3) parts.push(p.toLowerCase());
  }
  return parts;
}

function tokenize(text: string): string[] {
  return (text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []);
}
