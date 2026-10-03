import { selectionIdentity, type SelectionPayload } from "./selection";

export interface PopupCachedState {
	translation?: string;
	noteDraft?: string;
}

/** Cache key identifying "the same selection": page + text identity. */
export function popupCacheKey(payload: SelectionPayload): string {
	return selectionIdentity(payload);
}

/**
 * View-session cache for popup state (translation result + note draft).
 * Survives popup re-renders and hide/show cycles for the same selection;
 * a different selection yields a different key and starts fresh.
 */
export class PopupStateCache {
	private map = new Map<string, PopupCachedState>();
	private textLength = 0;

	constructor(private maxEntries = 100, private maxTextLength = 500_000) {}

	private entryLength(key: string, state: PopupCachedState): number {
		return key.length + (state.translation?.length ?? 0) + (state.noteDraft?.length ?? 0);
	}

	get(key: string): PopupCachedState | undefined {
		const state = this.map.get(key);
		if (state) {
			this.map.delete(key);
			this.map.set(key, state);
		}
		return state ? { ...state } : undefined;
	}

	merge(key: string, state: PopupCachedState): void {
		const previous = this.map.get(key);
		if (previous) this.textLength -= this.entryLength(key, previous);
		this.map.delete(key);
		const merged = { ...previous, ...state };
		this.map.set(key, merged);
		this.textLength += this.entryLength(key, merged);
		while (this.map.size > this.maxEntries || this.textLength > this.maxTextLength) {
			const oldest = this.map.entries().next().value;
			if (!oldest) break;
			this.map.delete(oldest[0]);
			this.textLength -= this.entryLength(oldest[0], oldest[1]);
		}
	}

	clear(): void {
		this.map.clear();
		this.textLength = 0;
	}
}
