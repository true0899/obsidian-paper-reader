/** Incremental SSE framing, including split UTF-8 characters and CRLF boundaries. */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "", data: string[] = [];
	const line = (text: string): string | undefined => {
		if (!text) { const event = data.length ? data.join("\n") : undefined; data = []; return event; }
		if (text.startsWith("data:")) data.push(text.slice(5).replace(/^ /, ""));
		return undefined;
	};
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		if (buffer.length + data.reduce((n, s) => n + s.length, 0) > 1024 * 1024) throw new Error("SSE event exceeds size limit");
		let end: number;
		while ((end = buffer.search(/[\r\n]/)) >= 0) {
			if (buffer[end] === "\r" && end === buffer.length - 1) break;
			const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
			const event = line(buffer.slice(0, end)); buffer = buffer.slice(end + width);
			if (event !== undefined) yield event;
		}
	}
	buffer += decoder.decode();
	if (buffer) { const event = line(buffer.replace(/\r$/, "")); if (event !== undefined) yield event; }
	const final = line(""); if (final !== undefined) yield final;
}
