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

## Wiring checkout (when Polar products exist)

`pricing.html` has one `TODO(polar)` marker — replace the Team plan's mailto
href with the Polar checkout link. Enterprise stays mailto by design.

## Local preview

```bash
python3 -m http.server 8907 --directory web
```
