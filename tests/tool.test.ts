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
