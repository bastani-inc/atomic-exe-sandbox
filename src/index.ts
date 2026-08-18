import type { ExtensionAPI, ExtensionCommandContext } from "@bastani/atomic";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	cleanCurrent,
	connect,
	connectCurrent,
	createSandbox,
	destroyCurrent,
	ensureSandbox,
	exactSandbox,
} from "./sandbox.js";
import { formatChecks, runDoctor } from "./doctor.js";
import {
	ensureRemoteSession,
	formatSessions,
	listRemoteSessions,
	reserveTransferredSession,
	rollbackTransferredSession,
	uploadTransferredSession,
} from "./sessions.js";
import {
	clearProgress,
	PASS,
	type Paint,
	paintFor,
	repaintAfterCommand,
	RUNNING,
	showProgress,
	STOPPED,
} from "./ui.js";
import { allowDirtyWorktree } from "./worktree.js";

const MANIFEST_PATH = join(homedir(), ".atomic-exe", "manifest.json");
const EXE_GITHUB_HOST = "github.int.exe.xyz";
interface RemoteIdentity {
	vmName: string;
	owner: string;
	repo: string;
	branch: string;
	creationCommit: string;
	state: string;
}

/** One transcript line: plain text plus the colour applied after it is sized. */
export interface NoticeLine {
	text: string;
	color: (text: string) => string;
}

/**
 * Minimal transcript component. Atomic exposes the renderer contract but no box
 * primitives, so the entry is rendered as padded, themed lines. Sizing happens on the
 * plain text: ANSI colour is applied only after truncating and padding, because escape
 * sequences carry no visible width and slicing coloured text would drop the reset.
 */
export function noticeComponent(
	lines: NoticeLine[],
	decorate: (text: string) => string,
) {
	return {
		render(width: number): string[] {
			const frame = Math.max(0, width);
			const inner = Math.max(0, frame - 2);
			const blank = decorate(" ".repeat(frame));
			if (inner === 0) return [blank, blank];
			return [
				blank,
				...lines.map(({ text, color }) =>
					decorate(` ${color(text.slice(0, inner).padEnd(inner))} `),
				),
				blank,
			];
		},
		invalidate(): void {},
	};
}

async function showOperation(
	ctx: ExtensionCommandContext,
	message: string,
	operation: () => void,
): Promise<void> {
	await showProgress(ctx, message);
	try {
		operation();
	} finally {
		clearProgress(ctx);
	}
}

/** A finished action, in green, with the same glyph the doctor uses for a passing check. */
function done(ctx: ExtensionCommandContext, paint: Paint, message: string): void {
	ctx.ui.notify(paint.ok(`${PASS} ${message}`), "info");
}

function usage(paint: Paint, commands: string): string {
	return `${paint.dim("Usage:")} ${paint.accent(`/sandbox ${commands}`)}`;
}

function remoteIdentity(): RemoteIdentity | undefined {
	if (!existsSync("/exe.dev") || !existsSync(MANIFEST_PATH)) return undefined;
	try {
		const value = JSON.parse(
			readFileSync(MANIFEST_PATH, "utf8"),
		) as Partial<RemoteIdentity>;
		if (
			!value.vmName ||
			!value.owner ||
			!value.repo ||
			!value.branch ||
			!value.creationCommit ||
			!value.state
		)
			return undefined;
		return value as RemoteIdentity;
	} catch {
		return undefined;
	}
}
function currentRemoteId(): number {
	return Number(process.env.ATOMIC_EXE_SESSION_ID || "1") || 1;
}
/**
 * Liveness marker for the on-VM session registry. A restarted herdr server restores a
 * pane holding only a fresh shell, so the marker records this process id together with
 * its /proc start time (field 22 of /proc/self/stat, the first field after the comm
 * parentheses is field 3). sessionctl treats a session as running only while both still
 * match, which also rules out pid reuse.
 */
function readyMarker(): string {
	const stat = readFileSync("/proc/self/stat", "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const startTime = fields[19];
	if (!startTime || !/^\d+$/.test(startTime))
		throw new Error("could not read this process start time from /proc/self/stat");
	return `${process.pid} ${startTime}\n`;
}
function remoteStatus(): string {
	return `☁ sandbox #${currentRemoteId()}`;
}
function parseId(value: string): number | undefined {
	return /^\d+$/.test(value) ? Number(value) : undefined;
}

async function localHandler(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const words = args.trim().split(/\s+/).filter(Boolean),
		command = words[0] ?? "",
		force = words.includes("--force"),
		id = parseId(command),
		paint = paintFor(ctx);
	try {
		if (!command || id !== undefined) {
			if (!(await allowDirtyWorktree(ctx))) return;
			await connectCurrent(ctx.cwd, ctx, id);
			return;
		}
		if (command === "list") {
			const found = exactSandbox(ctx.cwd);
			ctx.ui.notify(
				formatSessions(listRemoteSessions(found.vm.vm_name), paint),
				"info",
			);
			return;
		}
		if (command === "create") {
			if (!(await allowDirtyWorktree(ctx))) return;
			const sandbox = await createSandbox(ctx.cwd, ctx);
			await connect(sandbox, ctx);
			return;
		}
		if (command === "transfer") {
			if (!(await allowDirtyWorktree(ctx))) return;
			await transferCurrentSession(ctx);
			return;
		}
		if (command === "clean") {
			let sandbox;
			await showOperation(ctx, "Cleaning caches…", () => {
				sandbox = cleanCurrent(ctx.cwd);
			});
			done(ctx, paint, `Cleaned ${sandbox!.vm.vm_name}`);
			return;
		}
		if (command === "destroy") {
			if (ctx.hasUI && !force) {
				const ok = await ctx.ui.confirm(
					"Destroy remote sandbox?",
					"The VM will be deleted only if its repository has no uncommitted, untracked, or unpushed work.",
				);
				if (!ok) return;
			}
			// --force skips the confirmation and the work checks with it. Say so in amber
			// rather than deleting a VM as quietly as any other subcommand.
			if (force)
				ctx.ui.notify(
					"Destroying without the uncommitted, untracked, or unpushed work checks.",
					"warning",
				);
			let name = "";
			await showOperation(
				ctx,
				"Checking remote work and destroying VM…",
				() => {
					name = destroyCurrent(ctx.cwd, force);
				},
			);
			done(ctx, paint, `Destroyed ${name}`);
			return;
		}
		if (command === "doctor") {
			let report = "";
			await showOperation(ctx, "Checking sandbox prerequisites…", () => {
				report = formatChecks(runDoctor(ctx.cwd), paint);
			});
			ctx.ui.notify(report, "info");
			return;
		}
		ctx.ui.notify(
			usage(paint, "[<id>|list|transfer|create|clean|destroy [--force]|doctor]"),
			"info",
		);
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
	} finally {
		repaintAfterCommand(ctx);
	}
}

async function transferCurrentSession(
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ctx.isIdle() || ctx.hasPendingMessages())
		throw new Error(
			"Wait until Atomic is idle before transferring this session.",
		);
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile)
		throw new Error("The current Atomic session is not persisted yet.");
	const source = readFileSync(sessionFile),
		sessionId = ctx.sessionManager.getSessionId();
	const sandbox = await ensureSandbox(ctx.cwd, ctx, { startDefault: false });
	if (!sandbox.manifest) throw new Error("validated sandbox manifest required");
	const remote = reserveTransferredSession(sandbox.vm.vm_name, sessionId);
	try {
		await uploadTransferredSession(
			sandbox.vm.vm_name,
			remote,
			source,
			sandbox.manifest.checkoutPath,
		);
		ensureRemoteSession(sandbox.vm.vm_name, remote.id);
	} catch (error) {
		try {
			rollbackTransferredSession(sandbox.vm.vm_name, remote.id);
		} catch {}
		throw error;
	}
	atomicApi?.appendEntry("atomic-exe-transfer", {
		session: remote.id,
		vm: sandbox.vm.vm_name,
		timestamp: Date.now(),
	});
	done(
		ctx,
		paintFor(ctx),
		`Session transferred to sandbox #${remote.id}. Connecting now…`,
	);
	await connect(sandbox, ctx, remote.id);
	ctx.shutdown();
}

let atomicApi: ExtensionAPI | undefined;

async function remoteHandler(
	atomic: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	remote: RemoteIdentity,
): Promise<void> {
	const command = args.trim(),
		id = parseId(command),
		paint = paintFor(ctx),
		ctl = join(homedir(), ".atomic-exe", "sessionctl");
	try {
		if (id !== undefined) {
			const ensured = await atomic.exec(ctl, ["ensure", String(id)]);
			if (ensured.code !== 0) throw new Error(ensured.stderr || ensured.stdout);
			const selected = await atomic.exec(ctl, ["focus", String(id)]);
			if (selected.code !== 0)
				throw new Error(selected.stderr || selected.stdout);
			return;
		}
		if (command === "new") {
			const result = await atomic.exec(ctl, ["new"]);
			if (result.code !== 0) throw new Error(result.stderr || result.stdout);
			const session = JSON.parse(result.stdout) as { id: number };
			const selected = await atomic.exec(ctl, ["focus", String(session.id)]);
			if (selected.code !== 0)
				throw new Error(selected.stderr || selected.stdout);
			return;
		}
		if (command === "switch" || command === "list") {
			const result = await atomic.exec(ctl, ["list"]);
			if (result.code !== 0) throw new Error(result.stderr || result.stdout);
			const sessions = JSON.parse(result.stdout) as Array<{
				id: number;
				running: boolean;
				attached: boolean;
				transferred?: boolean;
			}>;
			if (command === "list") {
				ctx.ui.notify(
					formatSessions(
						sessions.map((session) => ({
							...session,
							sessionId: "",
							createdAt: "",
						})),
						paint,
					),
					"info",
				);
				return;
			}
			// The picker renders plain rows, so state is carried by the glyph alone here.
			const choice = await ctx.ui.select(
				"Switch sandbox session",
				sessions.map(
					(session) =>
						`${session.running ? RUNNING : STOPPED} #${session.id}  ${session.running ? "running" : "stopped"}`,
				),
			);
			if (!choice) return;
			const selected = Number(choice.match(/#(\d+)/)?.[1]);
			if (selected) await remoteHandler(atomic, String(selected), ctx, remote);
			return;
		}
		if (command === "status" || !command) {
			ctx.ui.notify(
				[
					paint.accent(remoteStatus()),
					`${remote.owner}/${remote.repo}:${remote.branch}`,
					paint.dim(`VM: ${remote.vmName}`),
				].join("\n"),
				"info",
			);
			return;
		}
		if (command === "detach") {
			ctx.ui.notify(paint.dim("Detaching from sandbox…"), "info");
			const result = await atomic.exec(ctl, ["detach"]);
			if (result.code !== 0) throw new Error(result.stderr || result.stdout);
			return;
		}
		ctx.ui.notify(usage(paint, "[<id>|new|switch|list|status|detach]"), "info");
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
	} finally {
		repaintAfterCommand(ctx);
	}
}

export default function (atomic: ExtensionAPI) {
	atomicApi = atomic;
	atomic.registerEntryRenderer<{
		session: number;
		vm: string;
		timestamp: number;
	}>("atomic-exe-transfer", (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		return noticeComponent(
			[
				{
					text: `Session continued in exe.dev sandbox #${data.session}`,
					color: (text) => theme.fg("accent", text),
				},
				{
					text: "Run atomic --sandbox to continue where you left off.",
					color: (text) => theme.fg("dim", text),
				},
			],
			(text) => theme.bg("customMessageBg", text),
		);
	});
	const remote = remoteIdentity();
	if (remote) {
		// exe.dev's GitHub integration authenticates gh at the network edge. The
		// credential never enters the VM; child shells and subagents inherit this.
		process.env.GH_HOST = EXE_GITHUB_HOST;
		atomic.on("session_start", (_event, ctx) => {
			ctx.ui.setStatus("atomic-exe-sandbox", remoteStatus());
			writeFileSync(
				join(homedir(), ".atomic-exe", `ready-${currentRemoteId()}`),
				readyMarker(),
				{ mode: 0o600 },
			);
		});
		atomic.on("session_shutdown", (_event, ctx) =>
			ctx.ui.setStatus("atomic-exe-sandbox", undefined),
		);
		atomic.registerCommand("sandbox", {
			description: "Manage Atomic sessions in this exe.dev sandbox",
			handler: (args, ctx) => remoteHandler(atomic, args, ctx, remote),
			getArgumentCompletions: (prefix) =>
				["new", "switch", "list", "status", "detach"]
					.filter((value) => value.startsWith(prefix))
					.map((value) => ({ value, label: value })),
		});
		return;
	}
	atomic.registerFlag("sandbox", {
		type: "boolean",
		default: false,
		description:
			"Create or connect to this published branch's exe.dev Atomic sandbox",
	});
	atomic.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" || atomic.getFlag("sandbox") !== true) return;
		try {
			if (!(await allowDirtyWorktree(ctx))) {
				ctx.ui.notify(
					"Sandbox auto-connect skipped: local work will not be in the VM.",
					"warning",
				);
				return;
			}
			await connectCurrent(ctx.cwd, ctx);
		} catch (error) {
			ctx.ui.notify(
				`Sandbox auto-connect failed: ${(error as Error).message}`,
				"error",
			);
		}
	});
	atomic.registerCommand("sandbox", {
		description: "Create or enter this branch's exe.dev sandbox",
		handler: localHandler,
		getArgumentCompletions: (prefix) =>
			["list", "transfer", "create", "clean", "destroy", "destroy --force", "doctor"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
	});
}
