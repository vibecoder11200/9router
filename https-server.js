const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HTTPS_PORT = parseInt(process.env.PORT, 10) || 9997;
const INTERNAL_PORT = 19997;
const HOSTNAME = process.env.HOSTNAME || "0.0.0.0";

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, "ssl", "key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "ssl", "cert.pem")),
};

const child = spawn("node", [".next/standalone/server.js"], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(INTERNAL_PORT), HOSTNAME: "127.0.0.1" },
  stdio: "inherit",
  shell: true,
});

child.on("error", (err) => console.error("Spawn error:", err));
child.on("exit", (code) => process.exit(code));

setTimeout(() => {
  const server = https.createServer(sslOptions, (req, res) => {
    const proxy = http.request(
      {
        hostname: "127.0.0.1",
        port: INTERNAL_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        const headers = { ...proxyRes.headers };
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
      }
    );
    req.pipe(proxy);
    proxy.on("error", (e) => {
      console.error("Proxy error:", e.message);
      res.writeHead(502);
      res.end("Bad Gateway");
    });
  });

  server.listen(HTTPS_PORT, HOSTNAME, () => {
    console.log("=== 9Router HTTPS ====================================");
    console.log("  URL:  https://0.0.0.0:" + HTTPS_PORT);
    console.log("  Cert: " + path.join(__dirname, "ssl", "cert.pem"));
    console.log("  Int:  http://127.0.0.1:" + INTERNAL_PORT);
    console.log("=====================================================");
  });

  server.on("error", (err) => {
    console.error("HTTPS server error:", err.message);
  });
}, 5000);
