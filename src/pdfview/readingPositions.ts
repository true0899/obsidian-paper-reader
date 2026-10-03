import type { ReadingPosition } from "../settings";

export const MAX_READING_POSITIONS = 200;

/** Copy persisted positions and retain the most recently updated documents. */
export function trimReadingPositions(
	positions: Record<string, ReadingPosition> | null | undefined,
	limit = MAX_READING_POSITIONS
): Record<string, ReadingPosition> {
	return Object.fromEntries(
		Object.entries(positions ?? {})
			.sort(([, a], [, b]) => (b?.updatedAt || 0) - (a?.updatedAt || 0))
			.slice(0, Math.max(0, limit))
			.map(([path, position]) => [path, { ...position }])
	);
}

/** Remove a deleted file or every position below a deleted folder. */
export function deleteReadingPositions(
	positions: Record<string, ReadingPosition>, path: string
): boolean {
	let changed = false;
	for (const key of Object.keys(positions)) {
		if (key === path || key.startsWith(`${path}/`)) {
			delete positions[key];
			changed = true;
		}
	}
	return changed;
}
