import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sameSandboxCheckout } from "../src/index.js";
import { parsePromptArgs, resolvePromptTarget } from "../src/prompt.js";
import { nodeBranch, slugBranch } from "../src/tool.js";

describe("sandbox node branch names", () => {
	test("slug is hostname-safe", () => {
		expect(slugBranch("Auth / OAuth2")).toBe("auth-oauth2");
		expect(slugBranch("!!!")).toBe("node");
	});
	test("default branch is under atomic-node/", () => {
		expect(nodeBranch("frontend")).toBe("atomic-node/frontend");
		expect(nodeBranch()).toBe("atomic-node/workflow");
	});
});

describe("the sandbox tool is available on host and on a node", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	test("both the host path and the remote path register the tool", () => {
		expect(source.match(/atomic.registerTool\(sandboxTool\)/g)?.length).toBe(2);
		expect(source).toContain("checkoutIsThisSandbox(remote, ctx.cwd)");
		expect(source).toContain("localHandler(args, ctx)");
	});
});

describe("/sandbox prompt parsing", () => {
	test("keeps an explicit id and the rest of the line", () => {
		expect(parsePromptArgs("prompt 2 implement auth")).toEqual({
			id: 2,
			text: "implement auth",
		});
		expect(parsePromptArgs("prompt 3 /workflow goal implement the API")).toEqual({
			id: 3,
			text: "/workflow goal implement the API",
		});
	});
	test("allows omitting the id", () => {
		expect(parsePromptArgs("prompt continue the stack")).toEqual({
			text: "continue the stack",
		});
	});
	test("rejects a bare session number with no text", () => {
		expect(parsePromptArgs("prompt 2")).toBeUndefined();
		expect(parsePromptArgs("prompt")).toBeUndefined();
		expect(parsePromptArgs("list")).toBeUndefined();
	});
});

describe("prompt targets the only session", () => {
	test("uses the only session when no id is given", () => {
		expect(resolvePromptTarget(undefined, [{ id: 4 }])).toBe(4);
	});
	test("uses an explicit id when it exists", () => {
		expect(resolvePromptTarget(2, [{ id: 1 }, { id: 2 }])).toBe(2);
	});
	test("refuses to guess when there are several sessions", () => {
		expect(() => resolvePromptTarget(undefined, [{ id: 1 }, { id: 2 }])).toThrow(
			"2 sessions",
		);
	});
	test("rejects an unknown id", () => {
		expect(() => resolvePromptTarget(9, [{ id: 1 }])).toThrow("#9");
	});
});

describe("a node checkout is not this VM's sandbox", () => {
	const remote = { owner: "bastani-inc", repo: "atomic", branch: "main" };
	test("the published checkout is this sandbox", () => {
		expect(
			sameSandboxCheckout(remote, {
				owner: "BASTANI-INC",
				repo: "atomic",
				branch: "main",
			}),
		).toBe(true);
	});
	test("a node worktree on another branch is a child sandbox", () => {
		expect(
			sameSandboxCheckout(remote, {
				owner: "bastani-inc",
				repo: "atomic",
				branch: "atomic-node/auth",
			}),
		).toBe(false);
	});
});
const TOOL_SOURCE = readFileSync(new URL("../src/tool.ts", import.meta.url), "utf8");
const TOOL_ACTIONS = [
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
];
function toolCase(action: string): string {
	const start = TOOL_SOURCE.indexOf(`case "${action}"`);
	const end = TOOL_SOURCE.indexOf("\n\t\t\tcase ", start + 1);
	return TOOL_SOURCE.slice(start, end === -1 ? TOOL_SOURCE.length : end);
}

describe("sandbox tool lifecycle parity", () => {
	test("exposes exactly the non-TUI action set", () => {
		const enumSource = TOOL_SOURCE.match(
			/action: StringEnum\(\s*\[([\s\S]*?)\],\s*\{/,
		)?.[1];
		const actions = enumSource?.match(/"([^"]+)"/g)?.map((value) => value.slice(1, -1));
		expect(actions).toEqual(TOOL_ACTIONS);
		for (const forbidden of ["connect", "attach", "transfer", "detach", "switch"])
			expect(actions).not.toContain(forbidden);
	});

	test("session actions use the ensuring helper and never dirty-worktree prompts", () => {
		expect(TOOL_SOURCE).toContain("export async function readySandbox");
		expect(TOOL_SOURCE).toContain(
		"ensureSandbox(ctx.cwd, ctx, { approveTransfer: true })",
	);
		for (const action of ["spawn", "new", "prompt", "read", "collect"])
			expect(toolCase(action)).toContain("readySandbox(ctx)");
		expect(TOOL_SOURCE).not.toContain("allowDirtyWorktree");
	});

	test("existing-sandbox actions do not ensure or create a VM", () => {
		for (const action of ["list", "status", "clean", "destroy", "doctor"]) {
			const source = toolCase(action);
			expect(source).not.toContain("readySandbox(");
			expect(source).not.toContain("ensureSandbox(");
			expect(source).not.toContain("createSandbox(");
		}
		expect(toolCase("list")).toContain("exactSandbox(ctx.cwd)");
		expect(toolCase("status")).toContain("exactSandbox(ctx.cwd)");
		expect(toolCase("clean")).toContain("cleanCurrent(ctx.cwd)");
		expect(toolCase("destroy")).toContain("destroyCurrent(ctx.cwd, params.force === true)");
	});

	test("create and ensure approve the tool transfer automatically", () => {
		expect(toolCase("create")).toContain(
			"createSandbox(ctx.cwd, ctx, { approveTransfer: true })",
		);
		expect(toolCase("ensure")).toContain(
			"ensureSandbox(ctx.cwd, ctx, { approveTransfer: true })",
		);
	});

	test("new uses the published checkout while spawn passes a branch", () => {
		expect(toolCase("new")).toContain("createRemoteSession(vm);");
		expect(toolCase("spawn")).toContain("createRemoteSession(vm, branch)");
	});

	test("doctor returns checks and formatted report", () => {
		const source = toolCase("doctor");
		expect(source).toContain("runDoctor(ctx.cwd)");
		expect(source).toContain("formatChecks(checks)");
	});
});
