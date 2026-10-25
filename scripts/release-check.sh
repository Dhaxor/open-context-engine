#!/usr/bin/env bash
# Rehearse a release: install the packed tarball exactly as a user would, into
# a throwaway prefix, and smoke-test the commands the website tells people to
# run. Tests prove the source works; this proves the PACKAGE works — missing
# files in `files`, a bin that points nowhere, or Studio assets left out of the
# tarball all pass the test suite and fail here.
#
#   npm run build && bash scripts/release-check.sh
#
# Needs no API keys: it exercises the keyword-only path a new user starts on.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
cleanup() {
  [ -n "${TRACE_PID:-}" ] && kill "$TRACE_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[36m▸ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }

cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"

step "pack open-context-engine@$VERSION"
TARBALL="$WORK/$(npm pack --silent --pack-destination "$WORK" | tail -1)"
[ -f "$TARBALL" ] || fail "npm pack produced no tarball"
pass "$(basename "$TARBALL") ($(du -h "$TARBALL" | cut -f1))"

step "tarball contents"
LISTING="$WORK/listing.txt"
tar -tzf "$TARBALL" > "$LISTING"
for required in \
  package/dist/cli/index.js \
  package/dist/index.js \
  package/dist/trace/server.js \
  package/dist/trace/tui/index.js \
  package/dist/trace/studio/index.html \
  package/dist/trace/studio/studio.js \
  package/dist/trace/studio/studio.css \
  package/README.md \
  package/LICENSE; do
  grep -qx "$required" "$LISTING" || fail "missing from tarball: ${required#package/}"
done
pass "entry points, Studio assets, README and LICENSE present"
for forbidden in '\.test\.js$' '^package/src/' '^package/desktop/' '^package/web/' '^package/business/' '^package/ee/' '\.map$'; do
  if grep -qE "$forbidden" "$LISTING"; then
    fail "tarball ships something it should not: $(grep -E "$forbidden" "$LISTING" | head -1)"
  fi
done
pass "no tests, sources, maps, or private directories"

step "install globally into a throwaway prefix"
PREFIX="$WORK/global"
npm install -g --prefix "$PREFIX" --silent "$TARBALL" >/dev/null 2>"$WORK/install.log" \
  || { cat "$WORK/install.log"; fail "npm install -g failed"; }
OCE="$PREFIX/bin/oce"
[ -x "$OCE" ] || fail "no oce binary at $OCE"
pass "installed"

# Run as a new user would: no keys of any kind in the environment.
run_oce() {
  env -u VOYAGE_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY \
      -u GEMINI_API_KEY -u GROQ_API_KEY -u OCE_EMBEDDING_PROVIDER \
      NODE_NO_WARNINGS=1 "$OCE" "$@"
}

step "oce --version"
GOT="$(run_oce --version)"
[ "$GOT" = "$VERSION" ] || fail "oce --version printed '$GOT', expected '$VERSION'"
pass "$GOT"

step "oce setup (no keys)"
run_oce setup > "$WORK/setup.txt" 2>&1 || fail "oce setup exited non-zero"
grep -q "Free options" "$WORK/setup.txt" || fail "oce setup did not list the free options"
pass "lists the free options"

step "first run in a fresh workspace — index and search with no keys"
WS="$WORK/workspace"
mkdir -p "$WS/src"
cat > "$WS/src/config.ts" <<'EOF'
export function parseConfigFile(path: string): string[] {
  return path.split("/");
}
EOF
cat > "$WS/src/retry.ts" <<'EOF'
export async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}
EOF
( cd "$WS" && run_oce index > "$WORK/index.txt" 2>&1 ) || { cat "$WORK/index.txt"; fail "oce index failed"; }
grep -q "Chunks: [1-9]" "$WORK/index.txt" || { cat "$WORK/index.txt"; fail "oce index produced no chunks"; }
if grep -q "Error\|    at " "$WORK/index.txt"; then cat "$WORK/index.txt"; fail "oce index printed an error or stack trace"; fi
pass "indexed ($(grep -o 'Chunks: [0-9]*' "$WORK/index.txt"))"
( cd "$WS" && run_oce search parseConfigFile > "$WORK/search.txt" 2>&1 ) || { cat "$WORK/search.txt"; fail "oce search failed"; }
grep -q "src/config.ts" "$WORK/search.txt" || { cat "$WORK/search.txt"; fail "oce search did not find the symbol"; }
pass "search finds parseConfigFile in src/config.ts"

step "oce trace serves Studio and the API"
PORT=$(( 20000 + RANDOM % 20000 ))
( cd "$WS" && run_oce trace -p ollama --headless --no-index --port "$PORT" > "$WORK/trace.txt" 2>&1 ) &
TRACE_PID=$!
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/health" | grep -q '"ok":true' || { cat "$WORK/trace.txt"; fail "trace server never became healthy"; }
TOKEN="$(sed -n 's/.*#token=\([A-Za-z0-9_-]*\).*/\1/p' "$WORK/trace.txt" | head -1)"
[ -n "$TOKEN" ] || { cat "$WORK/trace.txt"; fail "trace did not print an access URL"; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/session")" = "401" ] \
  || fail "the API answered without a token"
curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/session" | grep -q '"meta"' \
  || fail "the API did not answer with the token"
pass "healthy on :$PORT, token required, session reachable"
kill "$TRACE_PID" 2>/dev/null || true
TRACE_PID=""

printf '\n\033[32mRelease check passed for open-context-engine@%s\033[0m\n' "$VERSION"
