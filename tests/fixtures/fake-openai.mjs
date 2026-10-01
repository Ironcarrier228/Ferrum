// Minimal OpenAI-compatible chat-completions server for offline tests.
// Records every request body so tests can assert what the gateway sends to the model.
// Usage: node tests/fixtures/fake-openai.mjs [port] [logfile]
// Optional scripted tool call: FAKE_TOOL_CALL='{"name":"exec","arguments":{"command":"id"}}'
// (returned on the first request of a conversation, plain text afterwards).
import http from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 20128);
const logFile = process.argv[3] ?? "/tmp/fake-openai.log";
const scripted = process.env.FAKE_TOOL_CALL ? JSON.parse(process.env.FAKE_TOOL_CALL) : null;

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      appendFileSync(logFile, JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ? "present" : "absent", body: safe(body) }) + "\n");
      if (req.url.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      }
      if (!req.url.endsWith("/chat/completions")) { res.statusCode = 404; return res.end("{}"); }
      const parsed = safe(body);
      const hasToolResult = Array.isArray(parsed?.messages) && parsed.messages.some((m) => m.role === "tool");
      const delta = scripted && !hasToolResult
        ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: scripted.name, arguments: JSON.stringify(scripted.arguments) } }] }
        : { role: "assistant", content: "pong (fake model)" };
      const finish = delta.tool_calls ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (parsed?.stream) {
        res.setHeader("content-type", "text/event-stream");
        const chunk = (d, f) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
        res.write(chunk(delta, null));
        res.write(chunk({}, finish));
        res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [], usage })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 0, model: parsed?.model, choices: [{ index: 0, message: delta, finish_reason: finish }], usage }));
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`fake-openai listening on ${port}`));

function safe(s) { try { return JSON.parse(s); } catch { return s; } }
