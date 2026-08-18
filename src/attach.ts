import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, KeybindingsManager, Theme } from "@bastani/atomic";
import { DynamicBorder } from "@bastani/atomic";
import {
	Container,
	Key,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type OverlayOptions,
} from "@earendil-works/pi-tui";
import { SSH_BASE, VM_HOST_KEY_ARGS, vmHost } from "./exe.js";
import { herdrAvailable, type HerdrBridge } from "./herdr.js";

/**
 * Isolated interactive Atomic keeps the real TTY in the host process. Extension
 * code runs in the engine child, whose stdout is the JSONL transport. Stealing
 * that pipe — tui.stop(), a screen clear, ssh inherit — paints an empty frame
 * and never reaches the terminal.
 */
export function isolatedEngineAttach(
	stream: { isTTY?: boolean } = process.stdout,
): boolean {
	return stream.isTTY !== true;
}

export function shEscape(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** cmd.exe quoting: wrap when the token would be split or expanded. */
export function cmdEscape(value: string): string {
	if (!/[ \t"&<>^|()%!]/.test(value)) return value;
	return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Same host-key pin as every other VM call, plus the ssh_dest exe.dev returned
 * when we discovered the VM. The old attach path rebuilt `<name>.exe.xyz` and
 * dropped shard destinations.
 */
export function attachSshArgs(
	vmName: string,
	sessionId: number,
	herdr?: Pick<HerdrBridge, "localSocket" | "remoteSocket">,
): string[] {
	const forwarding = herdr
		? [
				"-o",
				"ExitOnForwardFailure=yes",
				"-o",
				"StreamLocalBindUnlink=yes",
				"-R",
				`${herdr.remoteSocket}:${herdr.localSocket}`,
			]
		: [];
	return [
		...SSH_BASE,
		...VM_HOST_KEY_ARGS,
		...forwarding,
		"-tt",
		vmHost(vmName),
		`~/.atomic-exe/sessionctl report-herdr '${sessionId}'; exec ~/.atomic-exe/sessionctl attach '${sessionId}'`,
	];
}

export function formatAttachCommand(
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
): string {
	const escape = platform === "win32" ? cmdEscape : shEscape;
	return ["ssh", ...args.map(escape)].join(" ");
}

export function writeAttachScript(
	args: readonly string[],
	write: (path: string, body: string) => void = (path, body) =>
		writeFileSync(path, body, { mode: 0o700 }),
	id: string = `${process.pid}-${randomUUID().slice(0, 8)}`,
	platform: NodeJS.Platform = process.platform,
	temp: string = tmpdir(),
): string {
	if (platform === "win32") {
		const path = join(temp, `atomic-exe-attach-${id}.cmd`);
		write(path, `@echo off\r\nssh ${args.map(cmdEscape).join(" ")}\r\n`);
		return path;
	}
	const path = join(temp, `atomic-exe-attach-${id}.sh`);
	write(path, `#!/bin/sh\nexec ssh ${args.map(shEscape).join(" ")}\n`);
	return path;
}

export interface LaunchAttempt {
	command: string;
	args: string[];
	where: string;
}

export interface LaunchResult {
	ok: boolean;
	where: string;
	/** True when the launcher already moved focus to the attach (a new herdr tab). */
	focused?: boolean;
}

export function paneIdFromTabCreate(stdout: string): string | undefined {
	try {
		const value = JSON.parse(stdout) as {
			result?: { root_pane?: { pane_id?: unknown } };
		};
		const id = value.result?.root_pane?.pane_id;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

export type AttachRunner = (
	command: string,
	args: string[],
) => { status: number | null; stdout?: string };

const defaultRunner: AttachRunner = (command, args) => {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return { status: result.status, stdout: result.stdout };
};

export function launchInHerdr(
	command: string[],
	env: NodeJS.ProcessEnv = process.env,
	run: AttachRunner = defaultRunner,
	label = "sandbox",
): LaunchResult {
	const workspace = env.HERDR_WORKSPACE_ID;
	if (!herdrAvailable(env) || !workspace)
		return { ok: false, where: "a new herdr tab" };
	const created = run("herdr", [
		"tab",
		"create",
		"--workspace",
		workspace,
		"--label",
		label,
		"--focus",
	]);
	if (created.status !== 0) return { ok: false, where: "a new herdr tab" };
	const paneId = paneIdFromTabCreate(created.stdout ?? "");
	if (!paneId) return { ok: false, where: "a new herdr tab" };
	const ran = run("herdr", ["pane", "run", paneId, ...command]);
	if (ran.status !== 0) return { ok: false, where: "a new herdr tab" };
	return { ok: true, where: "a new herdr tab", focused: true };
}

export function attachLaunchPlan(
	script: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	label = "sandbox",
): LaunchAttempt[] {
	if (platform === "win32") {
		const title = label.replaceAll('"', "");
		return [
			{
				command: "wt.exe",
				args: ["new-tab", "--title", title, "--", script],
				where: "a new Windows Terminal tab",
			},
			{
				command: "cmd.exe",
				args: ["/c", `start "${title}" ${cmdEscape(script)}`],
				where: "a new console window",
			},
		];
	}
	const attempts: LaunchAttempt[] = [];
	if (env.TMUX)
		attempts.push({
			command: "tmux",
			args: ["new-window", "-n", "sandbox", script],
			where: "a new tmux window",
		});
	if (env.WEZTERM_PANE)
		attempts.push({
			command: "wezterm",
			args: ["cli", "spawn", "--", script],
			where: "a new WezTerm pane",
		});
	if (env.KITTY_WINDOW_ID)
		attempts.push({
			command: "kitty",
			args: ["@", "launch", "--type=tab", "--title", "sandbox", script],
			where: "a new kitty tab",
		});
	if (env.TERM_PROGRAM === "iTerm.app") {
		attempts.push({
			command: "osascript",
			args: [
				"-e",
				`tell application "iTerm" to tell current window to create tab with default profile command ${shEscape(script)}`,
			],
			where: "a new iTerm tab",
		});
		attempts.push({
			command: "osascript",
			args: [
				"-e",
				`tell application "iTerm" to create window with default profile command ${shEscape(script)}`,
			],
			where: "a new iTerm window",
		});
	}
	if (env.TERM_PROGRAM === "ghostty")
		attempts.push({
			command: "open",
			args: ["-na", "Ghostty", "--args", "-e", script],
			where: "a new Ghostty window",
		});
	attempts.push({
		command: "open",
		args: ["-a", "Terminal", script],
		where: "a new Terminal window",
	});
	return attempts;
}

export function launchAttachTerminal(
	script: string,
	env: NodeJS.ProcessEnv = process.env,
	run: AttachRunner = defaultRunner,
	label = "sandbox",
	sshArgs?: readonly string[],
	platform: NodeJS.Platform = process.platform,
): LaunchResult {
	if (herdrAvailable(env)) {
		const command = sshArgs?.length ? ["ssh", ...sshArgs] : [script];
		const herdr = launchInHerdr(command, env, run, label);
		if (herdr.ok) return herdr;
	}
	for (const attempt of attachLaunchPlan(script, env, platform, label)) {
		const result = run(attempt.command, attempt.args);
		if (result.status === 0) return { ok: true, where: attempt.where };
	}
	return { ok: false, where: "another terminal" };
}

function hint(theme: Theme, keys: string[], description: string): string {
	const label = keys.length ? keys.join("/") : description;
	return `${theme.fg("dim", label)} ${theme.fg("muted", description)}`;
}

export function attachNoticeDialog(
	title: string,
	lines: string[],
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (value: null) => void,
) {
	const container = new Container();
	const heading = new Text("", 1, 0);
	const body = new Text("", 1, 0);
	const footer = new Text("", 1, 0);
	const paint = () => {
		heading.setText(theme.fg("accent", theme.bold(title)));
		body.setText(theme.fg("text", lines.join("\n")));
		footer.setText(
			[
				hint(theme, keybindings.getKeys("tui.select.confirm"), "dismiss"),
				hint(theme, keybindings.getKeys("tui.select.cancel"), "dismiss"),
			].join("  "),
		);
	};
	container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	container.addChild(new Spacer(1));
	container.addChild(heading);
	container.addChild(new Spacer(1));
	container.addChild(body);
	container.addChild(new Spacer(1));
	container.addChild(footer);
	container.addChild(new Spacer(1));
	container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	paint();
	return {
		render(width: number): string[] {
			const frame = Math.max(1, width);
			return container
				.render(frame)
				.flatMap((line) =>
					visibleWidth(line) <= frame ? [line] : wrapTextWithAnsi(line, frame),
				)
				.map((line) => truncateToWidth(line, frame, ""));
		},
		invalidate(): void {
			paint();
			container.invalidate();
		},
		handleInput(data: string): boolean {
			if (
				matchesKey(data, Key.enter) ||
				matchesKey(data, Key.escape) ||
				matchesKey(data, Key.ctrl("c"))
			) {
				done(null);
			}
			return true;
		},
	};
}

export async function attachInExternalTerminal(
	ctx: ExtensionContext,
	vmName: string,
	sessionId: number,
	herdr: HerdrBridge | undefined,
): Promise<void> {
	const args = attachSshArgs(vmName, sessionId, herdr);
	const command = formatAttachCommand(args);
	const script = writeAttachScript(args);
	const launched = launchAttachTerminal(
		script,
		process.env,
		defaultRunner,
		`sandbox-${sessionId}`,
		args,
	);
	if (launched.ok && launched.focused) {
		ctx.ui.notify(`Opened the sandbox attach in ${launched.where}.`, "info");
		return;
	}
	const lines = launched.ok
		? [
				"This Atomic session cannot give SSH the terminal — the isolated engine keeps the TUI in another process.",
				`Opened the attach in ${launched.where}.`,
				"Detach there with /sandbox detach, or close that window.",
			]
		: [
				"This Atomic session cannot give SSH the terminal — the isolated engine keeps the TUI in another process.",
				"Open another terminal and run:",
				command,
			];
	if (ctx.mode === "tui") {
		const options: {
			overlay: boolean;
			handlesCtrlC: boolean;
			overlayOptions: OverlayOptions;
			reserveTranscriptRows: boolean;
		} = {
			overlay: true,
			handlesCtrlC: true,
			reserveTranscriptRows: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "100%",
				minWidth: 40,
				maxHeight: "70%",
			},
		};
		await ctx.ui.custom<null>(
			(_tui, theme, keybindings, done) =>
				attachNoticeDialog(
					launched.ok
						? "Attach opened elsewhere"
						: "Run attach in another terminal",
					lines,
					theme,
					keybindings,
					done,
				),
			options,
		);
		return;
	}
	ctx.ui.notify(
		launched.ok
			? `Opened the sandbox attach in ${launched.where}.`
			: `Run this in another terminal:\n${command}`,
		launched.ok ? "info" : "warning",
	);
}

export async function attachInForeground(
	ctx: ExtensionContext,
	vmName: string,
	sessionId: number,
	herdr: HerdrBridge | undefined,
): Promise<void> {
	const args = attachSshArgs(vmName, sessionId, herdr);
	try {
		await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
			let status: number | null = 1;
			tui.stop();
			try {
				process.stdout.write("\x1b[2J\x1b[H");
				const result = spawnSync("ssh", args, {
					stdio: "inherit",
					env: process.env,
				});
				status = result.status;
			} catch (error) {
				process.stderr.write(`${(error as Error).message}\n`);
			} finally {
				herdr?.stop();
				tui.start();
				tui.requestRender(true);
				done(status);
			}
			return { render: () => [], invalidate: () => {} };
		});
	} finally {
		herdr?.stop();
	}
}

export async function attachToSession(
	ctx: ExtensionContext,
	vmName: string,
	sessionId: number,
	herdr: HerdrBridge | undefined,
): Promise<void> {
	if (isolatedEngineAttach()) {
		await attachInExternalTerminal(ctx, vmName, sessionId, herdr);
		return;
	}
	await attachInForeground(ctx, vmName, sessionId, herdr);
}
