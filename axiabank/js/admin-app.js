var token = localStorage.getItem("axia_admin_token") || "";
var current = null;
var list = [];
function api(path, method, body) {
  return fetch(path, {
    method: method || "GET",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) { return r.json().catch(function(){ return { error: "offline" }; }); }).catch(function(){ return { error: "offline" }; });
}
function money(c) { return "$" + (Number(c || 0) / 100).toFixed(2); }
function sendBankMail(kind, mail) {
  if (!window.axiaSendMail || !mail) return;
  var date = mail.date || new Date().toLocaleString();
  var purpose = mail.purpose || kind || "";
  var amt = String(mail.amount || "");
  var pretty = amt.indexOf("$") === 0 ? amt : ("$" + amt);
  return axiaSendMail(kind, {
    to_email: mail.email,
    email: mail.email,
    user_email: mail.email,
    name: mail.name,
    user_name: mail.name,
    to_name: mail.name,
    amount: amt,
    Amount: amt,
    credit_amount: pretty,
    amount_usd: pretty,
    usd_amount: pretty,
    date: date,
    transaction_date: date,
    purpose: purpose,
    transfer_purpose: purpose,
    message: "Credit amount: " + pretty + " on " + date + ". " + purpose,
    subject: "Axia Bank " + pretty + " " + purpose
  });
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"'`]/g, function (ch) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[ch];
  });
}
function go(view) {
  if (!view) return;
  document.querySelectorAll(".nav").forEach(function (x) { x.classList.remove("on"); });
  document.querySelectorAll(".view").forEach(function (x) { x.classList.remove("on"); });
  var nav = document.querySelector('.nav[data-go="' + view + '"]');
  if (nav) nav.classList.add("on");
  var panel = document.getElementById("view-" + view);
  if (panel) panel.classList.add("on");
  if (view === "chat") openAdminChat();
}
function setWho() {
  document.getElementById("who").textContent = current
    ? ("Selected: " + (current.first_name || "") + " " + (current.last_name || "") + " ÃÂÃÂ· " + current.email)
    : "Select a student in the list, or use the dropdown.";
  var sel = document.getElementById("pickStudent");
  if (sel && current) sel.value = String(current.id);
}
function fillPicker() {
  var sel = document.getElementById("pickStudent");
  if (!sel) return;
  var keep = current ? String(current.id) : "";
  sel.innerHTML = "<option value=''>Select a student</option>" + list.map(function (c) {
    return "<option value='" + c.id + "'>" + esc(c.first_name || "") + " " + esc(c.last_name || "") + " ÃÂÃÂ· " + esc(c.email) + " ÃÂÃÂ· " + esc(c.status) + "</option>";
  }).join("");
  if (keep) sel.value = keep;
}
function fillForms() {
  if (!current) return;
  document.getElementById("fName").value = (current.first_name || "") + " " + (current.last_name || "");
  document.getElementById("dName").value = (current.first_name || "") + " " + (current.last_name || "");
  document.getElementById("eFirst").value = current.first_name || "";
  document.getElementById("eLast").value = current.last_name || "";
  document.getElementById("eUser").value = current.username || "";
  document.getElementById("eEmail").value = current.email || "";
  document.getElementById("ePhone").value = current.phone || "";
  document.getElementById("eAddr").value = current.address || "";
  document.getElementById("eCountry").value = current.country || "";
  document.getElementById("eEmp").value = current.employment || "";
  document.getElementById("sUser").value = current.username || "";
  document.getElementById("stNow").textContent = "Current status: " + current.status;
  document.getElementById("noteBox").textContent = "Status " + current.status + ". SSN last 4: " + (current.ssn_last4 || "n/a");
  api("/api/admin/customers/" + current.id + "/detail").then(function (d) {
    if (d.error) return;
    var html = "<table><tr><th>When</th><th>Type</th><th>Amount</th><th>Details</th></tr>";
    (d.transactions || []).forEach(function (t) {
      html += "<tr><td>" + esc(t.created_at || "") + "</td><td>" + esc(t.type) + "</td><td>" + money(t.amount_cents) + "</td><td>" +
        esc(t.bank_name || "") + " ÃÂÃÂ· " + esc(t.holder_name || "") + " ÃÂÃÂ· " + esc(t.counterparty_account || "") + " ÃÂÃÂ· " + esc(t.set_time || "") + "</td></tr>";
    });
    document.getElementById("txBox").innerHTML = html + "</table>";
    var acct = (d.accounts || [])[0];
    if (acct) {
      document.getElementById("fAcct").value = acct.account_number || "";
      document.getElementById("dAcct").value = acct.account_number || "";
    }
  });
}
function pick(id, view) {
  current = list.find(function (c) { return Number(c.id) === Number(id); }) || null;
  setWho();
  if (current) fillForms();
  if (view) go(view);
}
function load() {
  api("/api/me").then(function (me) {
    if (!me || me.role !== "admin") {
      if (localStorage.getItem("axia_admin_local") === "1") {
        me = { role: "admin", name: "Axia Admin", email: "support@axia-bank.com" };
      } else {
        location.href = "admin-login.html";
        return;
      }
    }
    var hour = new Date().getHours();
    var greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    var name = (me.name || "Admin").split(" ")[0];
    document.getElementById("hello").textContent = greet + ", " + name;
    document.getElementById("adminName").textContent = me.name || "Axia Admin";
    var ini = (me.name || "A").charAt(0).toUpperCase();
    document.getElementById("adminInitial").textContent = ini;
    document.getElementById("adminPic").textContent = ini;
    return api("/api/admin/overview");
  }).then(function (o) {
    if (!o) return;
    document.getElementById("sCust").textContent = o.customers;
    document.getElementById("sAcc").textContent = Number(o.pending_accounts || 0) + Number(o.pending_deposits || 0) + Number(o.pending_withdrawals || 0);
    document.getElementById("sDep").textContent = o.pending_deposits;
    document.getElementById("sWd").textContent = o.pending_withdrawals;
    if (document.getElementById("sSes")) document.getElementById("sSes").textContent = "On";
  });
  api("/api/admin/customers").then(function (d) {
    list = d.customers || [];
    fillPicker();
    var q = ((document.getElementById("adminSearch") || {}).value || "").toLowerCase();
    var pending = list.filter(function (c) { return c.status === "pending" || c.status === "draft"; });
    var approved = list.filter(function (c) {
      var ok = c.status === "active" || c.status === "dormant";
      if (!ok) return false;
      if (!q) return true;
      return (c.first_name + " " + c.last_name + " " + c.email + " " + (c.username || "")).toLowerCase().indexOf(q) !== -1;
    });
    var html = "<table><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr>";
    pending.forEach(function (c) {
      html += "<tr><td>" + esc(c.first_name || "") + " " + esc(c.last_name || "") + "</td><td>" + esc(c.email) + "</td><td>" + esc(c.status) +
        "</td><td><button type='button' class='btn' data-open='" + c.id + "'>Open account</button> " +
        "<button type='button' class='btn ghost' data-decline='" + c.id + "'>Decline</button></td></tr>";
    });
    document.getElementById("reviewBox").innerHTML = html + "</table>";
    var ahtml = "<table><tr><th>Name</th><th>Email</th><th>Phone</th><th>Balance</th><th>Status</th><th></th></tr>";
    var aum = 0;
    var jobs = approved.map(function (c) {
      return api("/api/admin/customers/" + c.id + "/detail").then(function (det) {
        var sum = 0;
        (det.accounts || []).forEach(function (a) { sum += Math.round(Number(a.available) * 100); });
        aum += sum;
        var live = c.status === "active" ? "<span class='tag'>Active</span>" : "<span class='tag off'>Dormant</span>";
        ahtml += "<tr><td><button type='button' class='btn ghost' data-act='edit' data-id='" + c.id + "'>" + esc(c.first_name) + " " + esc(c.last_name) + "</button></td><td>" + esc(c.email) + "</td><td>" + esc(c.phone || "") +
          "</td><td>" + money(sum) + "</td><td>" + live + "</td><td><div class='dots'><button type='button' data-dots='" + c.id + "'>ÃÂ¢ÃÂÃÂ¯</button>" +
          "<div class='menu' id='m" + c.id + "'>" +
          "<button type='button' data-act='fund' data-id='" + c.id + "'>Fund account</button>" +
          "<button type='button' data-act='debit' data-id='" + c.id + "'>Debit account</button>" +
          "<button type='button' data-act='edit' data-id='" + c.id + "'>Edit information</button>" +
          "<button type='button' data-act='status' data-id='" + c.id + "'>Activate / Dormant</button>" +
          "<button type='button' data-act='email' data-id='" + c.id + "'>Send email</button>" +
          "<button type='button' data-act='tx' data-id='" + c.id + "'>Transactions</button>" +
          "<button type='button' data-act='security' data-id='" + c.id + "'>Security</button></div></div></td></tr>";
      }).catch(function () {});
    });
    Promise.all(jobs).then(function () {
      document.getElementById("approvedBox").innerHTML = ahtml + "</table>";
      if (document.getElementById("sAum")) document.getElementById("sAum").textContent = money(aum);
    });
    if (!current && approved[0]) pick(approved[0].id);
    else if (current) {
      current = list.find(function (c) { return c.id === current.id; }) || current;
      setWho();
      fillForms();
    }
  });
  api("/api/admin/deposits").then(function (d) {
    var html = "<table><tr><th>Student</th><th>Amount</th><th></th></tr>";
    (d.deposits || []).forEach(function (r) {
      html += "<tr><td>" + esc(r.email || "") + "</td><td>" + money(r.amount_cents) + "</td><td>";
      if (r.status === "pending") {
        html += "<button type='button' class='btn' data-kind='deposits' data-id='" + r.id + "' data-action='approve'>Approve</button>";
        html += "<button type='button' class='btn ghost' data-kind='deposits' data-id='" + r.id + "' data-action='decline'>Decline</button>";
      } else html += r.status;
      html += "</td></tr>";
    });
    document.getElementById("depBox").innerHTML = html + "</table>";
  });
  api("/api/admin/withdrawals").then(function (d) {
    var html = "<table><tr><th>Student</th><th>Amount</th><th></th></tr>";
    (d.withdrawals || []).forEach(function (r) {
      html += "<tr><td>" + esc(r.email || "") + "</td><td>" + money(r.amount_cents) + "</td><td>";
      if (r.status === "pending") {
        html += "<button type='button' class='btn' data-kind='withdrawals' data-id='" + r.id + "' data-action='approve'>Approve</button>";
        html += "<button type='button' class='btn ghost' data-kind='withdrawals' data-id='" + r.id + "' data-action='decline'>Decline</button>";
      } else html += r.status;
      html += "</td></tr>";
    });
    document.getElementById("wdBox").innerHTML = html + "</table>";
  });
  api("/api/admin/cards").then(function (d) {
    var html = "<table><tr><th>Student</th><th>Card</th><th>Fee</th><th>Ending</th><th></th></tr>";
    (d.cards || []).forEach(function (r) {
      html += "<tr><td>" + esc(r.name || "") + "<br>" + esc(r.email || "") + "</td><td>" + esc(r.product) + "</td><td>" + esc(r.fee || "") + "</td><td>ÃÂ¢ÃÂÃÂ¢ÃÂ¢ÃÂÃÂ¢ÃÂ¢ÃÂÃÂ¢ÃÂ¢ÃÂÃÂ¢ " + esc(r.last4 || "") + "</td><td>";
      if (r.status === "pending") {
        html += "<button type='button' class='btn' data-kind='cards' data-id='" + r.id + "' data-action='approve'>Approve card</button>";
        html += "<button type='button' class='btn ghost' data-kind='cards' data-id='" + r.id + "' data-action='decline'>Decline</button>";
      } else html += r.status;
      html += "</td></tr>";
    });
    document.getElementById("cardBox").innerHTML = html + "</table>";
  });
}

document.body.addEventListener("click", function (e) {
  var t = e.target.closest("[data-go],[data-dots],[data-act],[data-open],[data-decline],[data-kind]");
  if (!t) {
    if (!e.target.closest(".dots")) document.querySelectorAll(".menu").forEach(function (m) { m.classList.remove("show"); });
    return;
  }
  if (t.getAttribute("data-go")) {
    go(t.getAttribute("data-go"));
    return;
  }
  if (t.getAttribute("data-dots")) {
    var id = t.getAttribute("data-dots");
    document.querySelectorAll(".menu").forEach(function (m) { if (m.id !== "m" + id) m.classList.remove("show"); });
    var menu = document.getElementById("m" + id);
    if (menu) menu.classList.toggle("show");
    return;
  }
  if (t.getAttribute("data-act")) {
    pick(t.getAttribute("data-id"), t.getAttribute("data-act"));
    document.querySelectorAll(".menu").forEach(function (m) { m.classList.remove("show"); });
    return;
  }
  if (t.getAttribute("data-open")) {
    api("/api/admin/customers/" + t.getAttribute("data-open") + "/approve", "POST").then(function (r) {
      if (r.error) { alert(r.error); return; }
      if (r.mail && window.axiaSendMail) axiaSendMail("welcome", { to_email: r.mail.email, email: r.mail.email, name: r.mail.name });
      load();
    });
    return;
  }
  if (t.getAttribute("data-decline")) {
    api("/api/admin/customers/" + t.getAttribute("data-decline") + "/decline", "POST").then(function (r) {
      if (r.error) { alert(r.error); return; }
      load();
    });
    return;
  }
  if (t.getAttribute("data-kind")) {
    api("/api/admin/" + t.getAttribute("data-kind") + "/" + t.getAttribute("data-id") + "/" + t.getAttribute("data-action"), "POST").then(function (r) {
      if (r.error) { alert(r.error); return; }
      if (r.mail && window.axiaSendMail) sendBankMail(r.mail.type, r.mail);
      load();
    });
  }
});

document.getElementById("pickStudent").onchange = function () {
  if (this.value) pick(this.value);
};
document.getElementById("adminSearch").oninput = function () { load(); };

document.getElementById("fGo").onclick = function () {
  if (!current) return alert("Select a student first");
  api("/api/admin/customers/" + current.id + "/fund", "POST", {
    amount: document.getElementById("fAmt").value,
    account: document.getElementById("fType").value,
    account_number: document.getElementById("fAcct").value,
    bank_name: document.getElementById("fBank").value,
    holder_name: document.getElementById("fName").value,
    set_time: document.getElementById("fTime").value
  }).then(function (r) {
    document.getElementById("fMsg").textContent = r.error || "Funded. Refresh the student dashboard.";
    if (r.mail && window.axiaSendMail) sendBankMail("deposit", r.mail);
    if (!r.error) load();
  });
};
document.getElementById("dGo").onclick = function () {
  if (!current) return alert("Select a student first");
  api("/api/admin/customers/" + current.id + "/debit", "POST", {
    amount: document.getElementById("dAmt").value,
    account: document.getElementById("dType").value,
    account_number: document.getElementById("dAcct").value,
    bank_name: document.getElementById("dBank").value,
    holder_name: document.getElementById("dName").value,
    set_time: document.getElementById("dTime").value
  }).then(function (r) {
    document.getElementById("dMsg").textContent = r.error || "Debited.";
    if (r.mail && window.axiaSendMail) sendBankMail("debit", r.mail);
    if (!r.error) load();
  });
};
document.getElementById("eSave").onclick = function () {
  if (!current) return alert("Select a student first");
  api("/api/admin/customers/" + current.id, "POST", {
    first_name: document.getElementById("eFirst").value,
    last_name: document.getElementById("eLast").value,
    username: document.getElementById("eUser").value,
    phone: document.getElementById("ePhone").value,
    address: document.getElementById("eAddr").value,
    country: document.getElementById("eCountry").value,
    employment: document.getElementById("eEmp").value
  }).then(function (r) {
    document.getElementById("eMsg").textContent = r.error || "Saved";
    if (!r.error) load();
  });
};
document.getElementById("stOn").onclick = function () {
  if (!current) return alert("Select a student first");
  api("/api/admin/customers/" + current.id + "/status", "POST", { status: "active" }).then(function (r) {
    document.getElementById("stMsg").textContent = r.error || "Activated";
    if (!r.error) { current.status = "active"; fillForms(); load(); }
  });
};
document.getElementById("stOff").onclick = function () {
  if (!current) return alert("Select a student first");
  api("/api/admin/customers/" + current.id + "/status", "POST", { status: "dormant" }).then(function (r) {
    document.getElementById("stMsg").textContent = r.error || "Set dormant";
    if (!r.error) { current.status = "dormant"; fillForms(); load(); }
  });
};
document.getElementById("mGo").onclick = function () {
  if (!current) return alert("Select a student first");
  var kind = document.getElementById("mKind").value;
  var text = document.getElementById("mText").value || ("Axia " + kind + " notice");
  var amt = document.getElementById("mAmt").value;
  document.getElementById("mMsg").textContent = "SendingÃÂ¢ÃÂÃÂ¦";
  api("/api/admin/customers/" + current.id + "/note", "POST", { title: "Message from Axia", body: text + (amt ? " Amount: " + amt : "") });
  if (!window.axiaSendMail) { document.getElementById("mMsg").textContent = "Saved to student alerts. Email helper missing."; return; }
  sendBankMail(kind, {
    email: current.email,
    name: current.first_name,
    amount: amt,
    purpose: text,
    date: new Date().toLocaleString()
  }).then(function () { document.getElementById("mMsg").textContent = "Email sent and saved to student alerts."; })
    .catch(function (err) { document.getElementById("mMsg").textContent = "Saved to student alerts. EmailJS: " + String(err); });
};
document.getElementById("sGo").onclick = function () {
  if (!current) return alert("Select a student first");
  var body = { username: document.getElementById("sUser").value };
  var p1 = document.getElementById("sPass").value, p2 = document.getElementById("sPass2").value;
  if (p1 || p2) { body.password = p1; body.password_confirm = p2; }
  var n1 = document.getElementById("sPin").value, n2 = document.getElementById("sPin2").value;
  if (n1 || n2) { body.pin = n1; body.pin_confirm = n2; }
  api("/api/admin/customers/" + current.id, "POST", body).then(function (r) {
    document.getElementById("sMsg").textContent = r.error || "Security saved. No email sent.";
  });
};

var chatWs = null, openThread = "";

function renderAdminMsg(m) {
  var html = "<div style='margin:6px 0'><b>" + esc((m && m.from) || "") + ":</b> ";
  if (m && m.text) html += esc(m.text);
  if (m && m.image) html += "<div><img src='" + String(m.image).replace(/'/g, "") + "' style='max-width:160px;display:block;margin-top:4px;border-radius:8px'></div>";
  return html + "</div>";
}

function closeAdminChat() {
  var box = document.getElementById("chatBox");
  box.classList.remove("on");
  box.style.display = "none";
}
function openAdminChat() {
  var box = document.getElementById("chatBox");
  box.classList.add("on");
  box.style.display = "flex";
  if (!chatWs || chatWs.readyState > 1) chatConnect();
}
function chatConnect() {
  var proto = location.protocol === "https:" ? "wss://" : "ws://";
  chatWs = new WebSocket(proto + location.host + "/chat");
  chatWs.onopen = function () {
    var log = document.getElementById("chatLog");
    if (log && !log.innerHTML) log.textContent = "Chat online. Pick a student email.";
    chatWs.send(JSON.stringify({ type: "join", role: "admin", token: token }));
    var to = document.getElementById("chatTo");
    if (to && to.value.trim()) {
      openThread = to.value.trim().toLowerCase();
      chatWs.send(JSON.stringify({ type: "open", threadId: openThread }));
    }
  };
  chatWs.onclose = function () {
    chatWs = null;
    setTimeout(function () {
      if (document.getElementById("chatBox").classList.contains("on")) chatConnect();
    }, 1500);
  };
  chatWs.onmessage = function (ev) {
    var data = JSON.parse(ev.data);
    if (data.type === "error") { document.getElementById("chatLog").textContent = data.error; return; }
    if (data.type === "threads") {
      document.getElementById("chatThreads").innerHTML = (data.threads || []).map(function (t) {
        var last = t.last && t.last.text ? " Ã¢ÂÂ " + String(t.last.text).slice(0, 24) : "";
        return "<div data-th='" + esc(t.id) + "' style='padding:6px;border-bottom:1px solid #eadfd3;cursor:pointer'>" + esc(t.id) + last + "</div>";
      }).join("") || "No student chats yet.";
    }
    if (data.type === "history") {
      if (data.threadId) openThread = data.threadId;
      document.getElementById("chatLog").innerHTML = "";
      (data.messages || []).forEach(function (m) {
        document.getElementById("chatLog").innerHTML += renderAdminMsg(m);
      });
    }
    if (data.type === "message") {
      if (!openThread) openThread = data.threadId;
      if (data.threadId === openThread && data.message) {
        document.getElementById("chatLog").innerHTML += renderAdminMsg(data.message);
      }
    }
  };
};

document.getElementById("chatFab").onclick = function () {
  var box = document.getElementById("chatBox");
  if (box.classList.contains("on")) closeAdminChat();
  else openAdminChat();
};
document.getElementById("chatClose").onclick = function (e) {
  e.preventDefault();
  e.stopPropagation();
  closeAdminChat();
};
document.getElementById("chatThreads").onclick = function (e) {
  var id = e.target.getAttribute("data-th");
  if (!id || !chatWs) return;
  openThread = id;
  document.getElementById("chatLog").innerHTML = "";
  chatWs.send(JSON.stringify({ type: "open", threadId: id }));
};
document.getElementById("chatIn").onkeydown = function (e) {
  if (e.key === "Enter") { e.preventDefault(); sendAdminChat(); }
};
var adminTypeTimer = null;
document.getElementById("chatIn").oninput = function () {
  var to = document.getElementById("chatTo");
  if (to && to.value.trim()) openThread = to.value.trim().toLowerCase();
  if (!chatWs || chatWs.readyState !== 1 || !openThread) return;
  chatWs.send(JSON.stringify({ type: "typing", threadId: openThread, on: true }));
  clearTimeout(adminTypeTimer);
  adminTypeTimer = setTimeout(function () {
    if (chatWs && chatWs.readyState === 1) chatWs.send(JSON.stringify({ type: "typing", threadId: openThread, on: false }));
  }, 800);
};
document.getElementById("adminOut").onclick = function () {
  fetch("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + token } });
  localStorage.removeItem("axia_admin_token");
};
load();
