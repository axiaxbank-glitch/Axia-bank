const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const DATA = path.join(DATA_DIR, "sandbox-store.json");
const SEED = path.join(__dirname, "..", "data", "sandbox-store.json");
const empty = {
  roles: [], admins: [], customers: [], accounts: [],
  deposit_requests: [], withdrawal_requests: [], transactions: [],
  notifications: [], audit_logs: [], sessions: [], cards: [], seq: {}
};
let store = JSON.parse(JSON.stringify(empty));

function now() { return new Date().toISOString(); }
function persist() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(store, null, 2));
}
function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // First boot on a fresh volume: start from the bundled store so existing customers can still sign in.
  if (!fs.existsSync(DATA) && DATA !== SEED && fs.existsSync(SEED)) fs.copyFileSync(SEED, DATA);
  if (fs.existsSync(DATA)) store = Object.assign({}, empty, JSON.parse(fs.readFileSync(DATA, "utf8")));
  // ID photos and SSNs are no longer collected; scrub any left over from older versions.
  var scrubbed = false;
  (store.customers || []).forEach(function (c) {
    ["id_front", "id_back", "ssn_hash", "ssn_last4", "ssn"].forEach(function (k) {
      if (k in c) { delete c[k]; scrubbed = true; }
    });
  });
  if (scrubbed) persist();
}
function nextId(table) { store.seq[table] = (store.seq[table] || 0) + 1; return store.seq[table]; }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return salt + ":" + hash;
}
function checkPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(String(password), salt, 32).toString("hex");
  try { return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(next, "hex")); }
  catch (e) { return false; }
}
function addAdmin(email, name) {
  var role = store.roles.find(function (r) { return r.name === "super_admin"; });
  var existing = store.admins.find(function (a) { return a.email === email; });
  if (existing) {
    existing.password_hash = hashPassword("SandboxAdmin1");
    existing.full_name = name;
    existing.role_id = role.id;
    return;
  }
  store.admins.push({
    id: nextId("admins"),
    role_id: role.id,
    email: email,
    password_hash: hashPassword("SandboxAdmin1"),
    full_name: name,
    created_at: now()
  });
}
async function init() {
  load();
  if (!store.roles.find(function (r) { return r.name === "super_admin"; })) {
    store.roles.push({ id: nextId("roles"), name: "super_admin", description: "Full control" });
    store.roles.push({ id: nextId("roles"), name: "support", description: "Chat and review" });
  }
  addAdmin("admin@axia.local", "Axia Admin");
  addAdmin("support@axia-bank.com", "Axia Support");
  seedStudent();
  persist();
}
function seedStudent() {
  if (store.customers.find(function (c) { return c.email === "student@axia.local"; })) return;
  var id = nextId("customers");
  store.customers.push({
    id: id,
    username: "student",
    email: "student@axia.local",
    password_hash: hashPassword("Student1234"),
    pin_hash: hashPassword("1234"),
    first_name: "Alex",
    last_name: "Student",
    phone: "312-555-0148",
    address: "100 State St, Chicago, IL",
    country: "United States",
    account_type: "checking",
    employment: "Student",
    profile_pic: "",
    status: "active",
    kyc_complete: 1,
    ssn_last4: "1234",
    created_at: now()
  });
  var checkId = nextId("accounts");
  var saveId = nextId("accounts");
  store.accounts.push({
    id: checkId, customer_id: id, account_number: "482100112233", routing_number: "071000013",
    product: "Checking", available_cents: 2458000, ledger_cents: 2458000, status: "open", created_at: now()
  });
  store.accounts.push({
    id: saveId, customer_id: id, account_number: "482199887766", routing_number: "071000013",
    product: "Savings", available_cents: 633950, ledger_cents: 633950, status: "open", created_at: now()
  });
  store.transactions.push({
    id: nextId("transactions"), account_id: checkId, customer_id: id, type: "deposit", direction: "credit",
    amount_cents: 4000000, balance_after_cents: 2458000, reference: "SEED", status: "posted",
    bank_name: "Axia Bank", holder_name: "Alex Student", counterparty_account: "482100112233", set_time: now(),
    created_at: now()
  });
}
function all(table, fn) { const rows = store[table] || []; return fn ? rows.filter(fn) : rows.slice(); }
function get(table, fn) { return all(table, fn)[0] || null; }
function insert(table, row) {
  const rec = Object.assign({ id: nextId(table) }, row);
  store[table].push(rec); persist(); return rec;
}
function update(table, id, patch) {
  const i = store[table].findIndex(function (r) { return r.id === id; });
  if (i < 0) return null;
  store[table][i] = Object.assign({}, store[table][i], patch);
  persist(); return store[table][i];
}
function removeSession(token) {
  store.sessions = (store.sessions || []).filter(function (s) { return s.token !== token; });
  persist();
}
function accountNumber(kind) {
  var prefix = String(kind).toLowerCase().indexOf("sav") !== -1 ? "49" : "48";
  return prefix + String(Math.floor(100000000 + Math.random() * 899999999));
}
function audit(actorType, actorId, action, entity, entityId, detail) {
  insert("audit_logs", { actor_type: actorType, actor_id: actorId || 0, action: action, entity: entity, entity_id: entityId || 0, detail: detail || "", created_at: now() });
}
function notify(customerId, title, body) {
  insert("notifications", { customer_id: customerId, admin_id: null, title: title, body: body, is_read: 0, created_at: now() });
}
function createSession(actorType, actorId, extra) {
  const token = crypto.randomBytes(24).toString("hex");
  insert("sessions", {
    token: token,
    actor_type: actorType,
    actor_id: actorId,
    step: extra && extra.step ? extra.step : "full",
    expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    created_at: now()
  });
  return { token: token };
}
function sessionUser(token) {
  if (!token) return null;
  const row = get("sessions", function (s) { return s.token === token; });
  if (!row || row.expires_at < now()) return null;
  if (row.actor_type === "admin") {
    const admin = get("admins", function (a) { return a.id === row.actor_id; });
    if (!admin) return null;
    const role = get("roles", function (r) { return r.id === admin.role_id; });
    return Object.assign({ type: "admin", role: role ? role.name : "", step: row.step || "full" }, admin);
  }
  const customer = get("customers", function (c) { return c.id === row.actor_id; });
  if (!customer) return null;
  return Object.assign({ type: "customer", step: row.step || "full" }, customer);
}

// ---- Backup / restore ----
var STRIP = ["id_front", "id_back", "ssn_hash", "ssn_last4", "ssn"];
var SKIP = { sessions: 1, roles: 1, admins: 1, seq: 1 };
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function maxId(rows) { return rows.reduce(function (m, r) { return Math.max(m, Number(r.id) || 0); }, 0); }
function snapshot() {
  var out = {};
  Object.keys(store).forEach(function (k) { if (!SKIP[k] && Array.isArray(store[k])) out[k] = clone(store[k]); });
  return { format: "axia-backup", version: 1, exported_at: now(), store: out };
}
function counts(snap) {
  var c = {};
  Object.keys(snap.store || {}).forEach(function (k) { if (Array.isArray(snap.store[k])) c[k] = snap.store[k].length; });
  return c;
}
// Idempotent merge: customers matched by email, accounts by account number, other rows by content.
// Accepts this server's backup and the Cloudflare Worker's /__ops/export file.
function mergeImport(payload) {
  var old = clone((payload && payload.store) || payload || {});
  var added = {};
  function add(tbl, row) {
    store[tbl] = store[tbl] || [];
    store.seq = store.seq || {};
    row.id = Math.max(maxId(store[tbl]), store.seq[tbl] || 0) + 1;
    store.seq[tbl] = row.id; store[tbl].push(row); added[tbl] = (added[tbl] || 0) + 1;
  }
  var custMap = {}, acctMap = {};
  (old.customers || []).forEach(function (c) {
    STRIP.forEach(function (k) { delete c[k]; });
    var hit = store.customers.find(function (x) { return String(x.email).toLowerCase() === String(c.email).toLowerCase(); });
    if (hit) { custMap[c.id] = hit.id; return; }
    var oid = c.id; add("customers", c); custMap[oid] = c.id;
  });
  (old.accounts || []).forEach(function (a) {
    var hit = store.accounts.find(function (x) { return x.account_number === a.account_number; });
    if (hit) { acctMap[a.id] = hit.id; return; }
    if (custMap[a.customer_id] == null) return;
    var oid = a.id; a.customer_id = custMap[a.customer_id]; add("accounts", a); acctMap[oid] = a.id;
  });
  function keyOf(r) { return JSON.stringify([r.customer_id, r.account_id, r.created_at, r.amount_cents, r.title, r.action, r.reference, r.type]); }
  Object.keys(old).forEach(function (tbl) {
    if (SKIP[tbl] || tbl === "customers" || tbl === "accounts" || !Array.isArray(old[tbl])) return;
    store[tbl] = store[tbl] || [];
    var seen = {};
    store[tbl].forEach(function (x) { seen[keyOf(x)] = 1; });
    old[tbl].forEach(function (r) {
      if (r.customer_id != null) { if (custMap[r.customer_id] == null) return; r.customer_id = custMap[r.customer_id]; }
      if (r.account_id != null) { if (acctMap[r.account_id] == null) return; r.account_id = acctMap[r.account_id]; }
      var k = keyOf(r);
      if (seen[k]) return;
      seen[k] = 1; add(tbl, r);
    });
  });
  persist();
  return { added: added };
}
function writeBackupFile() {
  var dir = path.join(DATA_DIR, "backups");
  fs.mkdirSync(dir, { recursive: true });
  var name = "axia-backup-" + now().slice(0, 10) + ".json";
  fs.writeFileSync(path.join(dir, name), JSON.stringify(snapshot()));
  fs.readdirSync(dir).filter(function (f) { return /^axia-backup-.*\.json$/.test(f); }).sort().slice(0, -14)
    .forEach(function (f) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
  return name;
}

module.exports = {
  snapshot: snapshot, counts: counts, mergeImport: mergeImport, writeBackupFile: writeBackupFile,
  init: init, now: now, hashPassword: hashPassword, checkPassword: checkPassword,
  accountNumber: accountNumber, audit: audit, notify: notify,
  createSession: createSession, sessionUser: sessionUser,
  all: all, get: get, insert: insert, update: update, removeSession: removeSession
};
