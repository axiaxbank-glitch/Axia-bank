const fs = require("fs");
const path = require("path");
const crypto = require("crypto");


const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "..", "data");
const DATA = path.join(DATA_DIR, "sandbox-store.json");
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
