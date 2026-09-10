window.AXIA_MAIL = {
  /* credit / fund alerts */
  deposit: { service: "service_hbd1d0r", template: "template_kqsbw2g", key: "oy4US4eSupMgA7t7q" },
  credit:  { service: "service_hbd1d0r", template: "template_kqsbw2g", key: "oy4US4eSupMgA7t7q" },
  /* debit alerts */
  debit:   { service: "service_hbd1d0r", template: "template_i7lsyoa", key: "oy4US4eSupMgA7t7q" },
  /* password reset with 6-digit code */
  reset:   { service: "service_hbd1d0r", template: "template_j86o53g", key: "oy4US4eSupMgA7t7q" },
  /* welcome / account open */
  welcome: { service: "service_hbd1d0r", template: "template_05lcbdh", key: "oy4US4eSupMgA7t7q" },
  /* card application approved — create this template in EmailJS if missing; falls back to welcome */
  card:    { service: "service_hbd1d0r", template: "template_9gft0kj", key: "oy4US4eSupMgA7t7q" }
};
window.axiaSendMail = function (kind, params) {
  var map = { credit: "deposit", card_approved: "card", fund: "deposit" };
  var use = map[kind] || kind;
  var cfg = window.AXIA_MAIL[use];
  if (!cfg || !window.emailjs) return Promise.resolve({ skipped: true });
  try { emailjs.init(cfg.key); } catch (e) {}
  return emailjs.send(cfg.service, cfg.template, params || {});
};
