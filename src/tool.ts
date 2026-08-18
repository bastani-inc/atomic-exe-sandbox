import { defineTool, StringEnum } from "@bastani/atomic";
import { Type } from "typebox";
import { resolvePromptTarget } from "./prompt.js";
import { exactSandbox } from "./sandbox.js";
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

export const sandboxTool = defineTool({
	name: "sandbox",
	label: "Sandbox",
	description:
		"Allocate a remote Atomic session (a node) on this checkout's exe.dev sandbox so a workflow can run tools without sharing this session's queue. Inside a node that is already on its own branch, this talks to that branch's child sandbox. Use spawn, then prompt, then collect. Do not use this to attach a TUI.",
	parameters: Type.Object({
		action: StringEnum(["spawn", "list", "status", "prompt", "read", "collect"], {
			description:
				"spawn: start a new Atomic session on a worktree. list: all nodes. status: one node. prompt: send text into that session (a workflow command or task). read: recent pane output. collect: git status/diff/log from that node's worktree.",
		}),
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
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const found = exactSandbox(ctx.cwd);
		const vm = found.vm.vm_name;
		installSessionctl(vm);
		switch (params.action) {
			case "spawn": {
				const branch = params.branch?.trim() || nodeBranch(params.label);
				const session = createRemoteSession(vm, branch);
				return jsonResult({
					id: session.id,
					branch: session.branch ?? branch,
					worktreePath: session.worktreePath,
					hint: `Node #${session.id} is a separate Atomic session. Send work with action=prompt. Combine later with action=collect and gh stack.`,
				});
			}
			case "list":
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
			case "status": {
				if (!params.id) throw new Error("status requires id");
				const session = ensureRemoteSession(vm, params.id);
				return jsonResult({
					id: session.id,
					branch: session.branch,
					worktreePath: session.worktreePath,
				});
			}
			case "prompt": {
				if (!params.text?.trim()) throw new Error("prompt requires text");
				const target = resolvePromptTarget(params.id, listRemoteSessions(vm));
				ensureRemoteSession(vm, target);
				promptRemoteSession(vm, target, params.text);
				return jsonResult({ id: target, sent: true });
			}
			case "read": {
				if (!params.id) throw new Error("read requires id");
				ensureRemoteSession(vm, params.id);
				return jsonResult({
					id: params.id,
					output: readRemoteSession(vm, params.id, params.lines ?? 80),
				});
			}
			case "collect": {
				if (!params.id) throw new Error("collect requires id");
				ensureRemoteSession(vm, params.id);
				return jsonResult({ id: params.id, ...collectRemoteSession(vm, params.id) });
			}
			default:
				throw new Error(`unknown sandbox action: ${String(params.action)}`);
		}
	},
});
