import { Buffer } from "node:buffer";
import type { LocalPackage } from "./config.js";
import { vmScript, vmSsh } from "./exe.js";
import type { GitContext, SandboxIdentity, SandboxManifest } from "./types.js";
import { CHECKOUT_ROOT, HERDR_SESSION_NAME, MANIFEST_SCHEMA } from "./types.js";

/** $HOME/.local/bin holds the herdr binary dropped by https://herdr.dev/install.sh. */
const REMOTE_PATH = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`;

/**
 * Herdr exposes no attached-client count, so an attached client is represented by a
 * shared lease on attach.lock held by the sessionctl attach wrapper for as long as the
 * client lives. A destructive operation must be able to take that lease exclusively.
 * A lock that cannot be opened or tested fails the guard; it never reports "unattached".
 */
const ATTACH_GUARD = `exec 8>"$HOME/.atomic-exe/attach.lock"
chmod 600 "$HOME/.atomic-exe/attach.lock"
flock -n -x 8 || { echo 'Atomic sandbox has attached clients' >&2; exit 1; }`;

function encoded(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64");
}

export function initialManifest(
	git: GitContext,
	id: SandboxIdentity,
): SandboxManifest {
	const now = new Date().toISOString();
	return {
		schemaVersion: MANIFEST_SCHEMA,
		identity: id.id,
		vmName: id.vmName,
		canonicalRepo: git.canonicalRepo,
		owner: git.owner,
		repo: git.repo,
		branchRef: git.branchRef,
		branch: git.branch,
		creationCommit: git.commit,
		checkoutPath: `${CHECKOUT_ROOT}/${id.id}/repo`,
		state: "creating",
		createdAt: now,
		updatedAt: now,
	};
}

export function bootstrapRepository(
	vm: string,
	manifest: SandboxManifest,
): void {
	vmScript(
		vm,
		`set -euo pipefail
umask 077
manifest_b64=$1; identity=$2; checkout=$3; owner=$4; repo=$5; branch=$6; branch_ref=$7; commit=$8
root=$HOME/.atomic-exe
case "$checkout" in "/home/exedev/atomic-sandboxes/$identity/"*) ;; *) echo 'invalid checkout root' >&2; exit 1;; esac
install -d -m 700 "$root" "$root/local-packages" "/home/exedev/atomic-sandboxes/$identity"
printf '%s' "$manifest_b64" | base64 -d > "$root/manifest.json"
chmod 600 "$root/manifest.json"
clone_url="https://github.int.exe.xyz/$owner/$repo.git"
if [ -e "$checkout" ]; then
  [ ! -L "$checkout" ] || { echo 'checkout is a symlink' >&2; exit 1; }
  test "$(git -C "$checkout" remote get-url origin)" = "$clone_url"
else
  git clone --branch "$branch" --single-branch "$clone_url" "$checkout"
fi
git -C "$checkout" fetch origin "$branch_ref"
test "$(git -C "$checkout" rev-parse HEAD)" = "$commit"
test "$(git -C "$checkout" rev-parse "origin/$branch")" = "$commit"
`,
		[
			encoded(manifest),
			manifest.identity,
			manifest.checkoutPath,
			manifest.owner,
			manifest.repo,
			manifest.branch,
			manifest.branchRef,
			manifest.creationCommit,
		],
	);
}

export function finalize(
	vm: string,
	manifest: SandboxManifest,
	packages: LocalPackage[],
): void {
	const mapping = Object.fromEntries(
		packages.flatMap((pkg) => [
			[pkg.configured, pkg.remote],
			[pkg.source, pkg.remote],
		]),
	);
	vmScript(
		vm,
		`set -euo pipefail
umask 077
mapping_b64=$1; checkout=$2; updated_at=$3
root=$HOME/.atomic-exe; stage=$root/config-stage; agent=$HOME/.atomic/agent
${REMOTE_PATH}
if [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.com/install | bash
fi
if ! command -v herdr >/dev/null 2>&1; then
  curl -fsSL https://herdr.dev/install.sh | sh
fi
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if ! command -v npm >/dev/null 2>&1 || [ "$node_major" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
fi
# The exe.dev image ships other agents but not Atomic, so install it here. 'bun install -g'
# links the binary into $HOME/.bun/bin, which the remote scripts and SESSIONCTL both put
# on PATH, and the shim runs through node, so this has to follow the node install above.
if ! command -v atomic >/dev/null 2>&1; then
  "$HOME/.bun/bin/bun" install -g @bastani/atomic
fi
command -v atomic >/dev/null 2>&1 || { echo 'Atomic agent install failed: no atomic binary on PATH (looked in $HOME/.local/bin and $HOME/.bun/bin)' >&2; exit 1; }
atomic --version >/dev/null 2>&1 || { echo 'Atomic agent is installed but not executable; check that node 20 or newer is on PATH' >&2; exit 1; }
install -d -m 700 "$agent"
# Preserve exe.dev's managed-LLM extension even if local config has a collision.
vendor_backup=$root/exe-dev-vendor
rm -rf "$vendor_backup"
if [ -d "$agent/extensions/exe-dev" ]; then cp -a "$agent/extensions/exe-dev" "$vendor_backup"; fi
if [ -d "$stage/.atomic/agent" ]; then cp -a "$stage/.atomic/agent/." "$agent/"; fi
if [ -d "$stage/.agents" ]; then install -d -m 700 "$HOME/.agents"; cp -a "$stage/.agents/." "$HOME/.agents/"; fi
if [ -d "$vendor_backup" ]; then rm -rf "$agent/extensions/exe-dev"; mv "$vendor_backup" "$agent/extensions/exe-dev"; fi
printf '%s\\n' '{"version":1,"useExeIntegration":false}' > "$agent/exe-dev-llm-integration.json"
chmod 600 "$agent/exe-dev-llm-integration.json"
# Atomic package caches are platform-specific and may be partial after a failed start.
rm -rf "$agent/git" "$agent/npm"
python3 - "$mapping_b64" <<'PY'
import base64,json,os,sys
p=os.path.expanduser('~/.atomic/agent/settings.json'); m=json.loads(base64.b64decode(sys.argv[1]))
if os.path.exists(p):
 d=json.load(open(p)); packages=[]
 for x in d.get('packages',[]):
  x=m.get(x,x)
  if isinstance(x,str) and x.startswith('git:git@github.com:'):
   x='git:https://github.com/'+x[len('git:git@github.com:'):]
  packages.append(x)
 d['packages']=packages
 powerline=d.get('powerline')
 if isinstance(powerline,str): powerline={'preset':powerline}
 if not isinstance(powerline,dict): powerline={'preset':'default'}
 items=powerline.get('customItems')
 if not isinstance(items,list): items=[]
 items=[item for item in items if not isinstance(item,dict) or item.get('id')!='exe-sandbox']
 items.insert(0,{'id':'exe-sandbox','statusKey':'atomic-exe-sandbox','position':'left','color':'accent','hideWhenMissing':True,'excludeFromExtensionStatuses':True})
 powerline['customItems']=items; d['powerline']=powerline
 with open(p,'w') as f: json.dump(d,f,indent=2); f.write(chr(10))
 os.chmod(p,0o600)
PY
for pkg in "$root"/local-packages/*; do
 [ -d "$pkg" ] || continue
 if [ -f "$pkg/bun.lock" ] || [ -f "$pkg/package.json" ]; then
   (cd "$pkg" && "$HOME/.bun/bin/bun" install --frozen-lockfile || "$HOME/.bun/bin/bun" install)
 fi
done
cd "$checkout"
if [ -f bun.lock ]; then "$HOME/.bun/bin/bun" install --frozen-lockfile; fi
python3 - "$updated_at" <<'PY'
import json,os,sys
p=os.path.expanduser('~/.atomic-exe/manifest.json'); d=json.load(open(p)); d['state']='ready'; d['updatedAt']=sys.argv[1]
with open(p,'w') as f: json.dump(d,f,indent=2); f.write(chr(10))
os.chmod(p,0o600)
PY
rm -rf "$stage"
`,
		[encoded(mapping), manifest.checkoutPath, new Date().toISOString()],
	);
}

export function markManifestError(vm: string, message: string): void {
	vmScript(
		vm,
		`set -euo pipefail
message_b64=$1
python3 - "$message_b64" <<'PY'
import base64,json,os,datetime,sys
p=os.path.expanduser('~/.atomic-exe/manifest.json')
if os.path.exists(p):
 d=json.load(open(p)); d['state']='error'; d['error']=base64.b64decode(sys.argv[1]).decode()[:1000]; d['updatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with open(p,'w') as f: json.dump(d,f,indent=2); f.write(chr(10))
 os.chmod(p,0o600)
PY
`,
		[Buffer.from(message).toString("base64")],
	);
}

export function guardDestroy(
	vm: string,
	manifest: SandboxManifest,
	force: boolean,
): void {
	vmScript(
		vm,
		`set -euo pipefail
umask 077
${REMOTE_PATH}
force=$1; expected_vm=$2; expected_identity=$3; expected_branch=$4
exec 9>"$HOME/.atomic-exe/lifecycle.lock"; flock -n 9 || { echo 'lifecycle operation already running' >&2; exit 1; }
repo=$(python3 - "$expected_vm" "$expected_identity" <<'PY'
import json,os,stat,sys
p=os.path.expanduser('~/.atomic-exe/manifest.json'); s=os.lstat(p)
assert stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode)
d=json.load(open(p)); assert d['vmName']==sys.argv[1] and d['identity']==sys.argv[2]
assert d['checkoutPath'].startswith('/home/exedev/atomic-sandboxes/'+d['identity']+'/')
print(d['checkoutPath'])
PY
)
if [ "$force" != true ]; then
${ATTACH_GUARD}
 [ -z "$(git -C "$repo" status --porcelain=v2 --untracked-files=all)" ] || { echo 'repository has uncommitted or untracked work' >&2; exit 1; }
 git -C "$repo" submodule foreach --recursive 'test -z "$(git status --porcelain=v2 --untracked-files=all)"'
 if git -C "$repo" rev-parse --verify --quiet refs/stash >/dev/null; then
   echo 'repository has stashed work' >&2
   exit 1
 fi
 git -C "$repo" fetch --prune origin
 branch=$(git -C "$repo" symbolic-ref --quiet --short HEAD)
 [ "$branch" = "$expected_branch" ] || { echo 'checked out branch differs from manifest' >&2; exit 1; }
 git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$branch" || { echo 'missing remote branch' >&2; exit 1; }
 [ "$(git -C "$repo" rev-list --count "origin/$branch..HEAD")" -eq 0 ] || { echo 'repository has unpushed commits' >&2; exit 1; }
 unpushed=$(git -C "$repo" for-each-ref --format='%(refname)' refs/heads | while read -r ref; do
   b=\${ref#refs/heads/}
   if ! git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$b"; then echo "$ref"; continue; fi
   count=$(git -C "$repo" rev-list --count "refs/remotes/origin/$b..$ref")
   [ "$count" -eq 0 ] || echo "$ref"
 done)
 [ -z "$unpushed" ] || { echo 'repository has unpushed local branches' >&2; exit 1; }
fi
python3 - <<'PY'
import json,os,datetime
p=os.path.expanduser('~/.atomic-exe/manifest.json'); d=json.load(open(p)); d['state']='destroying'; d['updatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
with open(p,'w') as f: json.dump(d,f,indent=2); f.write(chr(10))
os.chmod(p,0o600)
PY
herdr session stop ${HERDR_SESSION_NAME} >/dev/null 2>&1 || true
`,
		[String(force), vm, manifest.identity, manifest.branch],
	);
}

export function cleanSandbox(vm: string, manifest: SandboxManifest): void {
	vmScript(
		vm,
		`set -euo pipefail
umask 077
checkout=$1; expected_identity=$2
${REMOTE_PATH}
exec 9>"$HOME/.atomic-exe/lifecycle.lock"; flock -n 9 || { echo 'lifecycle operation already running' >&2; exit 1; }
python3 - "$expected_identity" <<'PY'
import json,os,sys
p=os.path.expanduser('~/.atomic-exe/manifest.json'); d=json.load(open(p)); assert d['identity']==sys.argv[1] and d['state']=='ready'
PY
${ATTACH_GUARD}
rm -rf "$HOME/.atomic/agent/cache"
cd "$checkout"
if [ -f bun.lock ]; then "$HOME/.bun/bin/bun" install --frozen-lockfile; fi
`,
		[manifest.checkoutPath, manifest.identity],
	);
}

/**
 * True when a managed client currently holds the sandbox attach lease. A lock that
 * cannot be tested is reported as attached, so callers never destroy on doubt.
 */
export function sandboxAttached(vm: string): boolean {
	return (
		vmSsh(
			vm,
			"sh",
			"-lc",
			`f="$HOME/.atomic-exe/attach.lock"; [ -e "$f" ] || exit 0; flock -n -x "$f" true || echo attached`,
		).trim() === "attached"
	);
}
