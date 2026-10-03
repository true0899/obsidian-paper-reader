globalThis.window = { setTimeout, clearTimeout } as unknown as Window & typeof globalThis;
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { App } from "obsidian";
import { LlmClient, LlmError } from "../src/llm/client";
import { desktopTransport, type ChatTransport } from "../src/llm/transport";
import { sseData } from "../src/llm/sse";

const config = () => ({ baseUrl: "http://127.0.0.1:1234/v1", apiKey: "test-only", model: "test" });
const encode = (text: string) => new TextEncoder().encode(text);
const event = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
const transport = (body: AsyncIterable<Uint8Array>): ChatTransport => async (_url, request) => {
 assert.equal(JSON.parse(request).stream, true);
 return { status: 200, contentType: "text/event-stream", body, close() {} };
};

test("SSE preserves split UTF-8, CRLF, comments and multiline events", async () => {
 const source = encode(': ping\r\ndata: 中文\r\ndata: second\r\n\r\ndata: [DONE]\r\n\r\n');
 const body = { async *[Symbol.asyncIterator]() { for (const byte of source) yield new Uint8Array([byte]); } };
 const events = []; for await (const value of sseData(body)) events.push(value);
 assert.deepEqual(events, ["中文\nsecond", "[DONE]"]);
});

test("first SSE text arrives before response completes; malformed/truncated streams fail", async () => {
 let resume!: () => void;
 const gate = new Promise<void>(r => { resume = r; });
 const body = { async *[Symbol.asyncIterator]() { yield encode(event("first")); await gate; yield encode(event(" second") + 'data: [DONE]\n\n'); } };
 const client = new LlmClient(new App(), config, { transport: transport(body) });
 const stream = client.streamChat([]);
 assert.deepEqual(await stream.next(), { value: "first", done: false });
 resume(); assert.equal((await stream.next()).value, " second"); assert.equal((await stream.next()).done, true);
 for (const data of [event("partial"), 'data: {invalid}\n\n', 'data: [DONE]\n\n']) {
  const bad = new LlmClient(new App(), config, { transport: transport({ async *[Symbol.asyncIterator]() { yield encode(data); } }) });
  await assert.rejects(async () => { for await (const _ of bad.streamChat([])) {} }, (e: LlmError) => e.code === "parse");
 }
});

test("cancel and timeout stop a stalled request with distinct errors", async () => {
 let cancelled = 0;
 const stalled: ChatTransport = (_url, _body, _headers, signal) => new Promise((_resolve, reject) => {
  const cancel = () => { cancelled++; reject(new Error("aborted")); };
  signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
 });
 const abort = new AbortController();
 const client = new LlmClient(new App(), config, { transport: stalled, timeoutMs: 30 });
 const pending = client.streamChat([], abort.signal).next(); abort.abort();
 await assert.rejects(pending, (e: LlmError) => e.code === "abort");
 await assert.rejects(client.streamChat([]).next(), (e: LlmError) => e.code === "timeout");
 assert.equal(cancelled, 2);
});

test("desktop transport streams a local endpoint and closes its socket on cancellation", async () => {
 let body = "", closed!: () => void;
 const disconnected = new Promise<void>(resolve => { closed = resolve; });
 const server = createServer((req, res) => {
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(event("early")); });
  res.on("close", closed);
 });
 await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
 try {
  const address = server.address() as { port: number };
  const client = new LlmClient(new App(), () => ({ ...config(), baseUrl: `http://127.0.0.1:${address.port}/v1` }), { transport: desktopTransport });
  const abort = new AbortController(), stream = client.streamChat([], abort.signal);
  assert.equal((await stream.next()).value, "early");
  assert.equal(JSON.parse(body).stream, true);
  const next = stream.next(); abort.abort();
  await assert.rejects(next, (e: LlmError) => e.code === "abort");
  await disconnected;
 } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
