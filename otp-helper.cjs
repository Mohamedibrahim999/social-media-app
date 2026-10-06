const http = require("http");
const fs = require("fs");
const path = require("path");

const outbox = path.join(process.cwd(), ".mail-outbox");

const server = http.createServer((req, res) => {
  if (req.url !== "/otp") {
    res.writeHead(404);
    return res.end("Not found");
  }

  const files = fs
    .readdirSync(outbox)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      file,
      time: fs.statSync(path.join(outbox, file)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  if (!files.length) {
    res.writeHead(404);
    return res.end("No OTP found");
  }

  const mail = JSON.parse(
    fs.readFileSync(path.join(outbox, files[0].file), "utf8")
  );

  const match = mail.text.match(/\b\d{6}\b/);

  if (!match) {
    res.writeHead(404);
    return res.end("OTP not found");
  }

  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Cache-Control": "no-store",
  });

  res.end(match[0]);
});

server.listen(8090, "127.0.0.1", () => {
  console.log("OTP helper running at http://127.0.0.1:8090/otp");
});
