# External gold sets

`../oce.eval.json` scores OCE retrieving from its own source — necessary, but
not sufficient: a retrieval change that overfits this repository's vocabulary
and file layout looks like progress on that set and regresses everywhere else.
These sets score OCE against codebases it has never seen, in other languages.

## Sets

| Set | Codebase | License | Cases | Mode | recall@10 | MRR |
|---|---|---|---|---|---|---|
| `flask.eval.json` | [Flask](https://github.com/pallets/flask) `3.1.2` (Python) | BSD-3-Clause | 27 | keyword-only | 0.926 | 0.605 |

Each set's committed baseline (`*.baseline.json`) records the search mode it
was measured in — compare like with like (`oce eval` warns on a mode mismatch).

## Running one

```sh
# Any checkout works; the tag matters for reproducibility.
curl -sL https://github.com/pallets/flask/archive/refs/tags/3.1.2.tar.gz | tar xz
oce eval -w flask-3.1.2 -p none \
  --cases eval/external/flask.eval.json \
  --baseline eval/external/flask.baseline.json
```

No embedding key needed: `-p none` runs the keyword-only (BM25) path, which is
also what the committed Flask baseline measured. Run without `-p none` (with a
real embedding provider) to measure hybrid mode — expect the definition-style
queries to improve; see the known misses below.

## Known misses (keyword-only)

Two of the 27 Flask cases miss in BM25, and both miss the same way: the
defining module is textually sparse, so files that *import* the name outrank
the file that *defines* it.

- `response-wrapper` — `class Response(ResponseBase)` sits in
  `src/flask/wrappers.py`, but the word "Response" is denser in `app.py`.
- `globals-proxy` — `src/flask/globals.py` is 51 lines of `LocalProxy`
  declarations; every module importing `LocalProxy` outranks it.

These are kept, not rephrased into hits: a retrieval change that fixes them is
real progress, and they are exactly where semantic ranking should win.

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
