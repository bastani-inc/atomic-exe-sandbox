import { randomUUID } from "node:crypto";
import { VM_HOST_KEY_ARGS, vmScript, vmSsh } from "./exe.js";
import { pipeBuffer } from "./process.js";
import { HERDR_SESSION_NAME, type SandboxManifest } from "./types.js";
import {
	type Paint,
	PLAIN_PAINT,
	RUNNING,
	STOPPED,
} from "./ui.js";

export interface SandboxSession {
	id: number;
	sessionId: string;
	sessionPath?: string;
	createdAt: string;
	transferred?: boolean;
	/** Opaque Herdr ids, captured from Herdr command output. Absent on rows written before Herdr. */
	workspaceId?: string;
	tabId?: string;
	paneId?: string;
}

export interface SessionStatus extends SandboxSession {
	running: boolean;
	attached: boolean;
}

export interface SessionsRegistry {
	version: 1;
	nextId: number;
	lastId: number;
	sessions: Record<string, SandboxSession>;
}

const HERDR_ID_FIELDS = ["workspaceId", "tabId", "paneId"] as const;

function decodeJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(
			`${label} contains invalid JSON: ${(error as Error).message}`,
		);
	}
}

/**
 * Herdr ids are opaque strings produced by Herdr itself. Rows written before the
 * Herdr migration have none, so every id field is optional and is only checked
 * when it is present.
 */
function checkHerdrIds(value: Partial<SandboxSession>, label: string): void {
	for (const field of HERDR_ID_FIELDS) {
		const id = value[field];
		if (id === undefined) continue;
		if (typeof id !== "string" || id === "")
			throw new Error(`${label} has an invalid ${field}`);
	}
}

export function emptyRegistry(
	sessionId: string = randomUUID(),
): SessionsRegistry {
	const first: SandboxSession = {
		id: 1,
		sessionId,
		createdAt: new Date().toISOString(),
	};
	return { version: 1, nextId: 2, lastId: 1, sessions: { "1": first } };
}

export function emptySessionsRegistry(): SessionsRegistry {
	return { version: 1, nextId: 1, lastId: 0, sessions: {} };
}

export function allocateSession(
	registry: SessionsRegistry,
	sessionId: string = randomUUID(),
): SandboxSession {
	const id = registry.nextId;
	const session: SandboxSession = {
		id,
		sessionId,
		createdAt: new Date().toISOString(),
	};
	registry.sessions[String(id)] = session;
	registry.nextId = id + 1;
	registry.lastId = id;
	return session;
}

export function parseRegistry(value: unknown): SessionsRegistry {
	if (!value || typeof value !== "object")
		throw new Error("sandbox sessions registry is invalid");
	const registry = value as SessionsRegistry;
	if (
		registry.version !== 1 ||
		!Number.isInteger(registry.nextId) ||
		!Number.isInteger(registry.lastId) ||
		!registry.sessions
	) {
		throw new Error("unsupported sandbox sessions registry");
	}
	for (const [key, session] of Object.entries(registry.sessions)) {
		if (
			String(session.id) !== key ||
			!Number.isInteger(session.id) ||
			!session.sessionId
		)
			throw new Error(`invalid sandbox session #${key}`);
		checkHerdrIds(session, `sandbox session #${key}`);
	}
	return registry;
}

export function parseSession(value: unknown): SandboxSession {
	if (!value || typeof value !== "object")
		throw new Error("sandbox session is invalid");
	const session = value as Partial<SandboxSession>;
	if (!Number.isInteger(session.id) || !session.sessionId || !session.createdAt)
		throw new Error("sandbox session fields are invalid");
	checkHerdrIds(session, "sandbox session");
	return session as SandboxSession;
}

export function initializeSessions(
	vm: string,
	manifest: SandboxManifest,
	startDefault = true,
): void {
	const registry = startDefault ? emptyRegistry() : emptySessionsRegistry();
	vmScript(
		vm,
		`set -euo pipefail
ctl_b64=$1; registry_b64=$2
printf '%s' "$ctl_b64" | base64 -d > "/home/exedev/.atomic-exe/sessionctl"
chmod 700 "/home/exedev/.atomic-exe/sessionctl"
printf '%s' "$registry_b64" | base64 -d > "$HOME/.atomic-exe/sessions.json"
chmod 600 "$HOME/.atomic-exe/sessions.json"
if [ "$3" = true ]; then "/home/exedev/.atomic-exe/sessionctl" ensure 1 >/dev/null; fi
`,
		[
			Buffer.from(SESSIONCTL).toString("base64"),
			Buffer.from(JSON.stringify(registry)).toString("base64"),
			String(startDefault),
		],
	);
}

export function ensureRemoteSession(
	vm: string,
	requestedId?: number,
): SandboxSession {
	const output = vmSsh(
		vm,
		"/home/exedev/.atomic-exe/sessionctl",
		"ensure",
		requestedId === undefined ? "" : String(requestedId),
	);
	return parseSession(decodeJson(output.trim(), "remote sandbox session"));
}

export function createRemoteSession(vm: string): SandboxSession {
	const output = vmSsh(vm, "/home/exedev/.atomic-exe/sessionctl", "new");
	return parseSession(decodeJson(output.trim(), "new sandbox session"));
}

export function listRemoteSessions(vm: string): SessionStatus[] {
	const value = decodeJson(
		vmSsh(vm, "/home/exedev/.atomic-exe/sessionctl", "list"),
		"remote sandbox session list",
	);
	if (!Array.isArray(value))
		throw new Error("remote sandbox session list is not an array");
	return value.map((item) => ({
		...parseSession(item),
		running: Boolean((item as { running?: unknown }).running),
		attached: Boolean((item as { attached?: unknown }).attached),
	}));
}

export function reserveTransferredSession(
	vm: string,
	sessionId: string,
): SandboxSession {
	const output = vmSsh(
		vm,
		"/home/exedev/.atomic-exe/sessionctl",
		"reserve-transfer",
		sessionId,
	);
	return parseSession(decodeJson(output.trim(), "reserved sandbox session"));
}

export async function uploadTransferredSession(
	vm: string,
	session: SandboxSession,
	source: Buffer,
	remoteCwd: string,
): Promise<void> {
	if (!session.sessionPath)
		throw new Error("reserved transferred session has no path");
	const payload = rewriteSessionCwd(source, remoteCwd);
	await pipeBuffer(payload, {
		command: "ssh",
		args: [
			"-o",
			"BatchMode=yes",
			...VM_HOST_KEY_ARGS,
			`${vm}.exe.xyz`,
			`install -d -m 700 /home/exedev/.atomic-exe/transferred && cat > '${session.sessionPath}' && chmod 600 '${session.sessionPath}'`,
		],
	});
	vmSsh(
		vm,
		"python3",
		"-c",
		"import json,sys; [json.loads(x) for x in open(sys.argv[1]) if x.strip()]",
		session.sessionPath,
	);
}

export function rewriteSessionCwd(source: Buffer, remoteCwd: string): Buffer {
	const newline = source.indexOf(10);
	if (newline < 0) throw new Error("local Atomic session has no JSONL entries");
	const header = decodeJson(
		source.subarray(0, newline).toString("utf8"),
		"local Atomic session header",
	) as { type?: string; id?: string; cwd?: string };
	if (header.type !== "session" || !header.id)
		throw new Error("local Atomic session header is invalid");
	header.cwd = remoteCwd;
	return Buffer.concat([
		Buffer.from(JSON.stringify(header)),
		Buffer.from("\n"),
		source.subarray(newline + 1),
	]);
}

export function rollbackTransferredSession(vm: string, id: number): void {
	vmSsh(
		vm,
		"/home/exedev/.atomic-exe/sessionctl",
		"rollback-transfer",
		String(id),
	);
}

export function formatSessions(
	sessions: SessionStatus[],
	paint: Paint = PLAIN_PAINT,
): string {
	if (sessions.length === 0)
		return paint.dim("No Atomic sessions in this sandbox.");
	return sessions
		.map((session) => {
			// Attached is the session the user is looking at, so it reads in the accent
			// colour rather than in the green that only means "the process is up".
			const state = session.running
				? session.attached
					? "attached"
					: "running"
				: "stopped";
			const tint = session.running
				? session.attached
					? paint.accent
					: paint.ok
				: paint.dim;
			const glyph = session.running ? RUNNING : STOPPED;
			const transferred = session.transferred
				? paint.dim("  transferred")
				: "";
			return `${tint(`${glyph} #${session.id}`)}  ${tint(state)}${transferred}`;
		})
		.join("\n");
}

export const SESSIONCTL = `#!/usr/bin/env bash
set -euo pipefail
# ATOMIC_CODING_AGENT_DIR pins Atomic to ~/.atomic/agent. Without it Atomic also scans
# the legacy ~/.pi directory, where the exe.dev image keeps a Pi-only extension that
# fails to load under Atomic and blocks session startup.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" TERM=xterm-256color COLORTERM=truecolor GH_HOST=github.int.exe.xyz ATOMIC_CODING_AGENT_DIR="$HOME/.atomic/agent"
root=$HOME/.atomic-exe
registry=$root/sessions.json
manifest=$root/manifest.json
session=${HERDR_SESSION_NAME}
checkout=$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.atomic-exe/manifest.json")))["checkoutPath"])')
install -d -m 700 "$root/clients"
exec 9>"$root/sessions.lock"
flock -x 9

herdr_cli() { herdr --session "$session" "$@"; }

# 'herdr status server' always exits 0, so the running flag has to be read out of its JSON.
server_running() {
  herdr_cli status server --json | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("running") else 1)'
}

# The detached server must not inherit the registry or attach lock descriptors,
# otherwise it would hold those locks for its whole lifetime.
ensure_server() {
  if server_running; then return 0; fi
  setsid herdr --session "$session" server >>"$root/herdr-server.log" 2>&1 </dev/null 8>&- 9>&- &
  for _ in $(seq 1 50); do
    if server_running; then return 0; fi
    sleep 0.2
  done
  echo 'herdr server did not start' >&2
  exit 1
}

# Reads a workspace/tab creation response and writes the ids Herdr assigned as
# NUL-delimited fields. Ids are always taken from this output, never constructed,
# and NUL delimiting keeps ids containing spaces or newlines intact.
herdr_ids() {
  python3 -c 'import json,sys
r=json.load(sys.stdin)["result"]
tab=r["tab"]; pane=r["root_pane"]
ws=r["workspace"]["workspace_id"] if "workspace" in r else tab["workspace_id"]
ids=(ws, tab["tab_id"], pane["pane_id"])
for value in ids:
    if not isinstance(value, str) or not value: raise SystemExit("herdr returned an unusable object id")
sys.stdout.write("".join(value+chr(0) for value in ids))'
}

session_row() {
  python3 - "$1" <<'PY'
import json,os,sys
p=os.path.expanduser('~/.atomic-exe/sessions.json'); d=json.load(open(p)); key=str(int(sys.argv[1])); item=d['sessions'].get(key)
if not item: raise SystemExit(f'unknown sandbox session #{key}')
print(json.dumps(item))
PY
}

# Reads one registry field into REPLY over a NUL-delimited pipe. Command substitution
# would strip trailing newlines and word-splitting would break ids containing spaces.
row_field() {
  local value
  IFS= read -r -d '' value < <(printf '%s' "$1" | python3 -c 'import json,sys
value=json.load(sys.stdin).get(sys.argv[1])
sys.stdout.write(("" if value is None else str(value))+chr(0))' "$2")
  REPLY=$value
}

# A restarted herdr server restores panes holding only a fresh shell, so pane existence
# is not liveness. The ready marker records the Atomic pid and its /proc start time, and
# both must still match. Missing, unreadable or unparsable markers fail closed.
marker_alive() {
  python3 - "$root/ready-$1" <<'PY'
import sys
try: parts=open(sys.argv[1]).read().split()
except OSError: raise SystemExit(1)
if len(parts)!=2 or not parts[0].isdigit() or not parts[1].isdigit(): raise SystemExit(1)
pid,start=parts
try: stat=open('/proc/'+pid+'/stat').read()
except OSError: raise SystemExit(1)
fields=stat[stat.rfind(')')+2:].split()
raise SystemExit(0 if len(fields)>19 and fields[19]==start else 1)
PY
}

persist_ids() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json,os,sys
p=os.path.expanduser('~/.atomic-exe/sessions.json'); d=json.load(open(p)); key=str(int(sys.argv[1])); item=d['sessions'].get(key)
if not item: raise SystemExit(f'unknown sandbox session #{key}')
item['workspaceId'],item['tabId'],item['paneId']=sys.argv[2],sys.argv[3],sys.argv[4]
tmp=p+'.tmp.'+str(os.getpid())
with open(tmp,'w') as f: json.dump(d,f,indent=2); f.write(chr(10))
os.chmod(tmp,0o600); os.replace(tmp,p)
PY
}

# The workspace is shared by every numbered session; its id is read back from the
# registry and re-verified against Herdr, because a restarted server forgets it.
# It only proves the container exists, never that a session is alive.
live_workspace() {
  local candidate
  REPLY=""
  while IFS= read -r -d '' candidate; do
    if [ -n "$candidate" ] && herdr_cli workspace get "$candidate" >/dev/null 2>&1; then REPLY=$candidate; return 0; fi
  done < <(python3 -c 'import json,os,sys
d=json.load(open(os.path.expanduser("~/.atomic-exe/sessions.json")))
seen=[]
for item in d["sessions"].values():
    ws=item.get("workspaceId")
    if isinstance(ws,str) and ws and ws not in seen: seen.append(ws)
sys.stdout.write("".join(ws+chr(0) for ws in seen))')
  return 0
}

# A tab recorded in the registry that no longer belongs to this session is closed only
# after its replacement exists: closing the last tab fails on Herdr 0.7.5 and destroys
# the workspace on 0.8.0. An already-gone tab is fine; any other close error fails closed.
close_stale_tab() {
  local old=$1 new=$2 output
  [ -n "$old" ] || return 0
  [ "$old" != "$new" ] || return 0
  if output=$(herdr_cli tab close "$old" 2>&1); then return 0; fi
  case "$output" in *tab_not_found*) return 0;; esac
  echo "could not close the stale herdr tab $old: $output" >&2
  exit 1
}

start_window() {
  # The exe.dev image does not ship Atomic; provisioning installs it. Fail with a clear
  # message instead of letting the pane die on 'atomic: command not found'.
  command -v atomic >/dev/null 2>&1 || { echo 'atomic is not installed in this sandbox: expected the agent on PATH ($HOME/.local/bin or $HOME/.bun/bin)' >&2; exit 1; }
  local row=$1 id session_id session_path workspace tab pane created command agent log ready stale_tab
  row_field "$row" id; id=$REPLY
  row_field "$row" sessionId; session_id=$REPLY
  row_field "$row" sessionPath; session_path=$REPLY
  row_field "$row" workspaceId; workspace=$REPLY
  row_field "$row" tabId; tab=$REPLY
  row_field "$row" paneId; pane=$REPLY
  ready="$root/ready-$id"; rm -f "$ready"
  # Herdr destroys a pane as soon as its process exits, taking the terminal output with
  # it, so Atomic runs under 'script' and startup diagnostics come from this log.
  log="$root/atomic-start-$id.log"; install -m 600 /dev/null "$log"
  ensure_server
  if [ -n "$pane" ] && herdr_cli pane get "$pane" >/dev/null 2>&1; then
    # A restarted server restores the recorded pane holding a bare shell. Reuse it, so the
    # session keeps its ids and no duplicate tab appears.
    :
  else
    stale_tab=$tab
    live_workspace; workspace=$REPLY
    if [ -n "$workspace" ]; then
      created=$(herdr_cli tab create --workspace "$workspace" --cwd "$checkout" --label "$id" --no-focus --env "ATOMIC_EXE_SESSION_ID=$id" --env GH_HOST=github.int.exe.xyz --env COLORTERM=truecolor --env "ATOMIC_CODING_AGENT_DIR=$HOME/.atomic/agent")
    else
      created=$(herdr_cli workspace create --cwd "$checkout" --label "$session" --no-focus --env "ATOMIC_EXE_SESSION_ID=$id" --env GH_HOST=github.int.exe.xyz --env COLORTERM=truecolor --env "ATOMIC_CODING_AGENT_DIR=$HOME/.atomic/agent")
    fi
    { IFS= read -r -d '' workspace; IFS= read -r -d '' tab; IFS= read -r -d '' pane; } < <(printf '%s' "$created" | herdr_ids)
    herdr_cli tab rename "$tab" "$id" >/dev/null
    close_stale_tab "$stale_tab" "$tab"
  fi
  # The caller holds the registry lock for the whole of start_window, so two concurrent
  # 'ensure' calls cannot both pass the liveness check and create duplicate objects.
  persist_ids "$id" "$workspace" "$tab" "$pane"
  if [ -n "$session_path" ]; then agent="exec atomic --session '$session_path' --approve"
  else agent="exec atomic --session-id '$session_id' --approve"
  fi
  # A restored pane keeps its cwd but loses the per-pane environment, so both paths set
  # the working directory and every variable explicitly.
  command="cd '$checkout'; export ATOMIC_EXE_SESSION_ID='$id' GH_HOST=github.int.exe.xyz COLORTERM=truecolor ATOMIC_CODING_AGENT_DIR=\\"\\$HOME/.atomic/agent\\"; exec script -qefc \\"$agent\\" '$log'"
  herdr_cli pane run "$pane" "$command" >/dev/null
  for _ in $(seq 1 60); do
    if marker_alive "$id"; then return 0; fi
    herdr_cli pane get "$pane" >/dev/null 2>&1 || { echo "Atomic session #$id exited during startup:" >&2; tail -n 200 "$log" >&2 || true; exit 1; }
    sleep 1
  done
  echo "Atomic session #$id did not finish startup within 60 seconds:" >&2
  tail -n 200 "$log" >&2 || true
  herdr_cli pane read "$pane" --source recent-unwrapped --lines 200 >&2 || true
  exit 1
}

# A session runs only when its pane still exists and the Atomic process that wrote the
# ready marker is still the live process in it.
session_alive() {
  local pane id
  row_field "$1" paneId; pane=$REPLY
  [ -n "$pane" ] || return 1
  herdr_cli pane get "$pane" >/dev/null 2>&1 || return 1
  row_field "$1" id; id=$REPLY
  marker_alive "$id"
}

case "\${1:-}" in
  ensure)
    requested=\${2:-}
    id=$(python3 - "$requested" <<'PY'
import json,os,sys
p=os.path.expanduser('~/.atomic-exe/sessions.json'); d=json.load(open(p)); requested=sys.argv[1]; id=int(requested) if requested else int(d['lastId'])
if id==0 and not d['sessions']:
 import uuid,datetime
 id=1; d['sessions']['1']={'id':1,'sessionId':str(uuid.uuid4()),'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}; d['nextId']=2
if str(id) not in d['sessions']: raise SystemExit(f'unknown sandbox session #{id}')
d['lastId']=id
tmp=p+'.tmp.'+str(os.getpid())
with open(tmp,'w') as f: json.dump(d,f,indent=2); f.write(chr(10))
os.chmod(tmp,0o600); os.replace(tmp,p)
print(id)
PY
)
    row=$(session_row "$id")
    if ! session_alive "$row"; then
      start_window "$row"
      row=$(session_row "$id")
    fi
    flock -u 9
    printf '%s\\n' "$row"
    ;;
  new)
    row=$(python3 - <<'PY'
import json,os,uuid,datetime
p=os.path.expanduser('~/.atomic-exe/sessions.json'); d=json.load(open(p)); id=int(d['nextId'])
item={'id':id,'sessionId':str(uuid.uuid4()),'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
d['sessions'][str(id)]=item; d['nextId']=id+1; d['lastId']=id
tmp=p+'.tmp.'+str(os.getpid())
with open(tmp,'w') as f: json.dump(d,f,indent=2); f.write(chr(10))
os.chmod(tmp,0o600); os.replace(tmp,p)
print(json.dumps(item))
PY
)
    row_field "$row" id; id=$REPLY
    start_window "$row"
    row=$(session_row "$id")
    flock -u 9
    printf '%s\\n' "$row"
    ;;
  focus)
    id=$2; row=$(session_row "$id"); flock -u 9
    row_field "$row" tabId; tab=$REPLY
    [ -n "$tab" ] || { echo "sandbox session #$id has no herdr tab" >&2; exit 1; }
    herdr_cli tab focus "$tab" >/dev/null
    ;;
  attach)
    id=$2; row=$(session_row "$id")
    ensure_server
    flock -u 9
    row_field "$row" tabId; tab=$REPLY
    if [ -n "$tab" ]; then herdr_cli tab focus "$tab" >/dev/null; fi
    # Herdr exposes no attached-client count, so an attached client is represented
    # by a shared lease on attach.lock plus a registered client pid. destroy/clean
    # take the same lock exclusively, and 'detach' terminates the registered clients.
    exec 8>"$root/attach.lock"
    chmod 600 "$root/attach.lock"
    flock -s 8 || { echo 'could not take the sandbox attach lease' >&2; exit 1; }
    # Backgrounding the client from a non-interactive shell would give it /dev/null on
    # fd 0 even under ssh -tt, so the pty is passed through explicitly.
    exec 7<&0
    herdr --session "$session" <&7 8>&- 9>&- &
    client=$!
    # The record carries the pid and its /proc start time so that detach can prove the
    # process is still this client and never signals a reused pid or the herdr server.
    client_start=$(awk '{ n=index($0,") "); s=substr($0,n+2); split(s,f," "); print f[20] }' "/proc/$client/stat" 2>/dev/null || true)
    [ -n "$client_start" ] || { kill -TERM "$client" 2>/dev/null || true; echo 'could not identify the herdr client process' >&2; exit 1; }
    printf '%s %s\\n' "$client" "$client_start" > "$root/clients/$client"
    chmod 600 "$root/clients/$client"
    trap 'rm -f "$root/clients/$client"' EXIT
    status=0
    wait "$client" || status=$?
    exit "$status"
    ;;
  detach)
    flock -u 9
    python3 - "$root/clients" "$session" <<'PY'
import os,signal,sys
directory,session=sys.argv[1],sys.argv[2]
expected=['herdr','--session',session]
def identity(pid):
    try:
        stat=open('/proc/'+pid+'/stat').read()
        argv=open('/proc/'+pid+'/cmdline','rb').read().decode('utf-8','replace').split(chr(0))
    except OSError: return None
    while argv and argv[-1]=='': argv.pop()
    fields=stat[stat.rfind(')')+2:].split()
    return (fields[19] if len(fields)>19 else None, argv)
detached=0; skipped=0
for name in sorted(os.listdir(directory)):
    path=os.path.join(directory,name)
    if not name.isdigit(): continue
    try: parts=open(path).read().split()
    except OSError: continue
    current=identity(name)
    if current is None:
        # The process is gone; drop the stale record but never signal anything.
        try: os.remove(path)
        except OSError: pass
        continue
    start,argv=current
    if len(parts)!=2 or parts[0]!=name or not parts[1].isdigit() or parts[1]!=start or argv!=expected:
        # Legacy, malformed or reused-pid record, or the herdr server itself: leave it.
        skipped+=1
        continue
    try:
        os.kill(int(name),signal.SIGTERM); detached+=1
    except OSError: pass
if not detached:
    sys.stderr.write('no attached sandbox clients to detach'+(' ('+str(skipped)+' unrecognised client records left untouched)' if skipped else '')+chr(10))
    raise SystemExit(1)
PY
    ;;
  reserve-transfer)
    session_id=$2
    python3 - "$session_id" <<'PY'
import json,os,sys,datetime
p=os.path.expanduser('~/.atomic-exe/sessions.json'); d=json.load(open(p)); id=int(d['nextId']); path=os.path.expanduser(f'~/.atomic-exe/transferred/session-{id}.jsonl')
os.makedirs(os.path.dirname(path),mode=0o700,exist_ok=True)
item={'id':id,'sessionId':sys.argv[1],'sessionPath':path,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'transferred':True}
d['sessions'][str(id)]=item; d['nextId']=id+1; d['lastId']=id
tmp=p+'.tmp.'+str(os.getpid())
with open(tmp,'w') as f: json.dump(d,f,indent=2); f.write(chr(10))
os.chmod(tmp,0o600); os.replace(tmp,p); print(json.dumps(item))
PY
    ;;
  rollback-transfer)
    id=$2
    python3 - "$id" <<'PY'
import json,os,sys
p=os.path.expanduser('~/.atomic-exe/sessions.json'); d=json.load(open(p)); key=str(int(sys.argv[1])); item=d['sessions'].pop(key,None)
if item and item.get('sessionPath'):
 try: os.remove(item['sessionPath'])
 except FileNotFoundError: pass
ids=[int(x) for x in d['sessions']]; d['lastId']=max(ids) if ids else 0
tmp=p+'.tmp.'+str(os.getpid())
with open(tmp,'w') as f: json.dump(d,f,indent=2); f.write(chr(10))
os.chmod(tmp,0o600); os.replace(tmp,p)
PY
    ;;
  list)
    flock -u 9
    python3 - "$root" "$session" <<'PY'
import fcntl,json,os,subprocess,sys
root,session=sys.argv[1],sys.argv[2]
p=os.path.join(root,'sessions.json'); d=json.load(open(p))
def herdr(*args):
    try: done=subprocess.run(['herdr','--session',session,*args],capture_output=True,text=True)
    except OSError: return None
    if done.returncode!=0: return None
    try: return json.loads(done.stdout)
    except ValueError: return None
panes=set(); focused=set()
info=herdr('pane','list')
if info: panes={x.get('pane_id') for x in info.get('result',{}).get('panes',[])}
tabs=herdr('tab','list')
if tabs: focused={t.get('tab_id') for t in tabs.get('result',{}).get('tabs',[]) if t.get('focused')}
def marker_alive(key):
    try: parts=open(os.path.join(root,'ready-'+str(key))).read().split()
    except OSError: return False
    if len(parts)!=2 or not parts[0].isdigit() or not parts[1].isdigit(): return False
    pid,start=parts
    try: stat=open('/proc/'+pid+'/stat').read()
    except OSError: return False
    fields=stat[stat.rfind(')')+2:].split()
    return len(fields)>19 and fields[19]==start
def lease_held():
    path=os.path.join(root,'attach.lock')
    try: fd=os.open(path,os.O_RDWR|os.O_CREAT,0o600)
    except OSError: return True
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); fcntl.flock(fd,fcntl.LOCK_UN); return False
    except OSError: return True
    finally: os.close(fd)
attached=lease_held(); result=[]
for key in sorted(d['sessions'],key=int):
    item=dict(d['sessions'][key]); pane=item.get('paneId'); tab=item.get('tabId')
    item['running']=bool(isinstance(pane,str) and pane in panes and marker_alive(key))
    item['attached']=bool(attached and item['running'] and isinstance(tab,str) and tab in focused)
    result.append(item)
print(json.dumps(result))
PY
    ;;
  report-herdr)
    id=$2; row=$(session_row "$id"); flock -u 9
    row_field "$row" sessionId; session_id=$REPLY
    python3 - "$root/herdr-$id.sock" "$id" "$session_id" <<'PY'
import json,socket,sys,time
path,pane,session_id=sys.argv[1:]
seq=int(time.time()*1000000)
requests=[
 {'id':f'atomic-exe:session:{seq}','method':'pane.report_agent_session','params':{'pane_id':f'atomic-exe:{pane}','source':'herdr:atomic','agent':'atomic','seq':seq,'agent_session_id':session_id,'session_start_source':'sandbox-attach'}},
 {'id':f'atomic-exe:state:{seq+1}','method':'pane.report_agent','params':{'pane_id':f'atomic-exe:{pane}','source':'herdr:atomic','agent':'atomic','state':'idle','seq':seq+1,'agent_session_id':session_id}},
]
for request in requests:
 try:
  with socket.socket(socket.AF_UNIX) as s:
   s.settimeout(2); s.connect(path); s.sendall((json.dumps(request)+chr(10)).encode()); s.recv(4096)
 except OSError: pass
PY
    ;;
  *) echo 'usage: sessionctl <ensure [id]|new|focus id|attach id|detach|list|report-herdr id|reserve-transfer session-id|rollback-transfer id>' >&2; exit 2;;
esac
`;
