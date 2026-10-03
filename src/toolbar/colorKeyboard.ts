/** Move keyboard focus without changing the annotation until Enter/Space. */
export function navigateColorButtons(event: KeyboardEvent): void {
	const button = event.currentTarget as HTMLButtonElement;
	const buttons = Array.from(button.parentElement?.querySelectorAll<HTMLButtonElement>(".pr-color-dot") ?? []);
	const current = buttons.indexOf(button);
	let next: number;
	if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % buttons.length;
	else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current + buttons.length - 1) % buttons.length;
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = buttons.length - 1;
	else return;
	event.preventDefault(); event.stopPropagation();
	buttons[next]?.focus();
}
