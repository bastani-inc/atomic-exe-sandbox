import { run, runAllowFailure } from "./process.js";
import type { GitContext } from "./types.js";

function git(cwd: string, ...args: string[]): string {
	return run("git", ["-C", cwd, ...args]).stdout.trim();
}
function gitOptional(cwd: string, ...args: string[]): string | undefined {
	const result = runAllowFailure("git", ["-C", cwd, ...args]);
	return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/** Resolves an SSH host alias to its real hostname via the local SSH config. */
export function resolveSshHost(host: string): string | undefined {
	const result = runAllowFailure("ssh", ["-G", host]);
	if (result.exitCode !== 0) return undefined;
	return result.stdout
		.split("\n")
		.find((line) => line.startsWith("hostname "))
		?.slice("hostname ".length)
		.trim();
}

export function parseGitHubRemote(
	remote: string,
	resolveHost: (host: string) => string | undefined = resolveSshHost,
) {
	const trimmed = remote.trim();
	let match = trimmed.match(
		/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i,
	);
	if (!match) {
		// scp-style `host:owner/repo`, where host may be an SSH config alias such as
		// `agit:` that resolves to github.com. Resolve it before rejecting the remote.
		const scp = trimmed.match(
			/^(?:[^@/:]+@)?([A-Za-z0-9._-]+):([^/]+)\/([^/]+?)(?:\.git)?$/,
		);
		if (scp && resolveHost(scp[1])?.toLowerCase() === "github.com")
			match = [trimmed, scp[2], scp[3]] as RegExpMatchArray;
	}
	if (!match)
		throw new Error(
			`origin/upstream must be a GitHub repository, got: ${remote}`,
		);
	const owner = match[1],
		repo = match[2];
	return {
		owner,
		repo,
		canonicalRepo: `github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`,
	};
}

function baseIdentity(
	cwd: string,
): Omit<GitContext, "upstream"> & { upstream?: string } {
	const root = git(cwd, "rev-parse", "--show-toplevel");
	const branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
	if (!branch)
		throw new Error(
			"detached HEAD is unsupported; check out a published branch first",
		);
	const commit = git(root, "rev-parse", "HEAD");
	const upstream = gitOptional(
		root,
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	);
	const remoteName = upstream?.split("/")[0] ?? "origin";
	const remote = git(root, "remote", "get-url", remoteName);
	return {
		root,
		branch,
		branchRef: `refs/heads/${branch}`,
		commit,
		upstream,
		...parseGitHubRemote(remote),
	};
}

function publishOrTrackNewBranch(
	context: ReturnType<typeof baseIdentity>,
): string {
	const { root, branch, branchRef, commit } = context,
		remoteName = "origin",
		remote = git(root, "remote", "get-url", remoteName);
	parseGitHubRemote(remote);
	const remoteLine = run("git", ["ls-remote", remote, branchRef]).stdout.trim();
	const remoteHead = remoteLine ? remoteLine.split(/\s+/)[0] : undefined;
	if (remoteHead && remoteHead !== commit)
		throw new Error(
			`GitHub branch ${branchRef} already exists at ${remoteHead.slice(0, 12)}, not local HEAD ${commit.slice(0, 12)}`,
		);
	if (remoteHead) {
		git(
			root,
			"fetch",
			remoteName,
			`${branchRef}:refs/remotes/${remoteName}/${branch}`,
		);
		git(root, "branch", "--set-upstream-to", `${remoteName}/${branch}`, branch);
	} else {
		git(root, "push", "--set-upstream", remoteName, `HEAD:${branchRef}`);
	}
	return `${remoteName}/${branch}`;
}

export interface WorktreeStatus {
	staged: string[];
	unstaged: string[];
	untracked: string[];
	unmerged: string[];
}

function unquotePath(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"'))
		return trimmed;
	return trimmed
		.slice(1, -1)
		.replace(/\\([nrt"\\])/g, (_match, char: string) => {
			if (char === "n") return "\n";
			if (char === "r") return "\r";
			if (char === "t") return "\t";
			return char;
		});
}

function pathFromFields(line: string, prefix: string, fieldCount: number): string {
	const rest = line.slice(prefix.length);
	const parts = rest.split(" ");
	if (parts.length <= fieldCount) return unquotePath(rest);
	return unquotePath(parts.slice(fieldCount).join(" ").split("\t")[0] ?? rest);
}

/**
 * Parse `git status --porcelain=v2` into staged, unstaged, untracked, and
 * unmerged paths. A path can appear in more than one list (for example MM).
 */
export function parseWorktreeStatus(porcelain: string): WorktreeStatus {
	const staged: string[] = [];
	const unstaged: string[] = [];
	const untracked: string[] = [];
	const unmerged: string[] = [];
	for (const line of porcelain.split("\n")) {
		if (!line) continue;
		if (line.startsWith("? ")) {
			untracked.push(unquotePath(line.slice(2)));
			continue;
		}
		if (line.startsWith("u ")) {
			const xy = line.slice(2, 4);
			const path = pathFromFields(line, "u ", 9);
			unmerged.push(path);
			if (xy[0] && xy[0] !== ".") staged.push(path);
			if (xy[1] && xy[1] !== ".") unstaged.push(path);
			continue;
		}
		if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const kind = line[0];
			const xy = line.slice(2, 4);
			const path = pathFromFields(line, `${kind} `, kind === "2" ? 9 : 8);
			if (xy[0] && xy[0] !== ".") staged.push(path);
			if (xy[1] && xy[1] !== ".") unstaged.push(path);
		}
	}
	return { staged, unstaged, untracked, unmerged };
}

export function inspectWorktree(cwd: string): WorktreeStatus {
	const root = git(cwd, "rev-parse", "--show-toplevel");
	return parseWorktreeStatus(
		git(root, "status", "--porcelain=v2", "--untracked-files=all"),
	);
}

export function isDirtyWorktree(status: WorktreeStatus): boolean {
	return (
		status.staged.length > 0 ||
		status.unstaged.length > 0 ||
		status.untracked.length > 0 ||
		status.unmerged.length > 0
	);
}

export function inspectPublishedGit(cwd: string): GitContext {
	const context = baseIdentity(cwd);
	const upstream = context.upstream ?? publishOrTrackNewBranch(context);
	const remoteName = upstream.split("/")[0],
		remote = git(context.root, "remote", "get-url", remoteName);
	git(context.root, "fetch", "--prune", remoteName);
	const upstreamCommit = git(context.root, "rev-parse", "@{upstream}");
	if (upstreamCommit !== context.commit)
		throw new Error(
			`HEAD ${context.commit.slice(0, 12)} is not equal to upstream ${upstreamCommit.slice(0, 12)}`,
		);
	const remoteHead = run("git", ["ls-remote", remote, context.branchRef])
		.stdout.trim()
		.split(/\s+/)[0];
	if (remoteHead !== context.commit)
		throw new Error(
			`GitHub branch ${context.branchRef} does not resolve to local HEAD`,
		);
	return { ...context, upstream };
}

export function inspectGitIdentity(cwd: string): GitContext {
	const context = baseIdentity(cwd);
	const upstream = context.upstream ?? `origin/${context.branch}`;
	return { ...context, upstream };
}
