import type { ChatTransport } from "../src/llm/transport";
export const fetchTransport: ChatTransport = async (url, body, headers, signal) => {
	const response = await fetch(url, { method: "POST", body, headers, signal, redirect: "error" });
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty response body");
	return {
		status: response.status,
		contentType: response.headers.get("content-type") ?? "",
		body: { async *[Symbol.asyncIterator]() {
			try { while (true) { const result = await reader.read(); if (result.done) break; yield result.value; } }
			finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
		} },
		close: () => { void reader.cancel().catch(() => {}); },
	};
};

export const defaultTransport = fetchTransport;
