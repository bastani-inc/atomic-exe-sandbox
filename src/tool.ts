import { defineTool, StringEnum } from "@bastani/atomic";
import type { ExtensionContext } from "@bastani/atomic";
import { Type } from "typebox";
import { formatChecks, runDoctor } from "./doctor.js";
import { resolvePromptTarget } from "./prompt.js";
import {
	cleanCurrent,
	createSandbox,
	destroyCurrent,
	ensureSandbox,
	exactSandbox,
} from "./sandbox.js";
import {
	collectRemoteSession,
	createRemoteSession,
	ensureRemoteSession,
	installSessionctl,
	listRemoteSessions,
	promptRemoteSession,
	readRemoteSession,
} from "./sessions.js";

export function slugBranch(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "node";
}

export function nodeBranch(label?: string): string {
	return `atomic-node/${slugBranch(label ?? "workflow")}`;
}

function jsonResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

export async function readySandbox(ctx: ExtensionContext) {
	const found = await ensureSandbox(ctx.cwd, ctx, { approveTransfer: true });
	const vm = found.vm.vm_name;
	installSessionctl(vm);
	return { found, vm };
}

export const sandboxTool = defineTool({
	name: "sandbox",
	label: "Sandbox",
	description:
		"Manage this checkout's non-TUI exe.dev sandbox lifecycle and remote Atomic sessions. Use spawn, then prompt, then collect for node work. Do not use this to attach a TUI.",
	parameters: Type.Object({
		action: StringEnum(
			[
				"create",
				"ensure",
				"spawn",
				"new",
				"list",
				"status",
				"prompt",
				"read",
				"collect",
				"clean",
				"destroy",
				"doctor",
			],
			{
				description:
					"create/ensure: provision or find this checkout's sandbox. spawn: start a node on a worktree. new: start a session on the published checkout. list/status: inspect sessions. prompt/read/collect: work with a session. clean/destroy: maintain the existing sandbox. doctor: check prerequisites.",
			},
		),
		id: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"Session number. Optional for prompt when the sandbox has exactly one session.",
			}),
		),
		branch: Type.Optional(
			Type.String({
				description:
					"Git branch for spawn. Created as a worktree off the published branch if it does not exist. Defaults to atomic-node/<label>.",
			}),
		),
		label: Type.Optional(
			Type.String({
				description: "Short name used to derive the default branch for spawn, e.g. auth or frontend.",
			}),
		),
		text: Type.Optional(
			Type.String({
				description: "Prompt text for action=prompt. Sent into that Atomic session as if typed.",
			}),
		),
		lines: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 400,
				description: "How many recent pane lines to return for action=read. Default 80.",
			}),
		),
		force: Type.Optional(
			Type.Boolean({
				description: "For action=destroy, skip remote work and attach safety checks.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		switch (params.action) {
			case "create": {
				const found = await createSandbox(ctx.cwd, ctx, { approveTransfer: true });
				return jsonResult({
					vm: found.vm.vm_name,
					health: found.health,
					hint: "Sandbox is ready for Atomic sessions.",
				});
			}
			case "ensure": {
				const found = await ensureSandbox(ctx.cwd, ctx, { approveTransfer: true });
				return jsonResult({
					vm: found.vm.vm_name,
					health: found.health,
					hint: "Sandbox is ready for Atomic sessions.",
				});
			}
			case "spawn": {
				const { vm } = await readySandbox(ctx);
				const branch = params.branch?.trim() || nodeBranch(params.label);
				const session = createRemoteSession(vm, branch);
				return jsonResult({
					id: session.id,
					branch: session.branch ?? branch,
					worktreePath: session.worktreePath,
					hint: `Node #${session.id} is a separate Atomic session. Send work with action=prompt. Combine later with action=collect and gh stack.`,
				});
			}
			case "new": {
				const { vm } = await readySandbox(ctx);
				const session = createRemoteSession(vm);
				return jsonResult({
					id: session.id,
					branch: session.branch,
					worktreePath: session.worktreePath,
					hint: `Session #${session.id} is on the published checkout. Send work with action=prompt.`,
				});
			}
			case "list": {
				const found = exactSandbox(ctx.cwd);
				const vm = found.vm.vm_name;
				installSessionctl(vm);
				return jsonResult(
					listRemoteSessions(vm).map((session) => ({
						id: session.id,
						running: session.running,
						attached: session.attached,
						branch: session.branch,
						worktreePath: session.worktreePath,
						transferred: session.transferred,
					})),
				);
			}
			case "status": {
				if (!params.id) throw new Error("status requires id");
				const found = exactSandbox(ctx.cwd);
				const vm = found.vm.vm_name;
				installSessionctl(vm);
				const session = ensureRemoteSession(vm, params.id);
				return jsonResult({
					id: session.id,
					branch: session.branch,
					worktreePath: session.worktreePath,
				});
			}
			case "prompt": {
				if (!params.text?.trim()) throw new Error("prompt requires text");
				const { vm } = await readySandbox(ctx);
				const target = resolvePromptTarget(params.id, listRemoteSessions(vm));
				ensureRemoteSession(vm, target);
				promptRemoteSession(vm, target, params.text);
				return jsonResult({ id: target, sent: true });
			}
			case "read": {
				if (!params.id) throw new Error("read requires id");
				const { vm } = await readySandbox(ctx);
				ensureRemoteSession(vm, params.id);
				return jsonResult({
					id: params.id,
					output: readRemoteSession(vm, params.id, params.lines ?? 80),
				});
			}
			case "collect": {
				if (!params.id) throw new Error("collect requires id");
				const { vm } = await readySandbox(ctx);
				ensureRemoteSession(vm, params.id);
				return jsonResult({ id: params.id, ...collectRemoteSession(vm, params.id) });
			}
			case "clean": {
				const found = cleanCurrent(ctx.cwd);
				return jsonResult(found.vm.vm_name);
			}
			case "destroy":
				return jsonResult(destroyCurrent(ctx.cwd, params.force === true));
			case "doctor": {
				const checks = runDoctor(ctx.cwd);
				return jsonResult({ checks, report: formatChecks(checks) });
			}
			default:
				throw new Error(`unknown sandbox action: ${String(params.action)}`);
		}
	},
});
