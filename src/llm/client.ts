import { t } from "../i18n";
import type { App } from "obsidian";
import { defaultTransport, type ChatTransport, type ChatResponse } from "./transport";
import { sseData } from "./sse";

export interface LlmConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export class LlmError extends Error {
	constructor(
		readonly code: "config" | "http" | "network" | "timeout" | "parse" | "abort",
		message: string
	) {
		super(message);
		this.name = "LlmError";
	}
}

function chatCompletionsUrl(baseUrl: string): string {
	let url: URL;
	try { url = new URL(baseUrl); } catch {
		throw new LlmError("config", t("接口地址无效，请填写完整的 HTTPS URL"));
	}
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
		url.username || url.password || url.search || url.hash) {
		throw new LlmError("config", t("远程接口必须使用 HTTPS；仅本机地址允许 HTTP。地址不能包含账号、密码、查询参数或片段。"));
	}
	url.pathname = url.pathname.replace(/\/+$/, "") + "/chat/completions";
	return url.href;
}

async function httpError(status: number, body: string): Promise<LlmError> {
	if (status === 401 || status === 403) {
		return new LlmError("http", t("API Key 无效或已过期（HTTP {status}）", { status }));
	}
	if (status === 404) {
		return new LlmError("http", t("接口地址不存在（HTTP 404），请检查 Base URL 是否以 /v1 结尾"));
	}
	if (status === 429) {
		return new LlmError("http", t("请求被限流（HTTP 429），请稍后重试"));
	}
	const detail = body.slice(0, 200);
	return new LlmError("http", t("请求失败（HTTP {status}）{detail}", { status, detail: detail ? `: ${detail}` : "" }));
}

/** OpenAI-compatible SSE client with cancellation and a bounded request lifetime. */
export class LlmClient {
	constructor(_app: App, private getConfig: () => LlmConfig,
		private options: { transport?: ChatTransport; timeoutMs?: number } = {}) {}

	private ensureConfig(): LlmConfig {
		const c = this.getConfig();
		if (!c.baseUrl.trim() || !c.apiKey.trim() || !c.model.trim()) {
			throw new LlmError("config", t("请先在 设置 → Paper Reader 中填写 Base URL / API Key / 模型名"));
		}
		chatCompletionsUrl(c.baseUrl);
		return { ...c };
	}

	private async *request(messages: ChatMessage[], stream: boolean, signal?: AbortSignal): AsyncGenerator<string> {
		const config = this.ensureConfig();
		const abort = new AbortController();
		const cancel = () => abort.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.options.timeoutMs ?? 120000);
		let response: ChatResponse | undefined;
		try {
			if (abort.signal.aborted) throw new LlmError("abort", t("请求已取消"));
			response = await (this.options.transport ?? defaultTransport)(chatCompletionsUrl(config.baseUrl),
				JSON.stringify({ model: config.model, messages, stream, ...(!stream ? { max_tokens: 1 } : {}) }),
				{ "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, Accept: stream ? "text/event-stream" : "application/json" }, abort.signal);
			if (response.status < 200 || response.status >= 300) throw await httpError(response.status, await this.readText(response, 4096));
			if (!response.contentType.includes("text/event-stream")) {
				const json = JSON.parse(await this.readText(response)) as { choices?: Array<{ message?: { content?: unknown } }> };
				const content = json?.choices?.[0]?.message?.content;
				if (typeof content !== "string") throw new LlmError("parse", t("响应格式无法解析"));
				yield content; return;
			}
			let finished = false, contentReceived = false;
			for await (const event of sseData(response.body)) {
				if (abort.signal.aborted) throw new LlmError("abort", t("请求已取消"));
				if (event.trim() === "[DONE]") { finished = true; break; }
				const json = JSON.parse(event) as { error?: unknown; choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }> };
				if (json.error) throw new LlmError("parse", t("接口返回错误，无法生成回答"));
				const choice = json.choices?.[0];
				if (choice?.finish_reason) finished = true;
				if (typeof choice?.delta?.content === "string" && choice.delta.content) {
					contentReceived = true; yield choice.delta.content;
				}
			}
			if (!finished || !contentReceived) throw new LlmError("parse", t("响应未完成或没有文本内容，请重试"));
		} catch (e) {
			if (timedOut) throw new LlmError("timeout", t("请求超时，请稍后重试"));
			if (abort.signal.aborted) throw new LlmError("abort", t("请求已取消"));
			if (e instanceof LlmError) throw e;
			if (e instanceof SyntaxError) throw new LlmError("parse", t("响应格式无法解析"));
			throw new LlmError("network", t("网络错误：{error}", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			abort.abort();
			response?.close();
		}
	}

	private async readText(response: ChatResponse, maxBytes = 2 * 1024 * 1024): Promise<string> {
		const decoder = new TextDecoder(); let text = "", size = 0;
		for await (const chunk of response.body) {
			size += chunk.byteLength;
			if (size > maxBytes) { if (maxBytes === 4096) break; throw new LlmError("parse", t("响应内容过大")); }
			text += decoder.decode(chunk, { stream: true });
		}
		return text + decoder.decode();
	}

	async *streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
		yield* this.request(messages, true, signal);
	}

	async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
		try {
			for await (const _ of this.request([{ role: "user", content: "hi" }], false, signal)) {}
			return { ok: true };
		} catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
	}
}
