import type { ExtensionContext, KeybindingsManager, Theme } from "@bastani/atomic";
import { DynamicBorder } from "@bastani/atomic";
import {
	Container,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type OverlayOptions,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	inspectWorktree,
	isDirtyWorktree,
	type WorktreeStatus,
} from "./git.js";
import { paintFor } from "./ui.js";

/**
 * Zero-width APC mark for the selected row. Newer Atomic hosts keep that row
 * when a reserved overlay is cropped; older hosts ignore the sequence.
 */
const ACTIVE_ROW_MARKER = "\u001B_atomic:active\u0007";

export type { WorktreeStatus } from "./git.js";

export interface WorktreeWarningCopy {
	title: string;
	summary: string;
	consequence: string;
	samples: string[];
	stayLabel: string;
	stayDescription: string;
	proceedLabel: string;
	proceedDescription: string;
	confirmTitle: string;
	confirmMessage: string;
}

const DIRTY_REFUSAL =
	"worktree has tracked, staged, or untracked changes; commit before entering the sandbox";
const SAMPLE_LIMIT = 4;

function counted(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function joinList(parts: string[]): string {
	if (parts.length === 0) return "";
	if (parts.length === 1) return parts[0]!;
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function samplePaths(status: WorktreeStatus): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const path of [
		...status.unmerged,
		...status.staged,
		...status.unstaged,
		...status.untracked,
	]) {
		if (seen.has(path)) continue;
		seen.add(path);
		if (paths.length < SAMPLE_LIMIT) paths.push(path);
	}
	const remaining = seen.size - paths.length;
	if (remaining > 0) paths.push(`and ${remaining} more`);
	return paths;
}

export function worktreeWarningCopy(status: WorktreeStatus): WorktreeWarningCopy {
	const parts: string[] = [];
	if (status.unmerged.length)
		parts.push(counted(status.unmerged.length, "unmerged path", "unmerged paths"));
	if (status.staged.length)
		parts.push(counted(status.staged.length, "staged path", "staged paths"));
	if (status.unstaged.length)
		parts.push(
			counted(status.unstaged.length, "unstaged path", "unstaged paths"),
		);
	if (status.untracked.length)
		parts.push(
			counted(status.untracked.length, "untracked path", "untracked paths"),
		);
	const summary = `This branch has ${joinList(parts)}.`;
	const consequence =
		"The sandbox clones the published GitHub branch. None of this local work is copied.";
	return {
		title: "Local work stays here",
		summary,
		consequence,
		samples: samplePaths(status),
		stayLabel: "Stay here",
		stayDescription: "Do not open the sandbox",
		proceedLabel: "Enter sandbox",
		proceedDescription: "Continue without local work",
		confirmTitle: "Local work stays here",
		confirmMessage: `${summary}\n\n${consequence}`,
	};
}

function hint(theme: Theme, keys: string[], description: string): string {
	const label = keys.length ? keys.join("/") : description;
	return `${theme.fg("dim", label)} ${theme.fg("muted", description)}`;
}

function markActiveRow(lines: string[]): string[] {
	const index = lines.findIndex((line) => visibleWidth(line) > 0 && line.includes("→ "));
	if (index < 0) return lines;
	const next = lines.slice();
	next[index] = `${next[index] ?? ""}${ACTIVE_ROW_MARKER}`;
	return next;
}

export function dirtyWorktreeDialog(
	status: WorktreeStatus,
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (proceed: boolean) => void,
) {
	const copy = worktreeWarningCopy(status);
	const items: SelectItem[] = [
		{
			value: "stay",
			label: copy.stayLabel,
			description: copy.stayDescription,
		},
		{
			value: "enter",
			label: copy.proceedLabel,
			description: copy.proceedDescription,
		},
	];
	const container = new Container();
	const title = new Text("", 1, 0);
	const summary = new Text("", 1, 0);
	const consequence = new Text("", 1, 0);
	const samples = new Text("", 1, 0);
	const footer = new Text("", 1, 0);
	const selectList = new SelectList(items, items.length, {
		selectedPrefix: (text) => theme.fg("warning", text),
		selectedText: (text) => theme.fg("warning", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	});
	selectList.onSelect = (item) => done(item.value === "enter");
	selectList.onCancel = () => done(false);

	const paint = () => {
		title.setText(theme.fg("warning", theme.bold(copy.title)));
		summary.setText(theme.fg("text", copy.summary));
		consequence.setText(theme.fg("muted", copy.consequence));
		samples.setText(
			copy.samples.length
				? theme.fg("dim", copy.samples.map((path) => `· ${path}`).join("\n"))
				: "",
		);
		footer.setText(
			[
				hint(theme, keybindings.getKeys("tui.select.up").concat(keybindings.getKeys("tui.select.down")), "navigate"),
				hint(theme, keybindings.getKeys("tui.select.confirm"), "choose"),
				hint(theme, keybindings.getKeys("tui.select.cancel"), "cancel"),
			].join("  "),
		);
	};

	container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
	container.addChild(new Spacer(1));
	container.addChild(title);
	container.addChild(new Spacer(1));
	container.addChild(summary);
	container.addChild(consequence);
	if (copy.samples.length) {
		container.addChild(new Spacer(1));
		container.addChild(samples);
	}
	container.addChild(new Spacer(1));
	container.addChild(selectList);
	container.addChild(new Spacer(1));
	container.addChild(footer);
	container.addChild(new Spacer(1));
	container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
	paint();

	return {
		render(width: number): string[] {
			const frame = Math.max(1, width);
			const lines = container.render(frame).flatMap((line) =>
				visibleWidth(line) <= frame ? [line] : wrapTextWithAnsi(line, frame),
			);
			return markActiveRow(
				lines.map((line) => truncateToWidth(line, frame, "")),
			);
		},
		invalidate(): void {
			paint();
			container.invalidate();
			selectList.invalidate();
		},
		handleInput(data: string): boolean {
			selectList.handleInput(data);
			tui.requestRender();
			return true;
		},
	};
}

export async function confirmDirtyWorktree(
	ctx: ExtensionContext,
	status: WorktreeStatus,
): Promise<boolean> {
	const copy = worktreeWarningCopy(status);
	if (!ctx.hasUI) throw new Error(DIRTY_REFUSAL);
	if (ctx.mode === "tui") {
		const options: {
			overlay: boolean;
			handlesCtrlC: boolean;
			overlayOptions: OverlayOptions;
		} = {
			overlay: true,
			handlesCtrlC: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "100%",
				minWidth: 40,
				maxHeight: "70%",
			},
		};
		return ctx.ui.custom<boolean>(
			(tui, theme, keybindings, done) =>
				dirtyWorktreeDialog(status, tui, theme, keybindings, done),
			Object.assign(options, { reserveTranscriptRows: true }),
		);
	}
	return ctx.ui.confirm(copy.confirmTitle, copy.confirmMessage);
}

/**
 * True when the worktree is clean, or the user chooses to continue knowing
 * local work will not be cloned. False when they stay. Throws without UI.
 */
export async function allowDirtyWorktree(ctx: ExtensionContext): Promise<boolean> {
	const status = inspectWorktree(ctx.cwd);
	if (!isDirtyWorktree(status)) return true;
	const ok = await confirmDirtyWorktree(ctx, status);
	if (ok)
		ctx.ui.notify(
			paintFor(ctx).warn(
				"Continuing with local work that will not be in the sandbox.",
			),
			"warning",
		);
	return ok;
}
