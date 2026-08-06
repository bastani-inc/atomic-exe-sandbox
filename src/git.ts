import { run, runAllowFailure } from "./process.js";
import type { GitContext } from "./types.js";

function git(cwd: string, ...args: string[]): string {
	return run("git", ["-C", cwd, ...args]).stdout.trim();
}
function gitOptional(cwd: string, ...args: string[]): string | undefined {
	const result = runAllowFailure("git", ["-C", cwd, ...args]);
	return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

export function parseGitHubRemote(remote: string) {
	const match = remote
		.trim()
		.match(
			/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i,
		);
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

export function inspectPublishedGit(cwd: string): GitContext {
	const context = baseIdentity(cwd);
	if (git(context.root, "status", "--porcelain=v2", "--untracked-files=all"))
		throw new Error(
			"worktree has tracked, staged, or untracked changes; commit before entering the sandbox",
		);
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
