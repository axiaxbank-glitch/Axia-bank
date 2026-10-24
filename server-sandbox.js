const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const db = require("./db/store");
const createApp = require("./app-core");

const PORT = Number(process.env.PORT) || 3000;
const root = __dirname;
const mime = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon"
};
let wss;
function serveStatic(req, res, url) {
  var file = url === "/" ? "/index.html" : url;
  var full = path.join(root, file);
  if (full.indexOf(root) !== 0 || /^\/(data|db|worker|node_modules)\//.test(file)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(full, function (err, data) {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "text/plain" });
    res.end(data);
  });
}
const app = createApp(db, { serveStatic: serveStatic, clients: function () { return wss.clients; } });
const server = http.createServer(app.handler);
wss = new WebSocketServer({ server: server, path: "/chat" });
wss.on("connection", app.onConnection);

db.init().then(function () {
  server.listen(PORT, function () {
    console.log("Axia server running on http://localhost:" + PORT);
  });
});
