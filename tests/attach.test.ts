import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	attachLaunchPlan,
	attachNoticeDialog,
	attachSshArgs,
	cmdEscape,
	formatAttachCommand,
	isolatedEngineAttach,
	launchAttachTerminal,
	launchInHerdr,
	paneIdFromTabCreate,
	shEscape,
	writeAttachScript,
} from "../src/attach.js";
import { rememberSshDest, SSH_BASE, VM_HOST_KEY_ARGS } from "../src/exe.js";

describe("isolated engine attach detection", () => {
	test("a pipe is isolated", () =>
		expect(isolatedEngineAttach({ isTTY: false })).toBe(true));
	test("a missing TTY flag is isolated", () =>
		expect(isolatedEngineAttach({})).toBe(true));
	test("a real TTY can still steal the terminal", () =>
		expect(isolatedEngineAttach({ isTTY: true })).toBe(false));
});

describe("attach SSH arguments", () => {
	test("pins the host key and uses the shared timeouts", () => {
		const args = attachSshArgs("vm-plain", 3);
		expect(args.slice(0, SSH_BASE.length)).toEqual([...SSH_BASE]);
		expect(args).toEqual(expect.arrayContaining([...VM_HOST_KEY_ARGS]));
		expect(args).toContain("-tt");
		expect(args.at(-1)).toBe(
			"~/.atomic-exe/sessionctl report-herdr '3'; exec ~/.atomic-exe/sessionctl attach '3'",
		);
	});
	test("uses the ssh_dest exe.dev returned, not a rebuilt hostname", () => {
		rememberSshDest({
			vm_name: "vm-shard",
			ssh_dest: "vm-shard.shard7.exe.xyz",
		});
		expect(attachSshArgs("vm-shard", 1)).toContain("vm-shard.shard7.exe.xyz");
		expect(attachSshArgs("vm-shard", 1)).not.toContain("vm-shard.exe.xyz");
	});
	test("forwards a local herdr socket when one is bridged", () => {
		const args = attachSshArgs("vm-plain", 2, {
			localSocket: "/tmp/local.sock",
			remoteSocket: "/home/exedev/.atomic-exe/herdr-2.sock",
		});
		expect(args).toContain("ExitOnForwardFailure=yes");
		expect(args).toContain(
			"/home/exedev/.atomic-exe/herdr-2.sock:/tmp/local.sock",
		);
	});
});

describe("attach scripts and launch plans", () => {
	test("quotes metacharacters so they stay data", () => {
		expect(shEscape("it's")).toBe(`'it'"'"'s'`);
		expect(cmdEscape("a b")).toBe('"a b"');
		expect(cmdEscape('say "hi"')).toBe('"say ""hi"""');
		expect(formatAttachCommand(["-o", "BatchMode=yes", "host"])).toBe(
			"ssh '-o' 'BatchMode=yes' 'host'",
		);
		expect(formatAttachCommand(["-o", "BatchMode=yes", "host"], "win32")).toBe(
			"ssh -o BatchMode=yes host",
		);
	});
	test("writes an executable ssh wrapper", () => {
		let path = "";
		let body = "";
		path = writeAttachScript(
			["-tt", "vm.exe.xyz"],
			(written, contents) => {
				path = written;
				body = contents;
			},
			"test",
			"darwin",
			"/tmp",
		);
		expect(path).toBe("/tmp/atomic-exe-attach-test.sh");
		expect(body).toBe("#!/bin/sh\nexec ssh '-tt' 'vm.exe.xyz'\n");
	});
	test("writes a cmd wrapper on Windows", () => {
		let path = "";
		let body = "";
		path = writeAttachScript(
			["-tt", "vm.exe.xyz", "echo hi"],
			(written, contents) => {
				path = written;
				body = contents;
			},
			"test",
			"win32",
			"C:\\Temp",
		);
		expect(path).toBe(join("C:\\Temp", "atomic-exe-attach-test.cmd"));
		expect(body).toBe("@echo off\r\nssh -tt vm.exe.xyz \"echo hi\"\r\n");
	});
	test("prefers tmux, then the current terminal, then Terminal.app", () => {
		const plan = attachLaunchPlan(
			"/tmp/a.sh",
			{ TMUX: "1", TERM_PROGRAM: "iTerm.app" },
			"darwin",
		);
		expect(plan[0]).toMatchObject({ command: "tmux", where: "a new tmux window" });
		expect(plan.some((attempt) => attempt.command === "osascript")).toBe(true);
		expect(plan.at(-1)).toMatchObject({
			command: "open",
			args: ["-a", "Terminal", "/tmp/a.sh"],
		});
	});
	test("on Windows prefers Windows Terminal then start", () => {
		const plan = attachLaunchPlan("C:\\t\\a.cmd", {}, "win32", "sandbox-2");
		expect(plan[0]).toMatchObject({
			command: "wt.exe",
			args: ["new-tab", "--title", "sandbox-2", "--", "C:\\t\\a.cmd"],
			where: "a new Windows Terminal tab",
		});
		expect(plan.at(-1)).toMatchObject({
			command: "cmd.exe",
			where: "a new console window",
		});
		expect(plan.some((attempt) => attempt.command === "open")).toBe(false);
	});
	test("stops at the first successful launch", () => {
		const calls: string[] = [];
		const result = launchAttachTerminal(
			"/tmp/a.sh",
			{ TMUX: "1", TERM_PROGRAM: "Apple_Terminal" },
			(command) => {
				calls.push(command);
				return { status: command === "tmux" ? 0 : 1 };
			},
		);
		expect(result).toEqual({ ok: true, where: "a new tmux window" });
		expect(calls).toEqual(["tmux"]);
	});
	test("falls through when every launcher fails", () => {
		const result = launchAttachTerminal("/tmp/a.sh", {}, () => ({ status: 1 }));
		expect(result.ok).toBe(false);
	});
});

describe("herdr is the attach target when this Atomic is already in herdr", () => {
	const herdrEnv = {
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		HERDR_PANE_ID: "wW:p1X",
		HERDR_WORKSPACE_ID: "wW",
	};
	const created = JSON.stringify({
		result: {
			tab: { tab_id: "wW:t2", workspace_id: "wW" },
			root_pane: { pane_id: "wW:p2" },
		},
	});
	test("reads the pane id herdr assigned", () => {
		expect(paneIdFromTabCreate(created)).toBe("wW:p2");
		expect(paneIdFromTabCreate("not-json")).toBeUndefined();
		expect(paneIdFromTabCreate("{}")).toBeUndefined();
	});
	test("creates a focused tab and runs ssh there", () => {
		const calls: string[][] = [];
		const result = launchInHerdr(
			["ssh", "-tt", "vm.exe.xyz"],
			herdrEnv,
			(command, args) => {
				calls.push([command, ...args]);
				if (args[0] === "tab") return { status: 0, stdout: created };
				return { status: 0 };
			},
			"sandbox-3",
		);
		expect(result).toEqual({
			ok: true,
			where: "a new herdr tab",
			focused: true,
		});
		expect(calls).toEqual([
			["herdr", "tab", "create", "--workspace", "wW", "--label", "sandbox-3", "--focus"],
			["herdr", "pane", "run", "wW:p2", "ssh", "-tt", "vm.exe.xyz"],
		]);
	});
	test("launch prefers herdr over Terminal.app", () => {
		const commands: string[] = [];
		const result = launchAttachTerminal(
			"/tmp/a.sh",
			herdrEnv,
			(command, args) => {
				commands.push(command);
				if (args[0] === "tab") return { status: 0, stdout: created };
				return { status: 0 };
			},
		);
		expect(result.where).toBe("a new herdr tab");
		expect(result.focused).toBe(true);
		expect(commands).toEqual(["herdr", "herdr"]);
	});
});

describe("the isolated attach notice stays inside the viewport", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `*${text}*`,
	};
	const keybindings = {
		getKeys: (id: string) =>
			(
				{
					"tui.select.confirm": ["enter"],
					"tui.select.cancel": ["escape"],
				} as Record<string, string[]>
			)[id] ?? [],
	};
	const dialog = () =>
		attachNoticeDialog(
			"Attach opened elsewhere",
			[
				"This Atomic session cannot give SSH the terminal.",
				"Opened the attach in a new Terminal window.",
			],
			theme as never,
			keybindings as never,
			() => {},
		);

	test("every line stays inside the viewport, including a degenerate width", () => {
		const component = dialog();
		for (const width of [0, 1, 2, 40, 80]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(width, 1));
			}
		}
	});
	test("names the isolated-engine reason", () => {
		const frame = dialog().render(80).join(" ");
		expect(frame).toContain("<accent>*Attach opened elsewhere*</accent>");
		expect(frame).toContain("cannot give SSH the terminal");
		expect(frame).toContain("new Terminal window");
	});
});

describe("isolated attach never steals the engine child's stdout", () => {
	const source = readFileSync(new URL("../src/attach.ts", import.meta.url), "utf8");
	test("the isolated path is an overlay, not tui.stop", () => {
		expect(source).toContain("attachInExternalTerminal");
		expect(source).toContain("handlesCtrlC: true");
		expect(source).toContain("reserveTranscriptRows: true");
		const isolated = source.slice(
			source.indexOf("export async function attachInExternalTerminal"),
			source.indexOf("export async function attachInForeground"),
		);
		expect(isolated).not.toContain("tui.stop()");
		expect(isolated).not.toContain('stdio: "inherit"');
		expect(isolated).not.toContain("\\x1b[2J");
	});
});
