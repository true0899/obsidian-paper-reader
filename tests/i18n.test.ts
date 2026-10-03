import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUiLanguage, translate, t } from "../src/i18n";

test("UI language respects Obsidian over browser and recognizes Chinese variants", () => {
	assert.equal(resolveUiLanguage("zh-CN", "en-US"), "zh");
	assert.equal(resolveUiLanguage("zh_TW", "en-US"), "zh");
	assert.equal(resolveUiLanguage("en", "zh-CN"), "en");
	assert.equal(resolveUiLanguage(undefined, "en-GB"), "en");
	assert.equal(resolveUiLanguage(undefined, "zh-HK"), "zh");
	assert.equal(resolveUiLanguage("de", "zh-CN"), "en");
});

test("English UI translates settings and actions, retaining Chinese and unknown fallback", () => {
	assert.equal(translate("默认 PDF 阅读器", "en"), "Default PDF reader");
	assert.equal(translate("批注", "en"), "Comment");
	assert.equal(translate("批注", "zh"), "批注");
	assert.equal(translate("A new untranslated label", "en"), "A new untranslated label");
	assert.equal(t("批注"), "批注");
});

test("UI interpolation retains missing fields and treats user values as literal text", () => {
	assert.equal(translate("第 {page} 页", "en", { page: 12 }), "Page 12");
	assert.equal(translate("第 {page} 页", "zh", { page: 12 }), "第 12 页");
	assert.equal(translate("连接失败：{error}", "en", { error: "$& {page}" }), "Connection failed: $& {page}");
	assert.equal(translate("第 {page} 页", "en"), "Page {page}");
});
