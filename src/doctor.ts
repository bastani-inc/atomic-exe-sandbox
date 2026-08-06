import { createHash } from "node:crypto";
import { accountFingerprint, discover, githubIntegration, listVms } from "./exe.js";
import { inspectGitIdentity, inspectPublishedGit } from "./git.js";
import { identityForGit } from "./identity.js";
import { runAllowFailure } from "./process.js";
import { claimMatches } from "./sandbox.js";
import { ADVISORY, FAIL, PASS, type Paint, PLAIN_PAINT } from "./ui.js";

/**
 * Published by exe.dev at https://exe.dev/docs/faq/host-key.md. Every VM connection is
 * validated against this key through HostKeyAlias, so a wrong or missing entry breaks
 * every sandbox operation with an error that does not mention host keys at all.
 */
export const EXE_HOST_KEY_FINGERPRINT =
	"SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo";

export interface Check {
	name: string;
	ok: boolean;
	/** Passed, but with something the user should know about. Rendered amber, not green. */
	warn?: boolean;
	detail: string;
	fix?: string;
}

function check(name: string, run: () => Omit<Check, "name">): Check {
	try {
		return { name, ...run() };
	} catch (error) {
		return { name, ok: false, detail: (error as Error).message.split("\n")[0] };
	}
}

/** OpenSSH's fingerprint format: base64 SHA-256 of the raw key blob, padding stripped. */
export function sshFingerprint(base64Key: string): string {
	const digest = createHash("sha256")
		.update(Buffer.from(base64Key, "base64"))
		.digest("base64")
		.replace(/=+$/, "");
	return `SHA256:${digest}`;
}

/** Reads the local known_hosts entry for exe.dev without shelling out to a temp file. */
export function knownHostFingerprints(
	knownHostsOutput: string,
): string[] {
	return knownHostsOutput
		.split("\n")
		.filter((line) => line.trim() && !line.trimStart().startsWith("#"))
		.map((line) => line.trim().split(/\s+/)[2])
		.filter((key): key is string => Boolean(key))
		.map(sshFingerprint);
}

export function runDoctor(cwd: string): Check[] {
	const checks: Check[] = [];

	checks.push(
		check("local tools", () => {
			const missing = ["ssh", "git", "tar"].filter(
				(tool) => runAllowFailure("command", ["-v", tool]).exitCode !== 0 &&
					runAllowFailure("which", [tool]).exitCode !== 0,
			);
			return missing.length
				? { ok: false, detail: `missing: ${missing.join(", ")}` }
				: { ok: true, detail: "ssh, git and tar are present" };
		}),
	);

	checks.push(
		check("exe.dev host key", () => {
			const found = runAllowFailure("ssh-keygen", ["-F", "exe.dev"]);
			if (found.exitCode !== 0 || !found.stdout.trim())
				return {
					ok: false,
					detail: "no known_hosts entry for exe.dev",
					fix: "run `ssh exe.dev` once and confirm the fingerprint matches the published one",
				};
			const fingerprints = knownHostFingerprints(found.stdout);
			return fingerprints.includes(EXE_HOST_KEY_FINGERPRINT)
				? { ok: true, detail: EXE_HOST_KEY_FINGERPRINT }
				: {
						ok: false,
						detail: `known_hosts has ${fingerprints.join(", ") || "no usable key"}, expected ${EXE_HOST_KEY_FINGERPRINT}`,
						fix: "remove the exe.dev entry with `ssh-keygen -R exe.dev` and reconnect, verifying the published fingerprint",
					};
		}),
	);

	checks.push(
		check("exe.dev authentication", () => {
			const result = runAllowFailure("ssh", [
				"-o",
				"BatchMode=yes",
				"-o",
				"ConnectTimeout=10",
				"exe.dev",
				"whoami",
			]);
			if (result.exitCode !== 0) {
				const denied = /permission denied/i.test(result.stderr);
				return {
					ok: false,
					detail: result.stderr.trim().split("\n")[0] || "connection failed",
					fix: denied
						? "register your public key at https://exe.dev/user, then pin it with an `Host exe.dev *.exe.xyz` block using IdentityFile and IdentitiesOnly"
						: "check network access to exe.dev",
				};
			}
			const email = result.stdout.match(/Email Address:\s*(\S+)/i)?.[1];
			return {
				ok: true,
				detail: `${email ?? "authenticated"} (account ${accountFingerprint()})`,
			};
		}),
	);

	checks.push(
		check("SSH key is non-interactive", () => {
			// Every call sets BatchMode, so a passphrase-protected key with no agent fails
			// with no prompt at all. Surface it here rather than as a mystery timeout.
			const agent = runAllowFailure("ssh-add", ["-l"]);
			const loaded = agent.exitCode === 0;
			return {
				ok: true,
				warn: !loaded,
				detail: loaded
					? "ssh-agent has keys loaded"
					: "no ssh-agent keys; this is fine only if the exe.dev key has no passphrase",
			};
		}),
	);

	checks.push(
		check("published branch", () => {
			const git = inspectPublishedGit(cwd);
			return {
				ok: true,
				detail: `${git.owner}/${git.repo}:${git.branch} at ${git.commit.slice(0, 8)} matches its upstream`,
			};
		}),
	);

	checks.push(
		check("GitHub integration", () => {
			const git = inspectGitIdentity(cwd);
			const integration = githubIntegration(git.owner, git.repo);
			return {
				ok: true,
				detail: integration.team
					? `${integration.name} (team, bound by tag ${integration.tags.join(", ")})`
					: `${integration.name} (personal)`,
			};
		}),
	);

	checks.push(
		check("existing sandbox", () => {
			const git = inspectGitIdentity(cwd);
			const identity = identityForGit(git);
			const matches = discover().filter((found) =>
				claimMatches(found, identity, git),
			);
			if (!matches.length)
				return {
					ok: true,
					detail: `none yet for this branch (${listVms().length} VMs on the account)`,
				};
			const found = matches[0];
			// A VM still being built is not a failure to fix, only a state to wait out.
			const building = found.health === "creating";
			return {
				ok: found.health === "ready" || building,
				warn: building,
				detail: `${found.vm.vm_name} is ${found.health}`,
			};
		}),
	);

	return checks;
}

export function formatChecks(checks: Check[], paint: Paint = PLAIN_PAINT): string {
	const lines = checks.map((check) => {
		const advisory = check.ok && check.warn === true;
		const glyph = check.ok ? (advisory ? ADVISORY : PASS) : FAIL;
		const tint = check.ok ? (advisory ? paint.warn : paint.ok) : paint.bad;
		const head = `${tint(`${glyph} ${check.name}`)}${paint.dim(`: ${check.detail}`)}`;
		return check.fix && !check.ok
			? `${head}\n    ${paint.warn(`fix: ${check.fix}`)}`
			: head;
	});
	const failed = checks.filter((check) => !check.ok).length;
	const advisories = checks.filter((check) => check.ok && check.warn).length;
	const summary = failed
		? paint.bad(`${failed} of ${checks.length} checks failed.`)
		: paint.ok(`All ${checks.length} checks passed.`);
	lines.push(
		`\n${summary}${advisories ? ` ${paint.warn(`${advisories} advisory to review.`)}` : ""}`,
	);
	return lines.join("\n");
}
