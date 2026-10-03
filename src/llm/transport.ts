/** Desktop transport has no browser CORS restriction; browser harness uses fetch. */
export interface ChatResponse {
	status: number;
	contentType: string;
	body: AsyncIterable<Uint8Array>;
	close(): void;
}
export type ChatTransport = (url: string, body: string, headers: Record<string, string>, signal: AbortSignal) => Promise<ChatResponse>;

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

// Dynamic require keeps Node modules external in both the desktop bundle and browser tests.
export const desktopTransport: ChatTransport = async (url, body, headers, signal) => {
	const moduleName = new URL(url).protocol === "https:" ? "node:https" : "node:http";
	const http = require(moduleName) as typeof import("node:http");
	return new Promise((resolve, reject) => {
		const request = http.request(url, { method: "POST", headers: { ...headers, "Accept-Encoding": "identity" }, signal }, response => {
			const encoding = response.headers["content-encoding"];
			const zlibName = "node:zlib";
			const zlib = encoding ? require(zlibName) as typeof import("node:zlib") : null;
			const decoded = encoding === "gzip" ? response.pipe(zlib!.createGunzip()) : encoding === "deflate" ? response.pipe(zlib!.createInflate()) : encoding === "br" ? response.pipe(zlib!.createBrotliDecompress()) : response;
			const onAbort = () => { decoded.destroy(new Error("Request aborted")); response.destroy(); };
			if (decoded !== response) response.on("error", error => decoded.destroy(error));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			response.on("error", reject);
			if (decoded !== response) decoded.on("error", reject);
			const close = () => { signal.removeEventListener("abort", onAbort); decoded.destroy(); response.destroy(); request.destroy(); };
			resolve({ status: response.statusCode ?? 0, contentType: String(response.headers["content-type"] ?? ""),
				body: { async *[Symbol.asyncIterator]() { try { for await (const chunk of decoded) yield chunk as Uint8Array; } finally { close(); } } }, close });
		});
		request.on("error", reject);
		request.end(body);
	});
};

export const defaultTransport: ChatTransport = (...args) => {
	const desktop = typeof process !== "undefined" && !!process.versions?.electron;
	return (desktop ? desktopTransport : fetchTransport)(...args);
};
