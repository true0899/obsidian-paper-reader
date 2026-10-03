/** Desktop transport preserves streaming without browser CORS restrictions. */
export interface ChatResponse {
	status: number;
	contentType: string;
	body: AsyncIterable<Uint8Array>;
	close(): void;
}
export type ChatTransport = (url: string, body: string, headers: Record<string, string>, signal: AbortSignal) => Promise<ChatResponse>;

// Load typed Node modules only when the desktop transport is actually used.
export const desktopTransport: ChatTransport = async (url, body, headers, signal) => {
	const [http, zlib] = await Promise.all([
		new URL(url).protocol === "https:" ? import("node:https") : import("node:http"),
		import("node:zlib"),
	]);
	return new Promise((resolve, reject) => {
		const request = http.request(url, { method: "POST", headers: { ...headers, "Accept-Encoding": "identity" }, signal }, response => {
			const encoding = response.headers["content-encoding"];
			const decoded = encoding === "gzip" ? response.pipe(zlib.createGunzip()) : encoding === "deflate" ? response.pipe(zlib.createInflate()) : encoding === "br" ? response.pipe(zlib.createBrotliDecompress()) : response;
			const onAbort = () => { decoded.destroy(new Error("Request aborted")); response.destroy(); };
			if (decoded !== response) response.on("error", error => decoded.destroy(error));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			response.on("error", reject);
			if (decoded !== response) decoded.on("error", reject);
			const close = () => { signal.removeEventListener("abort", onAbort); decoded.destroy(); response.destroy(); request.destroy(); };
			resolve({ status: response.statusCode ?? 0, contentType: String(response.headers["content-type"] ?? ""),
				body: { async *[Symbol.asyncIterator]() {
					try {
						for await (const raw of decoded) {
							const chunk: unknown = raw;
							if (!(chunk instanceof Uint8Array)) throw new Error("Invalid response chunk");
							yield chunk;
						}
					} finally { close(); }
				} }, close });
		});
		request.on("error", reject);
		request.end(body);
	});
};

export const defaultTransport = desktopTransport;
