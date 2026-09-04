const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(__dirname, "..", "data", "axia-sandbox.db");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

let SQL = null;
let db = null;

function now() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return salt + ":" + hash;
}

function checkPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(password, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(next, "hex"));
}

function persist() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function exec(sql) {
  db.exec(sql);
}

function run(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  stmt.step();
  stmt.free();
  persist();
}

function all(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params) {
  return all(sql, params)[0] || null;
}

function lastId() {
  return get("SELECT last_insert_rowid() AS id").id;
}

async function init() {
  if (db) return;
  const initSqlJs = require("sql.js");
  SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  seed();
  persist();
}

function seed() {
  if (!get("SELECT id FROM roles WHERE name=?", ["super_admin"])) {
    run("INSERT INTO roles (name, description) VALUES (?, ?)", ["super_admin", "Full SANDBOX control"]);
    run("INSERT INTO roles (name, description) VALUES (?, ?)", ["support", "Chat and review requests"]);
  }
  if (!get("SELECT id FROM admins WHERE email=?", ["admin@axia.local"])) {
    const role = get("SELECT id FROM roles WHERE name=?", ["super_admin"]);
    run(
      "INSERT INTO admins (role_id, email, password_hash, full_name, created_at) VALUES (?, ?, ?, ?, ?)",
      [role.id, "admin@axia.local", hashPassword("SandboxAdmin1"), "Axia Sandbox Admin", now()]
    );
  }
}

function accountNumber() {
  return "48" + String(Math.floor(10000000 + Math.random() * 89999999));
}

function audit(actorType, actorId, action, entity, entityId, detail) {
  run(
    "INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [actorType, actorId || 0, action, entity, entityId || 0, detail || "", now()]
  );
}

function notify(customerId, title, body) {
  run(
    "INSERT INTO notifications (customer_id, admin_id, title, body, is_read, created_at) VALUES (?, NULL, ?, ?, 0, ?)",
    [customerId, title, body, now()]
  );
}

function createSession(actorType, actorId) {
  const token = crypto.randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  run(
    "INSERT INTO sessions (token, actor_type, actor_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    [token, actorType, actorId, expires, now()]
  );
  return { token, expires_at: expires };
}

function sessionUser(token) {
  if (!token) return null;
  const row = get("SELECT * FROM sessions WHERE token=?", [token]);
  if (!row || row.expires_at < now()) return null;
  if (row.actor_type === "admin") {
    const admin = get(
      "SELECT admins.*, roles.name AS role FROM admins JOIN roles ON roles.id=admins.role_id WHERE admins.id=?",
      [row.actor_id]
    );
    return admin ? { type: "admin", ...admin } : null;
  }
  const customer = get("SELECT * FROM customers WHERE id=?", [row.actor_id]);
  return customer ? { type: "customer", ...customer } : null;
}

module.exports = {
  init,
  run,
  all,
  get,
  lastId,
  now,
  hashPassword,
  checkPassword,
  accountNumber,
  audit,
  notify,
  createSession,
  sessionUser,
  persist
};
