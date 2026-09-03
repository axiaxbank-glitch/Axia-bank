/* Axia Bank - simple frontend prototype storage
   This is a demo only. Do not use for real banking. */

const STORAGE_USERS = "axia_users";
const STORAGE_SESSION = "axia_session";
const STORAGE_TX = "axia_transactions";

function getUsers() {
  return JSON.parse(localStorage.getItem(STORAGE_USERS) || "[]");
}

function saveUsers(users) {
  localStorage.setItem(STORAGE_USERS, JSON.stringify(users));
}

function getSession() {
  return JSON.parse(localStorage.getItem(STORAGE_SESSION) || "null");
}

function setSession(user) {
  localStorage.setItem(STORAGE_SESSION, JSON.stringify({
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName
  }));
}

function clearSession() {
  localStorage.removeItem(STORAGE_SESSION);
}

function getTransactions() {
  return JSON.parse(localStorage.getItem(STORAGE_TX) || "[]");
}

function saveTransactions(list) {
  localStorage.setItem(STORAGE_TX, JSON.stringify(list));
}

function currentUser() {
  const session = getSession();
  if (!session) return null;
  return getUsers().find(u => u.email === session.email) || null;
}

function requireLogin() {
  if (!getSession()) {
    window.location.href = "index.html";
  }
}

function logout() {
  clearSession();
  window.location.href = "index.html";
}

function formatMoney(n) {
  return Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function addTransaction(tx) {
  const list = getTransactions();
  list.unshift({
    id: "TX-" + Date.now(),
    createdAt: new Date().toISOString(),
    ...tx
  });
  saveTransactions(list);
}

function showAlert(el, message, type) {
  if (!el) {
    alert(message);
    return;
  }
  el.textContent = message;
  el.style.display = "block";
  el.style.background = type === "error" ? "#fde8e8" : "#def7ec";
  el.style.color = type === "error" ? "#e02424" : "#057a55";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "8px";
  el.style.marginBottom = "16px";
  el.style.fontSize = "13px";
}

document.addEventListener("DOMContentLoaded", () => {
  const registerForm = document.getElementById("registerForm");
  if (registerForm) {
    registerForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const firstName = document.getElementById("firstName").value.trim();
      const lastName = document.getElementById("lastName").value.trim();
      const email = document.getElementById("email").value.trim().toLowerCase();
      const phone = document.getElementById("phone").value.trim();
      const password = document.getElementById("password").value;
      const confirmPassword = document.getElementById("confirmPassword").value;
      const alertBox = document.getElementById("formAlert");

      if (password.length < 8) {
        showAlert(alertBox, "Password must be at least 8 characters.", "error");
        return;
      }
      if (password !== confirmPassword) {
        showAlert(alertBox, "Passwords do not match.", "error");
        return;
      }

      const users = getUsers();
      if (users.some(u => u.email === email)) {
        showAlert(alertBox, "An account with this email already exists.", "error");
        return;
      }

      const user = {
        firstName,
        lastName,
        email,
        phone,
        password,
        checking: 18240.50,
        savings: 6339.50,
        status: "Active",
        createdAt: new Date().toISOString()
      };
      users.push(user);
      saveUsers(users);
      setSession(user);
      window.location.href = "dashboard.html";
    });
  }

  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const email = document.getElementById("email").value.trim().toLowerCase();
      const password = document.getElementById("password").value;
      const alertBox = document.getElementById("formAlert");
      const user = getUsers().find(u => u.email === email && u.password === password);
      if (!user) {
        showAlert(alertBox, "Invalid email or password.", "error");
        return;
      }
      setSession(user);
      window.location.href = "dashboard.html";
    });
  }

  const transferForm = document.getElementById("transferForm");
  if (transferForm) {
    requireLogin();
    transferForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const user = currentUser();
      const amount = Number(document.getElementById("amount").value);
      const recipient = document.getElementById("recipient").value.trim();
      const fromAccount = document.getElementById("fromAccount").value;
      const note = document.getElementById("note").value.trim();
      const alertBox = document.getElementById("formAlert");

      if (!user) return;
      if (!recipient || amount <= 0) {
        showAlert(alertBox, "Enter a valid recipient and amount.", "error");
        return;
      }
      if (amount > user[fromAccount]) {
        showAlert(alertBox, "Insufficient funds.", "error");
        return;
      }

      user[fromAccount] -= amount;
      const users = getUsers().map(u => u.email === user.email ? user : u);
      saveUsers(users);
      addTransaction({
        email: user.email,
        type: "Transfer",
        description: "Transfer to " + recipient + (note ? " — " + note : ""),
        amount: -amount,
        status: "Pending",
        account: fromAccount
      });
      showAlert(alertBox, "Transfer request submitted. Status: Pending.", "success");
      transferForm.reset();
    });
  }

  const withdrawForm = document.getElementById("withdrawForm");
  if (withdrawForm) {
    requireLogin();
    withdrawForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const user = currentUser();
      const amount = Number(document.getElementById("amount").value);
      const fromAccount = document.getElementById("fromAccount").value;
      const method = document.getElementById("method").value;
      const alertBox = document.getElementById("formAlert");

      if (!user) return;
      if (amount <= 0) {
        showAlert(alertBox, "Enter a valid amount.", "error");
        return;
      }
      if (amount > user[fromAccount]) {
        showAlert(alertBox, "Insufficient funds.", "error");
        return;
      }

      addTransaction({
        email: user.email,
        type: "Withdrawal",
        description: "Withdrawal via " + method,
        amount: -amount,
        status: "Pending",
        account: fromAccount
      });
      showAlert(alertBox, "Withdrawal request submitted for review.", "success");
      withdrawForm.reset();
    });
  }

  const depositForm = document.getElementById("depositForm");
  if (depositForm) {
    requireLogin();
    depositForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const user = currentUser();
      const amount = Number(document.getElementById("amount").value);
      const method = document.getElementById("method").value;
      const alertBox = document.getElementById("formAlert");
      if (!user) return;
      if (amount <= 0) {
        showAlert(alertBox, "Enter a valid amount.", "error");
        return;
      }
      addTransaction({
        email: user.email,
        type: "Deposit",
        description: "Deposit via " + method,
        amount: amount,
        status: "Pending",
        account: "checking"
      });
      showAlert(alertBox, "Deposit submitted. Waiting for confirmation.", "success");
      depositForm.reset();
    });
  }
});
