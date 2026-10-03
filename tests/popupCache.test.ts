import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PopupStateCache,
	popupCacheKey,
} from "../src/pdfview/popupCache";

function payload(page: number, text: string) {
	return { page, text } as never;
}

test("same selection restores cached state; different selection starts fresh", () => {
	const cache = new PopupStateCache();
	const keyA = popupCacheKey(payload(1, "hello world"));
	cache.merge(keyA, { translation: "你好世界", noteDraft: "草稿" });

	// reopen same selection -> restored
	assert.deepEqual(cache.get(keyA), { translation: "你好世界", noteDraft: "草稿" });
	// same text on another page -> fresh
	assert.equal(cache.get(popupCacheKey(payload(2, "hello world"))), undefined);
	// different text same page -> fresh
	assert.equal(cache.get(popupCacheKey(payload(1, "other text"))), undefined);
});

test("merge accumulates fields; draft can be cleared after submit", () => {
	const cache = new PopupStateCache();
	const key = popupCacheKey(payload(1, "abc"));
	cache.merge(key, { noteDraft: "partial" });
	cache.merge(key, { translation: "译文" });
	assert.deepEqual(cache.get(key), { noteDraft: "partial", translation: "译文" });
	cache.merge(key, { noteDraft: "" });
	assert.deepEqual(cache.get(key), { noteDraft: "", translation: "译文" });
});

test("clear wipes all cached state (new document opened)", () => {
	const cache = new PopupStateCache();
	cache.merge(popupCacheKey(payload(1, "abc")), { translation: "x" });
	cache.clear();
	assert.equal(cache.get(popupCacheKey(payload(1, "abc"))), undefined);
});

test("cache evicts least recently read entries at the count limit", () => {
	const cache = new PopupStateCache(2);
	cache.merge("a", { translation: "first" });
	cache.merge("b", { translation: "second" });
	cache.get("a");
	cache.merge("c", { translation: "third" });
	assert.equal(cache.get("b"), undefined);
	assert.equal(cache.get("a")?.translation, "first");
	assert.equal(cache.get("c")?.translation, "third");
});

test("cache bounds total text and correctly accounts for replacements and clear", () => {
	const cache = new PopupStateCache(100, 10);
	cache.merge("a", { translation: "1234" });
	cache.merge("b", { translation: "1234" });
	cache.merge("b", { translation: "123456" });
	assert.equal(cache.get("a"), undefined);
	assert.equal(cache.get("b")?.translation, "123456");
	cache.clear();
	cache.merge("c", { translation: "123456789" });
	assert.ok(cache.get("c"));
	cache.merge("oversize", { translation: "12345678901" });
	assert.equal(cache.get("oversize"), undefined);
});

test("mutating a returned cache entry cannot bypass the text limit", () => {
	const cache = new PopupStateCache(100, 10);
	cache.merge("a", { translation: "small" });
	cache.get("a")!.translation = "x".repeat(100);
	assert.equal(cache.get("a")?.translation, "small");
});
