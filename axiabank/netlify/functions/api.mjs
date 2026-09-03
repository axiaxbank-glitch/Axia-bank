import { getStore } from "@netlify/blobs";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SECRET = process.env.AXIA_SECRET || "axia-change-this-secret";
const ADMIN_EMAIL = "support@axia-bank.com";
const ADMIN_PASSWORD = "SandboxAdmin1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function store() {
  return getStore("axia-bank");
}

async function loadDb() {
  const raw = await store().get("db", { type: "json" });
  if (raw && raw.users) return raw;
  const admin = makeUser({
    id: 1,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    role: "admin",
    name: "Axia Admin",
    first_name: "Axia",
    last_name: "Admin",
    status: "active"
  });
  return {
    nextId: 2,
    users: [admin],
    customers: [],
    transactions: [],
    deposits: [],
    withdrawals: [],
    cards: [],
    notes: [],
    chats: {}
  };
}

async function saveDb(db) {
  await store().setJSON("db", db);
}

function hashPassword(password, salt) {
  const useSalt = salt || randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), useSalt, 32).toString("hex");
  return { salt: useSalt, hash };
}

function checkPassword(password, user) {
  if (!user || !user.pass_hash || !user.pass_salt) return false;
  const { hash } = hashPassword(password, user.pass_salt);
  try {
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.pass_hash, "hex"));
  } catch {
    return false;
  }
}

function makeUser(fields) {
  const { hash, salt } = hashPassword(fields.password || "ChangeMe123");
  return {
    id: fields.id,
    email: String(fields.email || "").toLowerCase().trim(),
    username: fields.username || String(fields.email || "").split("@")[0],
    role: fields.role || "customer",
    name: fields.name || `${fields.first_name || ""} ${fields.last_name || ""}`.trim(),
    first_name: fields.first_name || "",
    last_name: fields.last_name || "",
    phone: fields.phone || "",
    address: fields.address || "",
    country: fields.country || "",
    employment: fields.employment || "",
    status: fields.status || "pending",
    ssn_last4: fields.ssn_last4 || "",
    balance_cents: Number(fields.balance_cents || 0),
    account_number: fields.account_number || accountNumber(fields.id),
    pass_hash: hash,
    pass_salt: salt,
    created_at: new Date().toISOString()
  };
}

function accountNumber(id) {
  return "AX" + String(10000000 + Number(id || 1)).slice(-8);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    name: u.name,
    first_name: u.first_name,
    last_name: u.last_name,
    phone: u.phone,
    address: u.address,
    country: u.country,
    employment: u.employment,
    status: u.status,
    ssn_last4: u.ssn_last4,
    balance_cents: u.balance_cents,
    account_number: u.account_number
  };
}

function signToken(user) {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = `${user.id}.${user.role}.${exp}`;
  const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function readToken(header) {
  const raw = String(header || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [id, role, exp, sig] = parts;
  const payload = `${id}.${role}.${exp}`;
  const expect = createHmac("sha256", SECRET).update(payload).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  if (Number(exp) < Date.now()) return null;
  return { id: Number(id), role };
}

function parseAmount(value) {
  const n = Number(String(value || "0").replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function findCustomer(db, id) {
  return db.customers.find((c) => Number(c.id) === Number(id)) ||
    db.users.find((u) => Number(u.id) === Number(id) && u.role !== "admin");
}

function requireAdmin(req, db) {
  const auth = readToken(req.headers.get("authorization"));
  if (!auth) return { error: json({ error: "Please sign in" }, 401) };
  const user = db.users.find((u) => Number(u.id) === Number(auth.id));
  if (!user || user.role !== "admin") return { error: json({ error: "This portal is for admin only" }, 403) };
  return { user };
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export default async (req) => {
  const url = new URL(req.url);
  let path = url.pathname.replace(/\/+$/, "") || "/";
  if (path.startsWith("/.netlify/functions/api")) {
    path = "/api" + path.slice("/.netlify/functions/api".length);
  }
  const method = req.method.toUpperCase();

  let db;
  try {
    db = await loadDb();
  } catch (err) {
    return json({ error: "Database not ready. Redeploy with Netlify Functions enabled." }, 500);
  }

  if (method === "OPTIONS") return new Response("", { status: 204 });

  if (path === "/api/auth/login" && method === "POST") {
    const body = await readBody(req);
    const email = String(body.email || body.username || "").toLowerCase().trim();
    const password = String(body.password || "");
    const user = db.users.find((u) => u.email === email || u.username === email);
    if (!user || !checkPassword(password, user)) {
      return json({ error: "Wrong email or password" }, 401);
    }
    return json({
      token: signToken(user),
      role: user.role,
      name: user.name,
      email: user.email
    });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    return json({ ok: true });
  }

  if (path === "/api/auth/register" && method === "POST") {
    const body = await readBody(req);
    const email = String(body.email || "").toLowerCase().trim();
    const username = String(body.username || email.split("@")[0]).trim();
    const password = String(body.password || "");
    if (!email || !password) return json({ error: "Email and password required" }, 400);
    if (db.users.some((u) => u.email === email || u.username === username)) {
      return json({ error: "That email or username is already used" }, 400);
    }
    const id = db.nextId++;
    const user = makeUser({
      id,
      email,
      username,
      password,
      role: "customer",
      first_name: body.first_name || "",
      last_name: body.last_name || "",
      name: `${body.first_name || ""} ${body.last_name || ""}`.trim() || username,
      phone: body.phone || "",
      address: body.address || "",
      country: body.country || "",
      status: "pending"
    });
    user.state = body.state || "";
    user.city = body.city || "";
    user.postal_code = body.postal_code || "";
    user.account_type = body.account_type || "";
    user.dob = body.dob || "";
    user.profile_pic = body.profile_pic || "";
    db.users.push(user);
    db.customers.push(user);
    await saveDb(db);
    return json({
      ok: true,
      apply_token: signToken(user),
      id: user.id
    });
  }

  if (path === "/api/auth/kyc" && method === "POST") {
    const body = await readBody(req);
    const auth = readToken(body.apply_token ? "Bearer " + body.apply_token : req.headers.get("authorization"));
    if (!auth) return json({ error: "Start registration first" }, 401);
    const user = db.users.find((u) => Number(u.id) === Number(auth.id));
    if (!user) return json({ error: "Account not found" }, 404);
    const ssn = String(body.ssn || "").replace(/\D/g, "");
    user.ssn_last4 = ssn.slice(-4);
    user.id_front = body.id_front ? "uploaded" : "";
    user.id_back = body.id_back ? "uploaded" : "";
    user.status = "pending";
    await saveDb(db);
    return json({ ok: true, status: user.status });
  }

  if (path === "/api/me" && method === "GET") {
    const auth = readToken(req.headers.get("authorization"));
    if (!auth) return json({ error: "Please sign in", role: "" }, 401);
    const user = db.users.find((u) => Number(u.id) === Number(auth.id));
    if (!user) return json({ error: "Please sign in", role: "" }, 401);
    return json(publicUser(user));
  }

  if (path === "/api/admin/overview" && method === "GET") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    return json({
      customers: db.customers.length,
      pending_accounts: db.customers.filter((c) => c.status === "pending" || c.status === "draft").length,
      pending_deposits: db.deposits.filter((d) => d.status === "pending").length,
      pending_withdrawals: db.withdrawals.filter((d) => d.status === "pending").length
    });
  }

  if (path === "/api/admin/customers" && method === "GET") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    return json({ customers: db.customers.map(publicUser) });
  }

  const detail = path.match(/^\/api\/admin\/customers\/(\d+)\/detail$/);
  if (detail && method === "GET") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const customer = findCustomer(db, detail[1]);
    if (!customer) return json({ error: "Customer not found" }, 404);
    return json({
      customer: publicUser(customer),
      accounts: [{
        account_number: customer.account_number,
        type: "checking",
        balance_cents: customer.balance_cents
      }],
      transactions: db.transactions.filter((t) => Number(t.customer_id) === Number(customer.id))
    });
  }

  const fund = path.match(/^\/api\/admin\/customers\/(\d+)\/fund$/);
  if (fund && method === "POST") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const body = await readBody(req);
    const customer = findCustomer(db, fund[1]);
    if (!customer) return json({ error: "Select a student first" }, 400);
    const cents = parseAmount(body.amount);
    customer.balance_cents = Number(customer.balance_cents || 0) + cents;
    if (body.account_number) customer.account_number = body.account_number;
    db.transactions.unshift({
      id: db.nextId++,
      customer_id: customer.id,
      type: "credit",
      amount_cents: cents,
      bank_name: body.bank_name || "Axia Bank",
      holder_name: body.holder_name || customer.name,
      counterparty_account: body.account_number || customer.account_number,
      set_time: body.set_time || "",
      created_at: new Date().toISOString()
    });
    await saveDb(db);
    return json({
      ok: true,
      mail: {
        email: customer.email,
        name: customer.name,
        amount: (cents / 100).toFixed(2),
        purpose: "Account credit",
        date: new Date().toLocaleString()
      }
    });
  }

  const debit = path.match(/^\/api\/admin\/customers\/(\d+)\/debit$/);
  if (debit && method === "POST") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const body = await readBody(req);
    const customer = findCustomer(db, debit[1]);
    if (!customer) return json({ error: "Select a student first" }, 400);
    const cents = parseAmount(body.amount);
    customer.balance_cents = Math.max(0, Number(customer.balance_cents || 0) - cents);
    db.transactions.unshift({
      id: db.nextId++,
      customer_id: customer.id,
      type: "debit",
      amount_cents: cents,
      bank_name: body.bank_name || "Axia Bank",
      holder_name: body.holder_name || customer.name,
      counterparty_account: body.account_number || customer.account_number,
      set_time: body.set_time || "",
      created_at: new Date().toLocaleString && new Date().toISOString()
    });
    await saveDb(db);
    return json({
      ok: true,
      mail: {
        email: customer.email,
        name: customer.name,
        amount: (cents / 100).toFixed(2),
        purpose: "Account debit",
        date: new Date().toLocaleString()
      }
    });
  }

  const statusPath = path.match(/^\/api\/admin\/customers\/(\d+)\/status$/);
  if (statusPath && method === "POST") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const body = await readBody(req);
    const customer = findCustomer(db, statusPath[1]);
    if (!customer) return json({ error: "Customer not found" }, 404);
    customer.status = body.status || customer.status;
    await saveDb(db);
    return json({ ok: true, status: customer.status });
  }

  const notePath = path.match(/^\/api\/admin\/customers\/(\d+)\/note$/);
  if (notePath && method === "POST") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const body = await readBody(req);
    const customer = findCustomer(db, notePath[1]);
    if (!customer) return json({ error: "Customer not found" }, 404);
    db.notes.unshift({
      id: db.nextId++,
      customer_id: customer.id,
      title: body.title || "Note",
      body: body.body || "",
      created_at: new Date().toISOString()
    });
    await saveDb(db);
    return json({ ok: true });
  }

  const approvePath = path.match(/^\/api\/admin\/customers\/(\d+)\/approve$/);
  if (approvePath && method === "POST") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const customer = findCustomer(db, approvePath[1]);
    if (!customer) return json({ error: "Customer not found" }, 404);
    customer.status = "active";
    if (!customer.account_number) customer.account_number = accountNumber(customer.id);
    await saveDb(db);
    return json({
      ok: true,
      mail: { email: customer.email, name: customer.name }
    });
  }

  const declinePath = path.match(/^\/api\/admin\/customers\/(\d+)\/decline$/);
  if (declinePath && method === "POST") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const customer = findCustomer(db, declinePath[1]);
    if (!customer) return json({ error: "Customer not found" }, 404);
    customer.status = "declined";
    await saveDb(db);
    return json({ ok: true });
  }

  const itemAction = path.match(/^\/api\/admin\/(deposits|withdrawals|cards)\/(\d+)\/(approve|decline)$/);
  if (itemAction && method === "POST") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const kind = itemAction[1];
    const bucket = kind === "deposits" ? db.deposits : kind === "withdrawals" ? db.withdrawals : db.cards;
    const row = bucket.find((r) => Number(r.id) === Number(itemAction[2]));
    if (!row) return json({ error: "Not found" }, 404);
    row.status = itemAction[3] === "approve" ? "approved" : "declined";
    await saveDb(db);
    return json({ ok: true, status: row.status });
  }

  const customerPath = path.match(/^\/api\/admin\/customers\/(\d+)$/);
  if (customerPath && method === "POST") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const body = await readBody(req);
    const customer = findCustomer(db, customerPath[1]);
    if (!customer) return json({ error: "Customer not found" }, 404);
    ["first_name", "last_name", "username", "phone", "address", "country", "employment", "status"].forEach((key) => {
      if (body[key] != null) customer[key] = body[key];
    });
    customer.name = `${customer.first_name || ""} ${customer.last_name || ""}`.trim();
    await saveDb(db);
    return json({ ok: true, customer: publicUser(customer) });
  }

  if (path === "/api/admin/deposits" && method === "GET") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    return json({ deposits: db.deposits });
  }
  if (path === "/api/admin/withdrawals" && method === "GET") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    return json({ withdrawals: db.withdrawals });
  }
  if (path === "/api/admin/cards" && method === "GET") {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    return json({ cards: db.cards });
  }

  const action = path.match(/^\/api\/admin\/(deposits|withdrawals|cards)\/(\d+)\/(approve|decline)$/) ||
    path.match(/^\/api\/admin\/(deposits|withdrawals|cards)$/);
  if (method === "POST" && path.startsWith("/api/admin/")) {
    const gate = requireAdmin(req, db);
    if (gate.error) return gate.error;
    const body = await readBody(req);
    const kind = body.kind || (path.includes("deposit") ? "deposits" : path.includes("withdraw") ? "withdrawals" : path.includes("card") ? "cards" : "");
    const id = body.id;
    const act = body.action;
    const bucket = kind === "deposits" ? db.deposits : kind === "withdrawals" ? db.withdrawals : kind === "cards" ? db.cards : null;
    if (bucket && id) {
      const row = bucket.find((r) => Number(r.id) === Number(id));
      if (row) {
        row.status = act === "approve" ? "approved" : "declined";
        await saveDb(db);
        return json({ ok: true, status: row.status });
      }
    }
  }

  if (!db.chats) db.chats = {};

  if (path === "/api/chat" && method === "POST") {
    const body = await readBody(req);
    const auth = readToken(req.headers.get("authorization") || (body.token ? "Bearer " + body.token : ""));
    const user = auth ? db.users.find((u) => Number(u.id) === Number(auth.id)) : null;
    if (!user) return json({ error: "Sign in first" }, 401);

    const role = user.role === "admin" ? "admin" : "user";
    const from = role === "admin" ? "admin" : (user.email || user.username || "customer");
    let threadId = String(body.threadId || "").toLowerCase().trim();
    if (role !== "admin") threadId = String(user.email || user.username || from).toLowerCase();
    if (!db.chats[threadId]) db.chats[threadId] = { messages: [], typing: {} };

    if (body.type === "join" || body.type === "open" || body.type === "seen" || body.type === "poll") {
      const threads = Object.keys(db.chats).map((id) => {
        const msgs = db.chats[id].messages || [];
        return { id, last: msgs[msgs.length - 1] || null };
      });
      return json({
        ok: true,
        type: "snapshot",
        threadId,
        threads,
        messages: (db.chats[threadId] && db.chats[threadId].messages) || [],
        typing: (db.chats[threadId] && db.chats[threadId].typing) || {}
      });
    }

    if (body.type === "typing") {
      if (!threadId) return json({ error: "No chat selected" }, 400);
      db.chats[threadId].typing[from] = !!body.on;
      await saveDb(db);
      return json({ ok: true });
    }

    if (body.type === "chat") {
      if (!threadId) return json({ error: "No chat selected" }, 400);
      const message = {
        from,
        text: String(body.text || (body.image ? "Photo" : "")),
        image: body.image || "",
        created_at: new Date().toISOString()
      };
      db.chats[threadId].messages.push(message);
      db.chats[threadId].typing[from] = false;
      await saveDb(db);
      return json({ ok: true, type: "message", threadId, message });
    }

    return json({ error: "Unknown chat action" }, 400);
  }

  return json({ error: "Not found", path }, 404);
};

export const config = {
  path: "/api/*"
};
