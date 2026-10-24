// Admin-only maintenance: export, idempotent merge-import, customer delete, daily backups.
const STRIP = ["id_front", "id_back", "ssn_hash", "ssn_last4", "ssn"];
const SKIP = new Set(["sessions", "roles", "admins", "seq"]);
const clone = (x) => JSON.parse(JSON.stringify(x));
const maxId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);

export function snapshot(core) {
  const store = core.readStore() || {};
  const t = core.sql.exec("SELECT v FROM kv WHERE k = 'chat_threads'").toArray()[0];
  return { exported_at: new Date().toISOString(), store, chat_threads: t ? JSON.parse(t.v) : {} };
}

export function counts(snap) {
  const c = {};
  for (const k in snap.store) if (Array.isArray(snap.store[k])) c[k] = snap.store[k].length;
  c.chat_threads = Object.keys(snap.chat_threads || {}).length;
  c.chat_messages = Object.values(snap.chat_threads || {}).reduce((n, a) => n + a.length, 0);
  return c;
}

async function commit(core, store, threads) {
  core.writeStore(store);
  if (threads) {
    for (const k of Object.keys(core.threads)) delete core.threads[k];
    Object.assign(core.threads, threads);
    core.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('chat_threads', ?)", JSON.stringify(threads));
  }
  await core.reloadDb();
}

export async function mergeImport(core, payload) {
  const old = clone(payload.store || payload);
  const snap = snapshot(core);
  const live = snap.store; live.seq = live.seq || {};
  const added = {};
  const add = (tbl, row) => {
    live[tbl] = live[tbl] || [];
    row.id = Math.max(maxId(live[tbl]), live.seq[tbl] || 0) + 1;
    live.seq[tbl] = row.id; live[tbl].push(row); added[tbl] = (added[tbl] || 0) + 1;
  };
  const custMap = {}, acctMap = {};
  for (const c of old.customers || []) {
    STRIP.forEach((k) => delete c[k]);
    const hit = (live.customers || []).find((x) => String(x.email).toLowerCase() === String(c.email).toLowerCase());
    if (hit) { custMap[c.id] = hit.id; continue; }
    const oid = c.id; add("customers", c); custMap[oid] = c.id;
  }
  for (const a of old.accounts || []) {
    const hit = (live.accounts || []).find((x) => x.account_number === a.account_number);
    if (hit) { acctMap[a.id] = hit.id; continue; }
    if (custMap[a.customer_id] == null) continue;
    const oid = a.id; a.customer_id = custMap[a.customer_id]; add("accounts", a); acctMap[oid] = a.id;
  }
  const keyOf = (r) => JSON.stringify([r.customer_id, r.account_id, r.created_at, r.amount_cents, r.title, r.action, r.reference, r.type]);
  for (const tbl of Object.keys(old)) {
    if (SKIP.has(tbl) || tbl === "customers" || tbl === "accounts" || !Array.isArray(old[tbl])) continue;
    for (const r of old[tbl]) {
      if (r.customer_id != null) { if (custMap[r.customer_id] == null) continue; r.customer_id = custMap[r.customer_id]; }
      if (r.account_id != null) { if (acctMap[r.account_id] == null) continue; r.account_id = acctMap[r.account_id]; }
      const k = keyOf(r);
      if ((live[tbl] || []).some((x) => keyOf(x) === k)) continue;
      add(tbl, r);
    }
  }
  let threads = null; let msgs = 0;
  if (payload.chat_threads) {
    threads = clone(snap.chat_threads);
    for (const [id, list] of Object.entries(payload.chat_threads)) {
      const cur = threads[id] || [];
      const seen = new Set(cur.map((m) => JSON.stringify([m.ts || m.time || m.at, m.text || m.body, m.from || m.role])));
      for (const m of list) { const k = JSON.stringify([m.ts || m.time || m.at, m.text || m.body, m.from || m.role]); if (!seen.has(k)) { cur.push(m); seen.add(k); msgs++; } }
      cur.sort((a, b) => String(a.ts || a.time || a.at || "").localeCompare(String(b.ts || b.time || b.at || "")));
      threads[id] = cur;
    }
  }
  await commit(core, live, threads);
  return { added, chat_messages_added: msgs };
}

export async function deleteCustomers(core, emails) {
  const snap = snapshot(core); const s = snap.store;
  const want = new Set(emails.map((e) => String(e).toLowerCase()));
  const ids = new Set((s.customers || []).filter((c) => want.has(String(c.email).toLowerCase())).map((c) => c.id));
  const accts = new Set((s.accounts || []).filter((a) => ids.has(a.customer_id)).map((a) => a.id));
  const removed = {};
  for (const tbl of Object.keys(s)) {
    if (!Array.isArray(s[tbl])) continue;
    const before = s[tbl].length;
    s[tbl] = s[tbl].filter((r) => !(
      (tbl === "customers" && ids.has(r.id)) || (tbl === "accounts" && ids.has(r.customer_id)) ||
      (tbl !== "customers" && tbl !== "audit_logs" && r.customer_id != null && ids.has(r.customer_id)) ||
      (r.account_id != null && accts.has(r.account_id)) ||
      (tbl === "sessions" && r.actor_type === "customer" && ids.has(r.actor_id))));
    if (s[tbl].length !== before) removed[tbl] = before - s[tbl].length;
  }
  const threads = clone(snap.chat_threads);
  for (const e of want) if (threads[e]) { delete threads[e]; removed.chat_threads = (removed.chat_threads || 0) + 1; }
  await commit(core, s, threads);
  return { customer_ids: [...ids], removed };
}

export function backup(core, keepDays = 30) {
  const snap = snapshot(core);
  const key = "backup:" + snap.exported_at.slice(0, 10);
  core.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", key, JSON.stringify(snap));
  const cutoff = "backup:" + new Date(Date.now() - keepDays * 864e5).toISOString().slice(0, 10);
  core.sql.exec("DELETE FROM kv WHERE k LIKE 'backup:%' AND k < ?", cutoff);
  return { key, counts: counts(snap) };
}

export function listBackups(core) {
  return core.sql.exec("SELECT k, length(v) AS bytes FROM kv WHERE k LIKE 'backup:%' ORDER BY k").toArray();
}
