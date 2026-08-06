import type { ExtensionContext, Theme, ThemeColor } from "@bastani/atomic";

/**
 * Command output leaves this extension as one string through ctx.ui.notify, which the
 * host paints dim from end to end. Colour therefore has to be part of the string, and
 * every renderer takes a painter rather than reaching for a theme itself: the themed one
 * in the TUI, the identity one in print mode and in tests, where escape codes are noise.
 */
export interface Paint {
	ok(text: string): string;
	bad(text: string): string;
	warn(text: string): string;
	accent(text: string): string;
	dim(text: string): string;
	bold(text: string): string;
}

export const PLAIN_PAINT: Paint = {
	ok: (text) => text,
	bad: (text) => text,
	warn: (text) => text,
	accent: (text) => text,
	dim: (text) => text,
	bold: (text) => text,
};

/** Pass ✓, fail ✗, advisory ! — one glyph per state, so colour is never the only signal. */
export const PASS = "✓";
export const FAIL = "✗";
export const ADVISORY = "!";
/** Session state: filled when the process is up, hollow when it is not. */
export const RUNNING = "●";
export const STOPPED = "○";

/**
 * Themed painter for the current session. A theme colour is looked up by name and an
 * unknown name throws, so every call falls back to the plain text it was given: a theme
 * that drops a colour must not take a whole report down with it.
 */
export function paintFor(ctx: ExtensionContext): Paint {
	if (!ctx.hasUI) return PLAIN_PAINT;
	const theme = ctx.ui.theme as Theme | undefined;
	if (!theme) return PLAIN_PAINT;
	const paint =
		(color: ThemeColor) =>
		(text: string): string => {
			try {
				return theme.fg(color, text);
			} catch {
				return text;
			}
		};
	return {
		ok: paint("success"),
		bad: paint("error"),
		warn: paint("warning"),
		accent: paint("accent"),
		dim: paint("dim"),
		bold: (text) => {
			try {
				return theme.bold(text);
			} catch {
				return text;
			}
		},
	};
}

const PROGRESS_KEY = "atomic-exe-sandbox-progress";

/**
 * One progress banner for every long remote step: origin in accent, current step dim.
 * The footer status stays plain text, because the footer measures what it prints and
 * escape codes carry no visible width; only the widget above the editor is themed.
 */
export async function showProgress(
	ctx: ExtensionContext,
	message: string,
): Promise<void> {
	if (!ctx.hasUI) return;
	const paint = paintFor(ctx);
	ctx.ui.setStatus(PROGRESS_KEY, `⏳ exe.dev · ${message}`);
	ctx.ui.setWidget(
		PROGRESS_KEY,
		["", `${paint.accent("⏳ exe.dev")} ${paint.dim(`· ${message}`)}`],
		{ placement: "aboveEditor" },
	);
	// Let the banner paint before the next blocking SSH round trip starts.
	await new Promise((resolve) => setTimeout(resolve, 50));
}

export function clearProgress(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(PROGRESS_KEY, undefined);
	ctx.ui.setWidget(PROGRESS_KEY, undefined);
}

const REPAINT_KEY = "atomic-exe-sandbox-repaint";

/**
 * The host mounts "Working…" the moment a slash command is submitted and tears it down
 * when the command resolves — but that teardown never asks for a repaint. The spinner
 * stays on the last painted frame until something else renders, which for a command that
 * ends quietly is the user's next keystroke.
 *
 * An extension cannot repaint directly: it runs in the engine child, where
 * ctx.ui.requestRender only reaches a mounted custom component and setWorkingVisible is
 * a documented no-op. A status write is the one call that still crosses to the host and
 * requests a render there. It is scheduled rather than immediate because it has to
 * arrive after the command's own completion, which is what removes the spinner.
 */
export function repaintAfterCommand(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	// Two shots: the first covers the ordinary case, the second a host that is still
	// finishing the command when the first arrives. Clearing a key that was never set
	// is inert, so the only visible effect is the repaint itself.
	for (const delay of [0, 60]) {
		const timer = setTimeout(() => {
			try {
				ctx.ui.setStatus(REPAINT_KEY, undefined);
			} catch {}
		}, delay);
		timer.unref?.();
	}
}
