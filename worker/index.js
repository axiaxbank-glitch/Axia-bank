// Cloudflare Worker entry for Axia Bank.
// Static pages come from the assets binding (./public). API, redirects and the /chat
// websocket go to a single Durable Object ("main") that runs the same app logic as the
// Node server (app-core.js) and keeps all data in its built-in SQLite storage.
import { DurableObject } from "cloudflare:workers";
import createApp from "../app-core.js";
import db from "../db/store.js";
import seed from "../data/sandbox-store.json";
import * as ops from "./ops.js";

export class AxiaCore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS rows (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tbl, id))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.cache = new Map();
    this.shims = new WeakMap();
    const t = this.sql.exec("SELECT v FROM kv WHERE k = 'chat_threads'").toArray()[0];
    this.threads = t ? JSON.parse(t.v) : {};
    db.setAdminPassword(env.ADMIN_PASSWORD);
    db.setBackend({ read: () => this.readStore(), write: (s) => this.writeStore(s) });
    this.app = createApp(db, {
      threads: this.threads,
      saveThreads: (th) => this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('chat_threads', ?)", JSON.stringify(th)),
      clients: () => ctx.getWebSockets().map((ws) => this.shim(ws)),
    });
    ctx.blockConcurrencyWhile(async () => { await db.init(); });
  }

  async reloadDb() { this.cache.clear(); await db.init(); }

  async ops(u, request) {
    const a = u.pathname.slice(7);
    const j = (x, st = 200) => Response.json(x, { status: st });
    if (a === "export") { const s = ops.snapshot(this); return j(Object.assign(s, { counts: ops.counts(s) })); }
    if (a === "counts") return j(ops.counts(ops.snapshot(this)));
    if (a === "import" && request.method === "POST") return j(await ops.mergeImport(this, await request.json()));
    if (a === "delete-customers" && request.method === "POST") return j(await ops.deleteCustomers(this, (await request.json()).emails || []));
    if (a === "backup" && request.method === "POST") return j(ops.backup(this));
    if (a === "backups") return j(ops.listBackups(this));
    if (a.startsWith("backup/")) { const r = this.sql.exec("SELECT v FROM kv WHERE k = ?", "backup:" + a.slice(7)).toArray()[0]; return r ? new Response(r.v, { headers: { "content-type": "application/json" } }) : j({ error: "not found" }, 404); }
    return j({ error: "unknown" }, 404);
  }

  readStore() {
    const rows = this.sql.exec("SELECT tbl, id, data FROM rows").toArray();
    const kv = this.sql.exec("SELECT k, v FROM kv WHERE k LIKE 'store:%'").toArray();
    if (!rows.length && !kv.length) return seed && seed.customers ? JSON.parse(JSON.stringify(seed)) : null; // first boot: migrate bundled data
    const out = {};
    for (const r of rows) { (out[r.tbl] = out[r.tbl] || []).push(JSON.parse(r.data)); this.cache.set(r.tbl + "\u0000" + r.id, r.data); }
    for (const t in out) out[t].sort((a, b) => (a.id || 0) - (b.id || 0));
    for (const k of kv) out[k.k.slice(6)] = JSON.parse(k.v);
    return out;
  }

  writeStore(store) {
    const seen = new Set();
    for (const tbl of Object.keys(store)) {
      const val = store[tbl];
      if (!Array.isArray(val)) {
        this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", "store:" + tbl, JSON.stringify(val));
        continue;
      }
      val.forEach((row, i) => {
        const id = String(row.id != null ? row.id : "i" + i);
        const key = tbl + "\u0000" + id;
        const data = JSON.stringify(row);
        seen.add(key);
        if (this.cache.get(key) !== data) {
          this.sql.exec("INSERT OR REPLACE INTO rows (tbl, id, data) VALUES (?, ?, ?)", tbl, id, data);
          this.cache.set(key, data);
        }
      });
    }
    for (const key of [...this.cache.keys()]) {
      if (seen.has(key)) continue;
      const [tbl, id] = key.split("\u0000");
      this.sql.exec("DELETE FROM rows WHERE tbl = ? AND id = ?", tbl, id);
      this.cache.delete(key);
    }
  }

  // Wraps a hibernatable WebSocket so app-core's chat code can treat it like a `ws` client.
  shim(ws) {
    let s = this.shims.get(ws);
    if (s) return s;
    const att = ws.deserializeAttachment() || {};
    s = { raw: ws, _onmsg: null, send: (d) => ws.send(d), close: () => { try { ws.close(1000); } catch (e) {} },
      on: (ev, fn) => { if (ev === "message") s._onmsg = fn; } };
    Object.defineProperty(s, "readyState", { get: () => ws.readyState });
    for (const k of ["role", "threadId", "authed", "name"]) {
      Object.defineProperty(s, k, { get: () => att[k], set: (v) => { att[k] = v; ws.serializeAttachment(att); } });
    }
    this.shims.set(ws, s);
    return s;
  }

  async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname.startsWith("/__ops/")) return this.ops(u, request);
    if (u.pathname === "/chat") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.app.onConnection(this.shim(pair[1]));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const body = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
    const headers = Object.fromEntries(request.headers);
    const req = {
      method: request.method, url: u.pathname + u.search, headers,
      socket: { remoteAddress: request.headers.get("cf-connecting-ip") || "local" },
      on(ev, fn) { if (ev === "data" && body) queueMicrotask(() => fn(body)); if (ev === "end") setTimeout(fn, 0); },
      destroy() {},
    };
    return new Promise((resolve) => {
      let status = 200; const h = new Headers();
      const res = {
        setHeader: (k, v) => h.set(k, v),
        writeHead: (code, hdrs) => { status = code; for (const k in hdrs || {}) h.set(k, hdrs[k]); },
        end: (data) => resolve(new Response(status === 204 || status === 304 ? null : (data == null ? "" : data), { status, headers: h })),
      };
      Promise.resolve(this.app.handler(req, res)).catch((e) => { console.error(e); resolve(Response.json({ error: "Server error" }, { status: 500 })); });
    });
  }

  async webSocketMessage(ws, message) {
    const s = this.shim(ws);
    if (!s._onmsg) this.app.onConnection(s); // woke from hibernation: re-register handler
    if (s._onmsg) s._onmsg(typeof message === "string" ? message : new TextDecoder().decode(message));
  }
  async webSocketClose(ws) { try { ws.close(1000); } catch (e) {} }
}

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    if (p.startsWith("/__ops/")) {
      const k = request.headers.get("x-ops-key") || "";
      if (!env.OPS_KEY || k.length < 32 || k !== env.OPS_KEY) return new Response("Not found", { status: 404 });
      return env.AXIA.get(env.AXIA.idFromName("main")).fetch(request);
    }
    if (p === "/chat" || p.startsWith("/api/") || ["/healthz", "/login", "/signin", "/register", "/signup", "/admin-login", "/admin-login.html", "/app-id.html", "/app-verify.html"].includes(p)) {
      return env.AXIA.get(env.AXIA.idFromName("main")).fetch(request);
    }
    if (p === "/") return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    const r = await env.AXIA.get(env.AXIA.idFromName("main")).fetch(new Request("https://internal/__ops/backup", { method: "POST" }));
    console.log("daily backup", r.status, await r.text());
  },
};
