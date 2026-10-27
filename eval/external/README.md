# External gold sets

`../oce.eval.json` scores OCE retrieving from its own source — necessary, but
not sufficient: a retrieval change that overfits this repository's vocabulary
and file layout looks like progress on that set and regresses everywhere else.
These sets score OCE against codebases it has never seen, in other languages.

## Sets

| Set | Codebase | License | Cases | Mode | recall@10 | MRR |
|---|---|---|---|---|---|---|
| `flask.eval.json` | [Flask](https://github.com/pallets/flask) `3.1.2` (Python) | BSD-3-Clause | 27 | keyword-only | **0.926** | 0.605 |
| `flask.eval.json` | 〃 | 〃 | 27 | hybrid (voyage-code-3) | 0.889 | 0.604 |
| `flask.eval.json` | 〃 | 〃 | 27 | hybrid (openai-3-small / MiniLM) | 0.852 | 0.619 |
| `flask.eval.json` | 〃 | 〃 | 27 | hybrid (MiniLM, **adaptive fusion**) | **0.963** | **0.757** |
| `gin.eval.json` | [gin](https://github.com/gin-gonic/gin) `v1.10.0` (Go) | MIT | 26 | keyword-only | **0.846** | 0.634 |
| `gin.eval.json` | 〃 | 〃 | 26 | hybrid (MiniLM, adaptive fusion) | **0.846** | **0.691** |

Each baseline records the search mode it was measured in — compare like with
like (`oce eval` warns on a mode mismatch).

## Running one

```sh
# Any checkout works; the tag matters for reproducibility.
curl -sL https://github.com/pallets/flask/archive/refs/tags/3.1.2.tar.gz | tar xz
oce eval -w flask-3.1.2 -p none \
  --cases eval/external/flask.eval.json \
  --baseline eval/external/flask.baseline.json

# gin (Go) — pass the ABSOLUTE workspace path; see the known quirk below.
curl -sL https://github.com/gin-gonic/gin/archive/refs/tags/v1.10.0.tar.gz | tar xz
oce eval -w "$PWD/gin-1.10.0" -p none \
  --cases eval/external/gin.eval.json \
  --baseline eval/external/gin.baseline.json
```

No embedding key needed for the keyword baseline (`-p none`). With a key,
swap `-p voyage` (or `-p openai`) and compare against the matching hybrid
baseline.

Known quirk: a RELATIVE `-w` path can walk zero files on Windows
(`workspaceRoot` is not resolved before the file walk) — use an absolute
path. Tracked for a fix.

## What the numbers say (and don't)

**History: keyword-only used to beat every hybrid configuration here.** The
definition-shaped queries in this set ("the main Flask application class") are
BM25's home turf: exact vocabulary, rank-1 hits. Equal-weight RRF fusion
*demoted* those hits when the semantic ranker preferred tests and docs — the
flagship voyage-code-3 hybrid dropped recall to 0.889, and general-purpose
embedders (openai text-embedding-3-small, local MiniLM) dropped further to
0.852, against keyword-only's 0.926.

**Adaptive fusion closed that gap.** Queries are now classified by shape
(identifier spellings, quoted code, file paths → definition; paraphrase →
intent) and the fusion weights tilt accordingly (see
`src/core/query-profile.ts`). Measured with local MiniLM on this set:

| configuration | recall@10 | MRR | nDCG@10 |
|---|---|---|---|
| keyword-only | 0.926 | 0.605 | 0.685 |
| hybrid, equal-weight RRF (`--no-adaptive-fusion`) | 0.852 | 0.619 | 0.678 |
| hybrid, adaptive fusion | **0.926** | 0.641 | 0.711 |

Hybrid reaches parity with keyword-only on definition-shaped ground and keeps
its edge on paraphrase-shaped ground (this repo's own set: hybrid 0.943 vs
keyword 0.886 with voyage; adaptive was neutral there with MiniLM,
0.932 → 0.932). The earlier voyage numbers predate adaptive fusion and will
be re-measured when a key is at hand; the mechanism is query-time only, so
the committed baselines remain valid equal-weight references.

## Known misses

Three of 27 cases miss in keyword-only, all the same way: the defining module
is textually sparse, so files that *import* the name outrank the file that
*defines* it (`wrappers.py`, `globals.py` — and `app.py`'s size dilutes it).
Hybrid does not rescue them either — the semantic leg ranks tests and docs
high on these queries too. Fixes for these belong in ranking (symbol-boost on
definition chunks is the obvious lever), not in rephrasing the gold.

## Adding a set

1. Pick a real, actively-maintained, permissively-licensed codebase in a
   language OCE chunks (Python, Go, TypeScript, Rust, …). Pin a tag.
2. Write 20–30 cases the way a developer would actually ask — definition
   queries ("the main application class"), behaviour queries ("streaming
   responses that keep the request context"), and workflow queries ("CLI app
   discovery"). Every `expectedPaths` entry must be verifiable in the source.
3. Run once. Adjudicate every miss: a wrong gold path gets fixed, an ambiguous
   phrasing gets rephrased to what a developer would actually type, and a
   genuine engine weakness stays as a documented known miss.
4. Commit the set, its baseline, and a row in the table above.
