# Deploy Axia Bank on Cloudflare (Workers Free plan)

Architecture: static pages are served from Workers static assets (`public/`, built by `scripts/build-assets.js`).
`/api/*`, `/chat` (WebSocket) and the short redirects go to one Durable Object (`AxiaCore`, SQLite-backed, Free-plan compatible)
that runs the same logic as the Node server (`app-core.js`). All data lives in the Durable Object's SQLite storage.
On first boot it imports `data/sandbox-store.json` (ID/SSN fields stripped), so existing customers keep their logins.
Chat uses WebSocket hibernation, so idle connections don't use up the free quota. Nothing sleeps.

## Steps
1. `npm ci`
2. `export CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_PM` (token: Workers Scripts Edit + Account Settings Read; add Zone DNS Edit + Workers Routes Edit for axia-bank.com)
3. `npx wrangler secret put ADMIN_PASSWORD`  (otherwise the admin password resets to the default SandboxAdmin1 on every boot)
4. `npx wrangler deploy`
5. Custom domain: add axia-bank.com to the same Cloudflare account, then uncomment `routes` in wrangler.jsonc and deploy again
   (or Dashboard > Workers > axia-bank > Settings > Domains & Routes > Add custom domain).
6. Check: `curl https://axia-bank.com/healthz` returns `{"ok":true}`.

Local: `npx wrangler dev` (Worker) or `npm start` (Node; uses PORT and DATA_DIR).
