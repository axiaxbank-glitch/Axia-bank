const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA = path.join(__dirname, "..", "data", "sandbox-store.json");
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
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  if (fs.existsSync(DATA)) store = Object.assign({}, empty, JSON.parse(fs.readFileSync(DATA, "utf8")));
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

module.exports = {
  init: init, now: now, hashPassword: hashPassword, checkPassword: checkPassword,
  accountNumber: accountNumber, audit: audit, notify: notify,
  createSession: createSession, sessionUser: sessionUser,
  all: all, get: get, insert: insert, update: update, removeSession: removeSession
};
