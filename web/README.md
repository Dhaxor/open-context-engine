# opencontextengine.com

Static site — no build step, no framework. `index.html` + `pricing.html` +
`oce.css` + `site.js`. Design system: `.interface-design/system.md`.

## Deploy (Cloudflare, domain already on CF)

Either connect the repo in the dashboard (Workers & Pages → Create → Pages →
connect `Dhaxor/open-context-engine`, build command *none*, output dir `web`),
or push from the CLI:

```bash
npx wrangler pages project create opencontextengine --production-branch main
npx wrangler pages deploy web --project-name opencontextengine
```

Then Pages → Custom domains → add `opencontextengine.com` (DNS is already on
Cloudflare, so it's one click) and `www` if wanted.

## Checkout

The Team plan's button is wired to Polar (`buy.polar.sh/polar_cl_…`, created
under the `opencontextengine` org; the product is "Open Context Team", $25/mo).
Enterprise stays mailto by design.

## License fulfillment (self-serve)

The Worker (`worker.ts`, same deploy) exposes `POST /api/license/activate`:
it validates a Polar license key against Polar's API, records the activation,
and returns an Ed25519-signed license token that `oce activate <polar_lk_…>`
saves locally (verified offline forever after — see `src/server/license-activate.ts`).

Worker secrets (`npx wrangler secret put <NAME>`):

- `LICENSE_SIGNING_KEY` — **set.** PKCS8 PEM; its public half is
  `EMBEDDED_PUBLIC_KEY_B64` in `src/core/license.ts` (rotated 2026-10-27; the
  private key also lives at `business/keys/` — gitignored — keep a backup).
- `POLAR_ACCESS_TOKEN` — **not set yet.** Fine-grained Polar token with
  license-key read + activate scopes. Polar dashboard → Settings → Personal
  access tokens → create, then `wrangler secret put POLAR_ACCESS_TOKEN`.

Dashboard-side (Polar, one time): Products → Open Context Team → Benefits →
add a **License Key** benefit so buyers are emailed a `polar_lk_…` key; note
its benefit id and set `POLAR_TEAM_BENEFIT_ID` if you want explicit plan
mapping (defaults to `team` otherwise). Until the token is set, the endpoint
answers 503 `"license server not configured"` and buyers can still be issued
manual keys via `scripts/license-tool.mjs sign`.

## Local preview

```bash
python3 -m http.server 8907 --directory web
```
