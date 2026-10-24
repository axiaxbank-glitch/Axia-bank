// Copies only the public website files into ./public for Cloudflare static assets.
// Server code, data files and config are never published.
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, ".."), out = path.join(root, "public");
const skip = new Set([".git", ".github", "node_modules", "data", "db", "worker", "scripts", "public", ".wrangler",
  "server-sandbox.js", "app-core.js", "package.json", "package-lock.json", "wrangler.jsonc", "netliify", "netlify",
  "netlify.toml", "_redirects", ".gitignore", "README.md", "DEPLOY-CLOUDFLARE.md"]);
fs.rmSync(out, { recursive: true, force: true });
function copy(src, dst) {
  for (const name of fs.readdirSync(src)) {
    if (skip.has(name) || name.startsWith(".")) continue;
    const s = path.join(src, name), d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) { copy(s, d); continue; }
    if (!/\.(html|css|js|png|jpe?g|svg|ico|webp|gif|woff2?|ttf|txt|json|mp4|webm)$/i.test(name)) continue;
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(s, d);
  }
}
copy(root, out);
console.log("assets ready in public/");
