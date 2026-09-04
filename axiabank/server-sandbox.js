const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const db = require("./db/store");

const PORT = Number(process.env.PORT || 3000);
const root = __dirname;
const loginHits = {};
function tooManyLogins(req) {
  var ip = String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local").split(",")[0]);
  var now = Date.now();
  loginHits[ip] = (loginHits[ip] || []).filter(function (t) { return now - t < 10 * 60 * 1000; });
  if (loginHits[ip].length >= 12) return true;
  loginHits[ip].push(now);
  return false;
}
const mime = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon"
};

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(function (resolve) {
    var raw = "";
    req.on("data", function (c) { raw += c; if (raw.length > 8e6) req.destroy(); });
    req.on("end", function () {
      try { resolve(JSON.parse(raw || "{}")); } catch (e) { resolve({}); }
    });
  });
}
function tokenFrom(req) {
  var auth = req.headers.authorization || "";
  if (auth.indexOf("Bearer ") === 0) return auth.slice(7);
  return "";
}
function requireUser(req, res, type, fullOnly) {
  var user = db.sessionUser(tokenFrom(req));
  if (!user) { json(res, 401, { error: "Sign in required" }); return null; }
  if (type && user.type !== type) { json(res, 403, { error: "Not allowed" }); return null; }
  if (fullOnly && user.step === "pin") { json(res, 401, { error: "Enter your PIN" }); return null; }
  return user;
}
function money(cents) { return (Number(cents || 0) / 100).toFixed(2); }
function mailPayload(person, type, cents, purpose) {
  return {
    type: type,
    email: person.email || "",
    name: person.first_name || person.full_name || "Customer",
    amount: money(cents),
    date: new Date().toLocaleString(),
    purpose: purpose || type
  };
}
function publicCustomer(c) {
  if (!c) return null;
  return {
    id: c.id, username: c.username, email: c.email,
    first_name: c.first_name, last_name: c.last_name,
    phone: c.phone, address: c.address, country: c.country,
    account_type: c.account_type, employment: c.employment,
    status: c.status, profile_pic: c.profile_pic || "",
    dob: c.dob || "",
    ssn_last4: c.ssn_last4 || "", kyc_complete: c.kyc_complete || 0,
    created_at: c.created_at
  };
}
function publicAccount(a) {
  return {
    id: a.id, product: a.product, account_number: a.account_number,
    routing_number: a.routing_number,
    available: money(a.available_cents),
    current: money(a.ledger_cents),
    status: a.status
  };
}
function bump(accountId, field, cents) {
  var acct = db.get("accounts", function (a) { return a.id === accountId; });
  if (!acct) return null;
  var patch = {};
  patch[field] = Number(acct[field] || 0) + Number(cents);
  return db.update("accounts", accountId, patch);
}
function openAccounts(customer) {
  var existing = db.all("accounts", function (a) { return a.customer_id === customer.id; });
  if (!existing.length) {
    db.insert("accounts", { customer_id: customer.id, account_number: db.accountNumber("checking"), routing_number: "071000013", product: "Checking", available_cents: 0, ledger_cents: 0, status: "open", created_at: db.now() });
    db.insert("accounts", { customer_id: customer.id, account_number: db.accountNumber("savings"), routing_number: "071000013", product: "Savings", available_cents: 0, ledger_cents: 0, status: "open", created_at: db.now() });
    return db.all("accounts", function (a) { return a.customer_id === customer.id; });
  }
  existing.forEach(function (a) {
    var isSav = String(a.product).indexOf("Savings") !== -1;
    var num = String(a.account_number || "");
    if (isSav && num.slice(0, 2) !== "49") db.update("accounts", a.id, { account_number: db.accountNumber("savings") });
    if (!isSav && num.slice(0, 2) !== "48") db.update("accounts", a.id, { account_number: db.accountNumber("checking") });
  });
  return db.all("accounts", function (a) { return a.customer_id === customer.id; });
}
function credit(accountId, cents, type, reference, customerId, extra) {
  extra = extra || {};
  var acct = db.get("accounts", function (a) { return a.id === accountId; });
  var next = Number(acct.available_cents) + Number(cents);
  db.update("accounts", accountId, { available_cents: next, ledger_cents: next });
  db.insert("transactions", {
    account_id: accountId, customer_id: customerId, type: type, direction: "credit",
    amount_cents: cents, balance_after_cents: next, reference: reference,
    status: "posted", created_at: db.now(),
    bank_name: extra.bank_name || "", holder_name: extra.holder_name || "",
    counterparty_account: extra.counterparty_account || "", set_time: extra.set_time || db.now()
  });
}
function debit(accountId, cents, type, reference, customerId, extra) {
  extra = extra || {};
  var acct = db.get("accounts", function (a) { return a.id === accountId; });
  if (Number(acct.available_cents) < Number(cents)) return null;
  var next = Number(acct.available_cents) - Number(cents);
  db.update("accounts", accountId, { available_cents: next, ledger_cents: next });
  db.insert("transactions", {
    account_id: accountId, customer_id: customerId, type: type, direction: "debit",
    amount_cents: cents, balance_after_cents: next, reference: reference,
    status: "posted", created_at: db.now(),
    bank_name: extra.bank_name || "", holder_name: extra.holder_name || "",
    counterparty_account: extra.counterparty_account || "", set_time: extra.set_time || db.now()
  });
  return next;
}

const server = http.createServer(async function (req, res) {
  var url = req.url.split("?")[0];
  try {
    if (req.method === "POST" && url === "/api/auth/register") {
      var b = await readBody(req);
      if (!b.email || !b.username || !b.password || !b.first_name || !b.last_name || !b.pin) {
        return json(res, 400, { error: "Missing required fields" });
      }
      if (String(b.password).length < 8) return json(res, 400, { error: "Password must be 8+ characters" });
      if (!/^\d{4,6}$/.test(String(b.pin))) return json(res, 400, { error: "PIN must be 4 to 6 digits" });
      if (b.pin !== b.pin_confirm) return json(res, 400, { error: "PIN does not match" });
      if (db.get("customers", function (c) { return c.email === String(b.email).toLowerCase(); })) {
        return json(res, 409, { error: "Email already exists" });
      }
      if (db.get("customers", function (c) { return c.username === String(b.username).toLowerCase(); })) {
        return json(res, 409, { error: "Username taken" });
      }
      var pic = String(b.profile_pic || "");
      if (pic && pic.length > 900000) return json(res, 400, { error: "Photo is too large" });
      var customer = db.insert("customers", {
        username: String(b.username).toLowerCase().slice(0, 40),
        email: String(b.email).toLowerCase().slice(0, 80),
        password_hash: db.hashPassword(b.password),
        pin_hash: db.hashPassword(String(b.pin)),
        first_name: String(b.first_name).slice(0, 40),
        last_name: String(b.last_name).slice(0, 40),
        phone: String(b.phone || "").slice(0, 30),
        address: String(b.address || "").slice(0, 120),
        country: String(b.country || "").slice(0, 40),
        account_type: String(b.account_type || "checking").slice(0, 20),
        employment: String(b.employment || "").slice(0, 40),
        dob: String(b.dob || "").slice(0, 12),
        postal_code: String(b.postal_code || b.postalCode || "").slice(0, 20),
        reason: String(b.reason || "").slice(0, 40),
        profile_pic: pic,
        status: "draft",
        kyc_complete: 0,
        ssn_last4: "",
        created_at: db.now()
      });
      var apply = db.createSession("customer", customer.id, { step: "kyc" });
      db.audit("customer", customer.id, "register", "customers", customer.id, "draft");
      return json(res, 201, { ok: true, step: "kyc", apply_token: apply.token });
    }

    if (req.method === "POST" && url === "/api/auth/kyc") {
      var kb = await readBody(req);
      var kycUser = db.sessionUser(kb.apply_token || "");
      if (!kycUser || kycUser.type !== "customer") return json(res, 401, { error: "Start with Create account first" });
      var ssn = String(kb.ssn || "").replace(/\D/g, "");
      if (ssn.length !== 9) return json(res, 400, { error: "Enter a 9-digit SSN" });
      if (!kb.id_front) return json(res, 400, { error: "Upload ID front" });
      if (!kb.id_back) return json(res, 400, { error: "Upload ID back" });
      if (String(kb.id_front).length > 1500000 || String(kb.id_back || "").length > 1500000) {
        return json(res, 400, { error: "ID image is too large" });
      }
      db.update("customers", kycUser.id, {
        ssn_hash: db.hashPassword(ssn),
        ssn_last4: ssn.slice(-4),
        id_front: String(kb.id_front),
        id_back: String(kb.id_back || ""),
        kyc_complete: 1,
        status: "pending"
      });
      db.audit("customer", kycUser.id, "kyc", "customers", kycUser.id, "pending approval");
      return json(res, 200, { ok: true, status: "pending" });
    }

    if (req.method === "POST" && url === "/api/auth/logout") {
      db.removeSession(tokenFrom(req));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url === "/api/auth/login") {
      if (tooManyLogins(req)) return json(res, 429, { error: "Too many sign-in attempts. Wait 10 minutes." });
      var login = await readBody(req);
      var ident = String(login.email || login.username || login.login || "").trim().toLowerCase();
      var admin = db.get("admins", function (a) { return a.email === ident; });
      if (admin && db.checkPassword(login.password, admin.password_hash)) {
        var as = db.createSession("admin", admin.id, { step: "full" });
        return json(res, 200, { ok: true, role: "admin", token: as.token, name: admin.full_name });
      }
      var cust = db.get("customers", function (c) {
        return c.email === ident || String(c.username || "").toLowerCase() === ident;
      });
      if (cust && db.checkPassword(login.password, cust.password_hash)) {
        if (cust.status === "draft") return json(res, 403, { error: "Finish ID upload first" });
        if (cust.status === "pending") return json(res, 403, { error: "Account is waiting for admin approval" });
        if (cust.status === "declined") return json(res, 403, { error: "Account was not approved" });
        if (cust.status !== "active" && cust.status !== "dormant") return json(res, 403, { error: "Account is not active" });
        var pre = db.createSession("customer", cust.id, { step: "pin" });
        return json(res, 200, {
          ok: true, role: "customer", step: "pin", pre_token: pre.token,
          customer: { first_name: cust.first_name, last_name: cust.last_name, username: cust.username, profile_pic: cust.profile_pic || "" }
        });
      }
      return json(res, 401, { error: "Invalid email, username, or password" });
    }

    if (req.method === "POST" && url === "/api/auth/pin") {
      var pb = await readBody(req);
      var preUser = db.sessionUser(pb.pre_token || "");
      if (!preUser || preUser.type !== "customer" || preUser.step !== "pin") {
        return json(res, 401, { error: "Sign in with your password first" });
      }
      if (!/^\d{4,6}$/.test(String(pb.pin || ""))) return json(res, 400, { error: "Enter your 4 to 6 digit PIN" });
      if (!db.checkPassword(String(pb.pin), preUser.pin_hash)) return json(res, 401, { error: "Incorrect PIN" });
      var full = db.createSession("customer", preUser.id, { step: "full" });
      return json(res, 200, { ok: true, token: full.token, customer: publicCustomer(preUser) });
    }

    if (req.method === "POST" && url === "/api/auth/forgot") {
      var fb = await readBody(req);
      var fident = String(fb.email || fb.username || "").trim().toLowerCase();
      if (!fident) return json(res, 400, { error: "Enter the email or username" });
      var fcust = db.get("customers", function (c) {
        return c.email === fident || String(c.username || "").toLowerCase() === fident;
      });
      if (!fcust) return json(res, 404, { error: "No account with that email or username" });
      if (fcust.status !== "active" && fcust.status !== "dormant") {
        return json(res, 403, { error: "Account must be approved before password reset" });
      }
      var code = String(Math.floor(100000 + Math.random() * 900000));
      db.update("customers", fcust.id, {
        reset_hash: db.hashPassword(code),
        reset_expires: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });
      return json(res, 200, {
        ok: true,
        email: fcust.email,
        code: code,
        message: "A 6-digit reset code was created."
      });
    }

    if (req.method === "POST" && url === "/api/auth/reset-code") {
      var cb = await readBody(req);
      var cident = String(cb.email || cb.username || "").trim().toLowerCase();
      var ccust = db.get("customers", function (c) {
        return c.email === cident || String(c.username || "").toLowerCase() === cident;
      });
      if (!ccust || !ccust.reset_hash) return json(res, 400, { error: "Request a code first" });
      if (new Date(ccust.reset_expires).getTime() < Date.now()) return json(res, 400, { error: "Code expired. Request a new one" });
      if (!db.checkPassword(String(cb.code || "").trim(), ccust.reset_hash)) return json(res, 401, { error: "Incorrect code" });
      var rt = db.createSession("customer", ccust.id, { step: "reset" });
      return json(res, 200, { ok: true, reset_token: rt.token });
    }

    if (req.method === "POST" && url === "/api/auth/reset") {
      var rb = await readBody(req);
      var ruser = db.sessionUser(rb.reset_token || "");
      if (!ruser || ruser.type !== "customer" || ruser.step !== "reset") {
        return json(res, 401, { error: "Verify the email code first" });
      }
      if (!rb.password || String(rb.password).length < 8) return json(res, 400, { error: "Password must be 8+ characters" });
      if (rb.password !== rb.password_confirm) return json(res, 400, { error: "Passwords do not match" });
      db.update("customers", ruser.id, {
        password_hash: db.hashPassword(rb.password),
        reset_hash: "",
        reset_expires: ""
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url === "/api/me") {
      var me = requireUser(req, res, null, true);
      if (!me) return;
      if (me.type === "admin") return json(res, 200, { role: "admin", name: me.full_name, email: me.email });
      return json(res, 200, { role: "customer", customer: publicCustomer(me) });
    }
    if (req.method === "GET" && url === "/api/accounts") {
      var u1 = requireUser(req, res, "customer", true);
      if (!u1) return;
      return json(res, 200, { accounts: openAccounts(u1).map(publicAccount) });
    }
    if (req.method === "GET" && url === "/api/transactions") {
      var u2 = requireUser(req, res, "customer", true);
      if (!u2) return;
      return json(res, 200, { transactions: db.all("transactions", function (t) { return t.customer_id === u2.id; }).reverse() });
    }
    if (req.method === "GET" && url === "/api/notifications") {
      var un = requireUser(req, res, "customer", true);
      if (!un) return;
      return json(res, 200, { notifications: db.all("notifications", function (n) { return n.customer_id === un.id; }).reverse() });
    }
    if (req.method === "POST" && url === "/api/deposits") {
      var u3 = requireUser(req, res, "customer", true);
      if (!u3) return;
      var dep = await readBody(req);
      var amount = Math.round(Number(dep.amount) * 100);
      if (!amount || amount <= 0) return json(res, 400, { error: "Enter a valid amount" });
      var acct = db.get("accounts", function (a) { return a.customer_id === u3.id && String(a.product).indexOf("Checking") !== -1; }) || db.get("accounts", function (a) { return a.customer_id === u3.id; });
      if (!acct) return json(res, 404, { error: "Account not found" });
      bump(acct.id, "ledger_cents", amount);
      db.insert("deposit_requests", { customer_id: u3.id, account_id: acct.id, amount_cents: amount, method: String(dep.method || "transfer"), status: "pending", note: "", created_at: db.now() });
      db.insert("transactions", { account_id: acct.id, customer_id: u3.id, type: "deposit", direction: "credit", amount_cents: amount, balance_after_cents: Number(acct.ledger_cents || 0) + amount, reference: "PEND-DEP", status: "pending", created_at: db.now() });
      return json(res, 201, { ok: true, status: "pending" });
    }
    if (req.method === "POST" && url === "/api/withdrawals") {
      var u4 = requireUser(req, res, "customer", true);
      if (!u4) return;
      var wd = await readBody(req);
      var wamt = Math.round(Number(wd.amount) * 100);
      if (!wamt || wamt <= 0) return json(res, 400, { error: "Enter a valid amount" });
      var wacct = db.get("accounts", function (a) { return a.customer_id === u4.id && String(a.product).indexOf("Checking") !== -1; }) || db.get("accounts", function (a) { return a.customer_id === u4.id; });
      if (!wacct) return json(res, 404, { error: "Account not found" });
      if (Number(wacct.available_cents) < wamt) return json(res, 400, { error: "Not enough available balance" });
      bump(wacct.id, "available_cents", -wamt);
      db.insert("withdrawal_requests", { customer_id: u4.id, account_id: wacct.id, amount_cents: wamt, status: "pending", note: String(wd.note || ""), created_at: db.now() });
      db.insert("transactions", { account_id: wacct.id, customer_id: u4.id, type: "withdrawal", direction: "debit", amount_cents: wamt, balance_after_cents: Number(wacct.available_cents) - wamt, reference: "PEND-WD", status: "pending", created_at: db.now() });
      db.notify(u4.id, "Withdrawal pending", "Your withdrawal is waiting for admin approval.");
      return json(res, 201, { ok: true, status: "pending" });
    }
    if (req.method === "POST" && url === "/api/transfers/internal") {
      var uMove = requireUser(req, res, "customer", true);
      if (!uMove) return;
      var mv = await readBody(req);
      var mvAmt = Math.round(Number(mv.amount) * 100);
      if (!mvAmt || mvAmt <= 0) return json(res, 400, { error: "Enter a valid amount" });
      var fromName = String(mv.from || "checking").toLowerCase();
      var toName = String(mv.to || "savings").toLowerCase();
      if (fromName === toName) return json(res, 400, { error: "Pick two different accounts" });
      var fromAcct = db.get("accounts", function (a) {
        return a.customer_id === uMove.id && String(a.product).toLowerCase().indexOf(fromName.slice(0, 5)) !== -1;
      });
      var toAcct = db.get("accounts", function (a) {
        return a.customer_id === uMove.id && String(a.product).toLowerCase().indexOf(toName.slice(0, 5)) !== -1;
      });
      if (!fromAcct || !toAcct) return json(res, 404, { error: "Account not found" });
      var took = debit(fromAcct.id, mvAmt, "transfer", "MOVE-" + Date.now(), uMove.id, {
        bank_name: "Axia Bank", holder_name: uMove.first_name + " " + uMove.last_name,
        counterparty_account: toAcct.account_number
      });
      if (took === null) return json(res, 400, { error: "Not enough available balance" });
      credit(toAcct.id, mvAmt, "transfer", "MOVE-" + Date.now(), uMove.id, {
        bank_name: "Axia Bank", holder_name: uMove.first_name + " " + uMove.last_name,
        counterparty_account: fromAcct.account_number
      });
      return json(res, 200, { ok: true, status: "posted" });
    }
    if (req.method === "POST" && url === "/api/profile") {
      var u5 = requireUser(req, res, "customer", true);
      if (!u5) return;
      var pr = await readBody(req);
      var updated = db.update("customers", u5.id, {
        first_name: String(pr.first_name || u5.first_name),
        last_name: String(pr.last_name || u5.last_name),
        phone: String(pr.phone || ""),
        address: String(pr.address || "")
      });
      return json(res, 200, { ok: true, customer: publicCustomer(updated) });
    }
    if (req.method === "POST" && url === "/api/security/pin") {
      var uPin = requireUser(req, res, "customer", true);
      if (!uPin) return;
      var pbod = await readBody(req);
      if (!/^\d{4,6}$/.test(String(pbod.pin || ""))) return json(res, 400, { error: "PIN must be 4 to 6 digits" });
      if (pbod.pin !== pbod.pin_confirm) return json(res, 400, { error: "PINs do not match" });
      db.update("customers", uPin.id, { pin_hash: db.hashPassword(String(pbod.pin)) });
      return json(res, 200, { ok: true });
    }
    function cardDigits(card) {
      var raw = "48" + String(10000000000000 + Number(card.id) * 91711).slice(0, 14);
      return raw.slice(0, 16);
    }
    function cardCvv(card) {
      return String(100 + (Number(card.id) * 7919 % 900));
    }
    function cardPublic(card, reveal) {
      if (!card) return null;
      var approved = card.status === "approved";
      var num = cardDigits(card);
      return {
        id: card.id,
        product: card.product,
        fee: card.fee,
        status: card.status,
        frozen: !!card.frozen,
        last4: num.slice(-4),
        exp: approved ? card.exp : "",
        cvv: approved && reveal ? cardCvv(card) : "",
        number: approved && reveal ? num : "",
        holder: card.holder,
        online_limit: 50000,
        atm_limit: 25000
      };
    }
    if (req.method === "GET" && url === "/api/cards") {
      var uc = requireUser(req, res, "customer", true);
      if (!uc) return;
      var reveal = String(req.url).indexOf("reveal=1") !== -1;
      return json(res, 200, { cards: db.all("cards", function (c) { return c.customer_id === uc.id; }).map(function (c) { return cardPublic(c, reveal); }) });
    }
    if (req.method === "POST" && url === "/api/cards") {
      var ua = requireUser(req, res, "customer", true);
      if (!ua) return;
      var cbod = await readBody(req);
      var catalog = {
        silver: { product: "Silver", fee: "$4.99 / month" },
        gold: { product: "Gold", fee: "$12.99 / month" },
        platinum: { product: "Platinum", fee: "$24.99 / month" },
        black: { product: "Black", fee: "$49.99 / month" },
        business: { product: "Business", fee: "$19.99 / month" }
      };
      var pick = catalog[String(cbod.product || "").toLowerCase()];
      if (!pick) return json(res, 400, { error: "Choose Silver, Gold, Platinum, Black, or Business" });
      var open = db.get("cards", function (c) { return c.customer_id === ua.id && (c.status === "pending" || c.status === "approved"); });
      if (open) return json(res, 409, { error: "You already have a " + open.status + " " + open.product + " card" });
      var card = db.insert("cards", {
        customer_id: ua.id,
        product: pick.product,
        fee: pick.fee,
        last4: "****",
        exp: String((new Date().getMonth() + 1)).padStart(2, "0") + "/" + String((new Date().getFullYear() + 4) % 100).padStart(2, "0"),
        holder: (ua.first_name + " " + ua.last_name).toUpperCase(),
        status: "pending",
        frozen: 0,
        created_at: db.now()
      });
      db.notify(ua.id, "Card application received", pick.product + " card is waiting for admin approval.");
      return json(res, 201, { ok: true, card: cardPublic(card, false) });
    }
    if (req.method === "POST" && /\/api\/cards\/\d+\/freeze$/.test(url)) {
      var uf = requireUser(req, res, "customer", true);
      if (!uf) return;
      var cid = Number(url.split("/")[3]);
      var crow = db.get("cards", function (c) { return c.id === cid && c.customer_id === uf.id; });
      if (!crow || crow.status !== "approved") return json(res, 400, { error: "Card is not active yet" });
      var fr = await readBody(req);
      var frozen = fr.frozen ? 1 : 0;
      db.update("cards", cid, { frozen: frozen });
      return json(res, 200, { ok: true, frozen: frozen });
    }

    if (url.indexOf("/api/admin/") === 0) {
      var adminUser = requireUser(req, res, "admin", true);
      if (!adminUser) return;
      if (req.method === "GET" && url === "/api/admin/overview") {
        return json(res, 200, {
          customers: db.all("customers").length,
          pending_accounts: db.all("customers", function (c) { return c.status === "pending"; }).length,
          pending_deposits: db.all("deposit_requests", function (r) { return r.status === "pending"; }).length,
          pending_withdrawals: db.all("withdrawal_requests", function (r) { return r.status === "pending"; }).length
        });
      }
      if (req.method === "GET" && url === "/api/admin/customers") {
        return json(res, 200, { customers: db.all("customers").map(publicCustomer).reverse() });
      }
      if (req.method === "POST" && /\/api\/admin\/customers\/\d+\/approve$/.test(url)) {
        var aid = Number(url.split("/")[4]);
        var arow = db.get("customers", function (c) { return c.id === aid; });
        if (!arow) return json(res, 404, { error: "Customer not found" });
        db.update("customers", aid, { status: "active" });
        openAccounts(arow);
        db.notify(aid, "Account approved", "Your Axia account is open.");
        db.audit("admin", adminUser.id, "approve_customer", "customers", aid, "opened");
        return json(res, 200, { ok: true, mail: { type: "welcome", email: arow.email, name: arow.first_name } });
      }
      if (req.method === "POST" && /\/api\/admin\/customers\/\d+\/decline$/.test(url)) {
        var did = Number(url.split("/")[4]);
        var drow = db.get("customers", function (c) { return c.id === did; });
        if (!drow) return json(res, 404, { error: "Customer not found" });
        db.update("customers", did, { status: "declined" });
        db.audit("admin", adminUser.id, "decline_customer", "customers", did, "declined");
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && /\/api\/admin\/customers\/\d+$/.test(url)) {
        var eid = Number(url.split("/")[4]);
        var erow = db.get("customers", function (c) { return c.id === eid; });
        if (!erow) return json(res, 404, { error: "Customer not found" });
        var ed = await readBody(req);
        var patch = {
          first_name: String(ed.first_name || erow.first_name),
          last_name: String(ed.last_name || erow.last_name),
          phone: String(ed.phone || ""),
          address: String(ed.address || ""),
          country: String(ed.country || erow.country || ""),
          employment: String(ed.employment || erow.employment || ""),
          username: String(ed.username || erow.username).toLowerCase()
        };
        if (ed.password) {
          if (String(ed.password).length < 8) return json(res, 400, { error: "Password must be 8+ characters" });
          if (ed.password !== ed.password_confirm) return json(res, 400, { error: "Passwords do not match" });
          patch.password_hash = db.hashPassword(ed.password);
        }
        if (ed.pin) {
          if (!/^\d{4,6}$/.test(String(ed.pin))) return json(res, 400, { error: "PIN must be 4 to 6 digits" });
          if (ed.pin !== ed.pin_confirm) return json(res, 400, { error: "PINs do not match" });
          patch.pin_hash = db.hashPassword(String(ed.pin));
        }
        var saved = db.update("customers", eid, patch);
        db.audit("admin", adminUser.id, "edit_customer", "customers", eid, "updated");
        return json(res, 200, { ok: true, customer: publicCustomer(saved) });
      }
      if (req.method === "POST" && /\/api\/admin\/customers\/\d+\/fund$/.test(url)) {
        var fid = Number(url.split("/")[4]);
        var frow = db.get("customers", function (c) { return c.id === fid; });
        if (!frow || (frow.status !== "active" && frow.status !== "dormant")) return json(res, 400, { error: "Open the account first" });
        var fbod = await readBody(req);
        var famt = Math.round(Number(fbod.amount) * 100);
        if (!famt || famt <= 0) return json(res, 400, { error: "Enter a valid amount" });
        var want = String(fbod.account || "checking").toLowerCase();
        var facct = db.get("accounts", function (a) {
          return a.customer_id === fid && String(a.product).toLowerCase().indexOf(want) !== -1;
        }) || db.get("accounts", function (a) { return a.customer_id === fid; });
        if (!facct) return json(res, 404, { error: "No account to fund" });
        credit(facct.id, famt, "admin_fund", "FUND-" + fid, fid, {
          bank_name: String(fbod.bank_name || "Axia Bank"),
          holder_name: String(fbod.holder_name || (frow.first_name + " " + frow.last_name)),
          counterparty_account: String(fbod.account_number || facct.account_number),
          set_time: String(fbod.set_time || db.now())
        });
        db.notify(fid, "Account funded", "Admin posted a credit.");
        db.audit("admin", adminUser.id, "fund", "accounts", facct.id, String(famt));
        return json(res, 200, {
          ok: true,
          mail: mailPayload(frow, "deposit", famt, String(fbod.bank_name || "Account funding"))
        });
      }
      if (req.method === "POST" && /\/api\/admin\/customers\/\d+\/debit$/.test(url)) {
        var did2 = Number(url.split("/")[4]);
        var drow2 = db.get("customers", function (c) { return c.id === did2; });
        if (!drow2 || (drow2.status !== "active" && drow2.status !== "dormant")) return json(res, 400, { error: "Account not open" });
        var dbod = await readBody(req);
        var damt = Math.round(Number(dbod.amount) * 100);
        if (!damt || damt <= 0) return json(res, 400, { error: "Enter a valid amount" });
        var dwant = String(dbod.account || "checking").toLowerCase();
        var dacct = db.get("accounts", function (a) {
          return a.customer_id === did2 && String(a.product).toLowerCase().indexOf(dwant) !== -1;
        }) || db.get("accounts", function (a) { return a.customer_id === did2; });
        if (!dacct) return json(res, 404, { error: "No account" });
        var dout = debit(dacct.id, damt, "admin_debit", "DEB-" + did2, did2, {
          bank_name: String(dbod.bank_name || "Axia Bank"),
          holder_name: String(dbod.holder_name || (drow2.first_name + " " + drow2.last_name)),
          counterparty_account: String(dbod.account_number || dacct.account_number),
          set_time: String(dbod.set_time || db.now())
        });
        if (dout === null) return json(res, 400, { error: "Not enough available balance" });
        db.notify(did2, "Account debited", "Admin posted a debit.");
        return json(res, 200, {
          ok: true,
          mail: mailPayload(drow2, "debit", damt, String(dbod.bank_name || "Account debit"))
        });
      }
      if (req.method === "POST" && /\/api\/admin\/customers\/\d+\/note$/.test(url)) {
        var nid = Number(url.split("/")[4]);
        var nrow = db.get("customers", function (c) { return c.id === nid; });
        if (!nrow) return json(res, 404, { error: "Customer not found" });
        var nb = await readBody(req);
        db.notify(nid, String(nb.title || "Message from Axia"), String(nb.body || ""));
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && /\/api\/admin\/customers\/\d+\/status$/.test(url)) {
        var sid = Number(url.split("/")[4]);
        var srow = db.get("customers", function (c) { return c.id === sid; });
        if (!srow) return json(res, 404, { error: "Customer not found" });
        var sb = await readBody(req);
        var nextStatus = String(sb.status || "") === "dormant" ? "dormant" : "active";
        db.update("customers", sid, { status: nextStatus });
        return json(res, 200, { ok: true, status: nextStatus });
      }
      if (req.method === "GET" && /\/api\/admin\/customers\/\d+\/detail$/.test(url)) {
        var xid = Number(url.split("/")[4]);
        var xrow = db.get("customers", function (c) { return c.id === xid; });
        if (!xrow) return json(res, 404, { error: "Customer not found" });
        return json(res, 200, {
          customer: publicCustomer(xrow),
          accounts: db.all("accounts", function (a) { return a.customer_id === xid; }).map(publicAccount),
          transactions: db.all("transactions", function (t) { return t.customer_id === xid; }).reverse(),
          kyc: { has_id: !!(xrow.id_front || xrow.id_back) }
        });
      }
      if (req.method === "GET" && url === "/api/admin/deposits") {
        var deposits = db.all("deposit_requests").map(function (r) {
          var c = db.get("customers", function (x) { return x.id === r.customer_id; }) || {};
          return { id: r.id, email: c.email, amount_cents: r.amount_cents, status: r.status };
        }).reverse();
        return json(res, 200, { deposits: deposits });
      }
      if (req.method === "GET" && url === "/api/admin/withdrawals") {
        var withdrawals = db.all("withdrawal_requests").map(function (r) {
          var c = db.get("customers", function (x) { return x.id === r.customer_id; }) || {};
          return { id: r.id, email: c.email, amount_cents: r.amount_cents, status: r.status };
        }).reverse();
        return json(res, 200, { withdrawals: withdrawals });
      }
      var bits = url.split("/");
      if (req.method === "POST" && bits[3] === "deposits" && (bits[5] === "approve" || bits[5] === "decline")) {
        var depId = Number(bits[4]); var dact = bits[5];
        var dreq = db.get("deposit_requests", function (r) { return r.id === depId; });
        if (!dreq || dreq.status !== "pending") return json(res, 400, { error: "Request not pending" });
        var dmail = db.get("customers", function (c) { return c.id === dreq.customer_id; }) || {};
        if (dact === "approve") {
          bump(dreq.account_id, "available_cents", dreq.amount_cents);
          db.update("deposit_requests", depId, { status: "approved", decided_by: adminUser.id, decided_at: db.now() });
          return json(res, 200, { ok: true, mail: mailPayload(dmail, "deposit", dreq.amount_cents, "Deposit approved") });
        }
        bump(dreq.account_id, "ledger_cents", -dreq.amount_cents);
        db.update("deposit_requests", depId, { status: "declined", decided_by: adminUser.id, decided_at: db.now() });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && bits[3] === "withdrawals" && (bits[5] === "approve" || bits[5] === "decline")) {
        var wdId = Number(bits[4]); var wact = bits[5];
        var wreq = db.get("withdrawal_requests", function (r) { return r.id === wdId; });
        if (!wreq || wreq.status !== "pending") return json(res, 400, { error: "Request not pending" });
        var wmail = db.get("customers", function (c) { return c.id === wreq.customer_id; }) || {};
        if (wact === "approve") {
          bump(wreq.account_id, "ledger_cents", -wreq.amount_cents);
          db.insert("transactions", { account_id: wreq.account_id, customer_id: wreq.customer_id, type: "withdrawal", direction: "debit", amount_cents: wreq.amount_cents, reference: "WD-" + wdId, status: "posted", created_at: db.now() });
          db.update("withdrawal_requests", wdId, { status: "approved", decided_by: adminUser.id, decided_at: db.now() });
          return json(res, 200, { ok: true, mail: mailPayload(wmail, "debit", wreq.amount_cents, "Withdrawal approved") });
        }
        bump(wreq.account_id, "available_cents", wreq.amount_cents);
        db.update("withdrawal_requests", wdId, { status: "declined", decided_by: adminUser.id, decided_at: db.now() });
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url === "/api/admin/cards") {
        var cards = db.all("cards").map(function (r) {
          var c = db.get("customers", function (x) { return x.id === r.customer_id; }) || {};
          return { id: r.id, email: c.email, name: (c.first_name || "") + " " + (c.last_name || ""), product: r.product, fee: r.fee, last4: cardDigits(r).slice(-4), status: r.status };
        }).reverse();
        return json(res, 200, { cards: cards });
      }
      if (req.method === "POST" && /\/api\/admin\/cards\/\d+\/(approve|decline)$/.test(url)) {
        var cardBits = url.split("/");
        var cardId = Number(cardBits[4]);
        var cardAct = cardBits[5];
        var cardRow = db.get("cards", function (r) { return r.id === cardId; });
        if (!cardRow || cardRow.status !== "pending") return json(res, 400, { error: "Card is not pending" });
        db.update("cards", cardId, { status: cardAct === "approve" ? "approved" : "declined", decided_at: db.now() });
        db.notify(cardRow.customer_id, cardAct === "approve" ? "Card approved" : "Card declined", cardRow.product + " card " + (cardAct === "approve" ? "is ready." : "was not approved."));
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "Unknown admin route" });
    }

    if (url.indexOf("/api/") === 0) return json(res, 404, { error: "Unknown API route" });
    var file = url === "/" ? "/index.html" : url;
    var full = path.join(root, file);
    if (full.indexOf(root) !== 0) { res.writeHead(403); return res.end("Forbidden"); }
    fs.readFile(full, function (err, data) {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "text/plain" });
      res.end(data);
    });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "Server error" });
  }
});

const wss = new WebSocketServer({ server: server, path: "/chat" });
const threads = {};
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
wss.on("connection", function (ws) {
  ws.role = ""; ws.threadId = ""; ws.authed = false;
  ws.on("message", function (raw) {
    var data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }
    if (data.type === "join") {
      var person = db.sessionUser(String(data.token || ""));
      if (!person || person.step === "pin") {
        send(ws, { type: "error", error: "Sign in required" });
        ws.close();
        return;
      }
      if (data.role === "admin") {
        if (person.type !== "admin") { send(ws, { type: "error", error: "Not allowed" }); ws.close(); return; }
        ws.role = "admin";
        ws.threadId = "admin";
        ws.name = person.full_name || "Admin";
        ws.authed = true;
        var list = Object.keys(threads).map(function (id) { return { id: id, last: threads[id][threads[id].length - 1] || null }; });
        send(ws, { type: "threads", threads: list });
        return;
      }
      if (person.type !== "customer") { send(ws, { type: "error", error: "Not allowed" }); ws.close(); return; }
      ws.role = "user";
      ws.threadId = person.email;
      ws.name = person.first_name || "Customer";
      ws.authed = true;
      if (!threads[ws.threadId]) threads[ws.threadId] = [];
      send(ws, { type: "history", threadId: ws.threadId, messages: threads[ws.threadId] });
      return;
    }
    if (!ws.authed) return;
    if (data.type === "open" && ws.role === "admin") {
      send(ws, { type: "history", threadId: data.threadId, messages: threads[data.threadId] || [] });
      return;
    }
    if (data.type === "typing" || data.type === "seen") {
      var tid = ws.role === "admin" ? String(data.threadId || "").trim().toLowerCase() : ws.threadId;
      wss.clients.forEach(function (client) {
        if (client.readyState !== 1 || !client.authed || client === ws) return;
        if (ws.role === "admin" && client.role === "user" && String(client.threadId).toLowerCase() !== tid) return;
        if (ws.role === "user" && client.role !== "admin") return;
        if (data.type === "typing") send(client, { type: "typing", from: ws.role, threadId: tid, on: !!data.on });
        if (data.type === "seen") send(client, { type: "seen", from: ws.role, threadId: tid });
      });
      return;
    }
    if (data.type === "chat") {
      var threadId = ws.role === "admin" ? String(data.threadId || "") : ws.threadId;
      if (!threadId) return;
      if (!threads[threadId]) threads[threadId] = [];
      var message = { from: ws.role, name: ws.name, text: String(data.text || "").slice(0, 500), image: data.image ? String(data.image).slice(0, 900000) : "", time: new Date().toISOString() };
      if (!message.text && !message.image) return;
      threads[threadId].push(message);
      var list = Object.keys(threads).map(function (id) {
        return { id: id, last: threads[id][threads[id].length - 1] || null };
      });
      wss.clients.forEach(function (client) {
        if (client.readyState !== 1 || !client.authed) return;
        if (client.role === "admin") {
          send(client, { type: "threads", threads: list });
          send(client, { type: "message", threadId: threadId, message: message });
        } else if (client.threadId === threadId) {
          send(client, { type: "message", threadId: threadId, message: message });
        }
      });
    }
  });
});

db.init().then(function () {
  server.listen(PORT,"0.0.0.0", function () {
    console.log("Axia server running on port" + PORT);
  });
});
