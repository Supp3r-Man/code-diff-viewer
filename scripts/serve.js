// Minimal static file server for local use: `npm start`. Binds to 127.0.0.1 only. No dependencies.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = new Set(["index.html", "src"]); // only the app is served, never package.json, tests or .git
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function resolveRequest(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch (e) {
    return null;
  }
  if (rel.includes("\0")) return null;
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = path.resolve(ROOT, "." + rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null; // path traversal
  const top = path.relative(ROOT, full).split(path.sep)[0];
  if (!PUBLIC.has(top)) return null;
  return full;
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    const file = resolveRequest(req.url || "/");
    if (!file) {
      res.writeHead(404).end("Not found");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  createServer().listen(port, "127.0.0.1", () => console.log("Code Diff Viewer running at http://127.0.0.1:" + port + "/"));
}

module.exports = { createServer, resolveRequest };
