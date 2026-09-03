window.AXIA_MAIL = {
  debit:    { service: "service_e0ir5qp", template: "template_xx8fkdw", key: "fSn]Fk7RHcNGv-QFx" },
  reset:    { service: "service_e0ir5qp", template: "template_sr0q5sn", key: "fSn]Fk7RHcNGv-QFx" },
  welcome:  { service: "service_hbd1d0r", template: "template_05lcbdh", key: "oy4US4eSupMgA7t7q" },
  deposit:  { service: "service_hbd1d0r", template: "template_kqsbw2g", key: "oy4US4eSupMgA7t7q" }
};
window.axiaSendMail = function (kind, params) {
  var cfg = window.AXIA_MAIL[kind];
  if (!cfg || !window.emailjs) return Promise.resolve({ skipped: true });
  emailjs.init(cfg.key);
  return emailjs.send(cfg.service, cfg.template, params);
};
