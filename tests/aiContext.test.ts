import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPageContext } from "../src/llm/context";

test("cross-page introduction is included in document order even when opened on page two", async () => {
 const pages = ["Introduction: start", "Introduction: continuation", "Methods"];
 const text = await buildPageContext(2, 3, async p => pages[p - 1], () => true);
 assert.equal(text, "[page 1]\nIntroduction: start\n[page 2]\nIntroduction: continuation\n[page 3]\nMethods\n");
});

test("context budget keeps complete neighboring pages and declares omissions", async () => {
 const text = await buildPageContext(1, 3, async p => `paragraph ${p}`, () => true, 45);
 assert.ok(text.includes("[page 2]\nparagraph 2\n"));
 assert.ok(!text.includes("[page 3]"));
 assert.ok(text.includes("[context truncated:"));
});

test("oversized current page is bounded and marked partial", async () => {
 const text = await buildPageContext(1, 1, async () => "x".repeat(100), () => true, 30);
 assert.ok(text.startsWith("[page 1]\n"));
 assert.ok(text.includes("[context truncated:"));
 assert.equal(text.split("\n[context truncated:")[0].length, 30);
});

test("document changes stop context extraction before another page is read", async () => {
 let current = true, reads = 0;
 await assert.rejects(buildPageContext(1, 3, async () => { reads++; current = false; return "text"; }, () => current), /Document changed/);
 assert.equal(reads, 1);
});
