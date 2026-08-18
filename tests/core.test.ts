import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseGitHubRemote } from "../src/git.js";
import { identityForGit, slug } from "../src/identity.js";
import { parseManifest } from "../src/manifest.js";
import { CHECKOUT_ROOT, HERDR_SESSION_NAME, MANIFEST_SCHEMA } from "../src/types.js";

describe("identity",()=>{
 test("is stable for repo and branch across paths",()=>{const a=identityForGit({canonicalRepo:"github.com/y-n-lab/lapersona.ai",branchRef:"refs/heads/preview",repo:"lapersona.ai",branch:"preview"});const b=identityForGit({canonicalRepo:"github.com/y-n-lab/lapersona.ai",branchRef:"refs/heads/preview",repo:"lapersona.ai",branch:"preview"});expect(a.id).toBe(b.id);expect(a.vmNameBase).toBe(b.vmNameBase);expect(a.vmNameBase).toMatch(/^atomic-lapersona-ai-preview-[a-f0-9]{12}$/)})
 test("changes with branch",()=>{const base={canonicalRepo:"github.com/a/r",repo:"r"};expect(identityForGit({...base,branch:"a",branchRef:"refs/heads/a"}).id).not.toBe(identityForGit({...base,branch:"b",branchRef:"refs/heads/b"}).id)})
 test("slug is hostname-safe",()=>expect(slug("Feature/YN-123: Café")).toBe("feature-yn-123-caf"))
 test("tags identify atomic sandboxes",()=>expect(identityForGit({canonicalRepo:"github.com/a/r",branchRef:"refs/heads/main",repo:"r",branch:"main"}).tags[0]).toBe("atomic-sandbox"))
})
describe("GitHub remotes",()=>{for(const remote of ["git@github.com:Y-N-Lab/lapersona.ai.git","https://github.com/Y-N-Lab/lapersona.ai.git","ssh://git@github.com/Y-N-Lab/lapersona.ai.git"])test(remote,()=>expect(parseGitHubRemote(remote)).toEqual({owner:"Y-N-Lab",repo:"lapersona.ai",canonicalRepo:"github.com/y-n-lab/lapersona.ai"}));test("rejects non GitHub",()=>expect(()=>parseGitHubRemote("https://example.com/x/y.git")).toThrow())})
describe("manifest",()=>{const id="a".repeat(64),base={schemaVersion:MANIFEST_SCHEMA,identity:id,vmName:"atomic-test",canonicalRepo:"github.com/a/r",owner:"a",repo:"r",branchRef:"refs/heads/main",branch:"main",creationCommit:"b".repeat(40),checkoutPath:`${CHECKOUT_ROOT}/${id}/repo`,state:"ready",createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"} as const;test("accepts fixed-root manifest",()=>expect(parseManifest(base,"atomic-test").identity).toBe(id));test("rejects traversal",()=>expect(()=>parseManifest({...base,checkoutPath:`${CHECKOUT_ROOT}/${id}/../evil`})).toThrow("escapes"));test("rejects VM mismatch",()=>expect(()=>parseManifest(base,"other")).toThrow("mismatch"))})

describe("hostile identity input",()=>{
 test("branch metacharacters affect data only",()=>{const result=identityForGit({canonicalRepo:"github.com/a/r",branchRef:"refs/heads/x$(touch-pwn)",repo:"r",branch:"x$(touch-pwn)"});expect(result.vmNameBase).toMatch(/^atomic-r-x-touch-pwn-[a-f0-9]{12}$/);expect(result.id).toHaveLength(64)})
})

import { allocateSession, emptyRegistry, parseRegistry, parseSession } from "../src/sessions.js";
describe("numbered sandbox sessions",()=>{
 test("starts with session one",()=>{const value=emptyRegistry("one");expect(value.lastId).toBe(1);expect(value.nextId).toBe(2);expect(value.sessions["1"].sessionId).toBe("one")})
 test("allocates monotonically without names",()=>{const value=emptyRegistry("one");expect(allocateSession(value,"two").id).toBe(2);expect(allocateSession(value,"three").id).toBe(3);expect(value.lastId).toBe(3);expect(value.nextId).toBe(4)})
 test("rejects mismatched keys",()=>{const value=emptyRegistry("one");value.sessions["2"]=value.sessions["1"];expect(()=>parseRegistry(value)).toThrow("#2")})
})

describe("herdr object ids in the registry",()=>{
 const legacy={id:1,sessionId:"one",createdAt:"2026-01-01T00:00:00Z"};
 test("accepts rows written before herdr",()=>{const row=parseSession(legacy);expect(row.workspaceId).toBeUndefined();expect(row.tabId).toBeUndefined();expect(row.paneId).toBeUndefined()})
 test("accepts a registry of rows written before herdr",()=>expect(parseRegistry({version:1,nextId:2,lastId:1,sessions:{"1":legacy}}).sessions["1"].paneId).toBeUndefined())
 test("preserves opaque ids verbatim",()=>{const row=parseSession({...legacy,workspaceId:"w7",tabId:"w7:t3",paneId:"w7:p9"});expect(row.workspaceId).toBe("w7");expect(row.tabId).toBe("w7:t3");expect(row.paneId).toBe("w7:p9")})
 test("preserves a node branch and worktree path",()=>{const row=parseSession({...legacy,branch:"atomic-node/auth",worktreePath:"/home/exedev/atomic-sandboxes/id/wt-2"});expect(row.branch).toBe("atomic-node/auth");expect(row.worktreePath).toBe("/home/exedev/atomic-sandboxes/id/wt-2")})
 test("rejects non-string ids",()=>expect(()=>parseSession({...legacy,paneId:3})).toThrow("paneId"))
 test("rejects empty ids",()=>expect(()=>parseSession({...legacy,tabId:""})).toThrow("tabId"))
 test("rejects empty node branches",()=>expect(()=>parseSession({...legacy,branch:""})).toThrow("branch"))
 test("rejects invalid ids inside a registry",()=>expect(()=>parseRegistry({version:1,nextId:2,lastId:1,sessions:{"1":{...legacy,workspaceId:{}}}})).toThrow("workspaceId"))
})

import { rewriteSessionCwd, SESSIONCTL } from "../src/sessions.js";
describe("session transfer",()=>{
 test("rewrites only header cwd and preserves remaining bytes",()=>{const body=Buffer.from('{"type":"custom","data":{"text":"á\\n"}}\n');const source=Buffer.concat([Buffer.from('{"type":"session","version":3,"id":"abc","cwd":"/local"}\n'),body]);const result=rewriteSessionCwd(source,"/remote");const newline=result.indexOf(10);expect(JSON.parse(result.subarray(0,newline).toString()).cwd).toBe("/remote");expect(result.subarray(newline+1).equals(body)).toBe(true)})
 test("rejects invalid header",()=>expect(()=>rewriteSessionCwd(Buffer.from('{}\n'),"/remote")).toThrow("header"))
})

const REMOTE_SOURCE=readFileSync(new URL("../src/remote.ts",import.meta.url),"utf8");
const INDEX_SOURCE=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
// Command fragments of the multiplexer this project replaced. Asserting their absence
// keeps the regression meaningful without reconstructing the retired name.
const LEGACY_COMMANDS=["has-session","new-session","new-window","select-window","move-window","list-windows","list-clients","send-keys -t","kill-session","pipe-pane","detach-client","set-environment"];
describe("herdr multiplexer control script",()=>{
 test("drives the named herdr session",()=>{expect(HERDR_SESSION_NAME).toBe("atomic-exe");expect(SESSIONCTL).toContain(`session=${HERDR_SESSION_NAME}`);expect(SESSIONCTL).toContain(`herdr_cli() { herdr --session "$session" "$@"; }`)})
 test("creates workspaces, tabs and panes through herdr",()=>{for(const command of ["workspace create","tab create","tab focus","tab rename","pane run","pane get","pane read"])expect(SESSIONCTL).toContain(`herdr_cli ${command}`)})
 test("reads object ids out of herdr command output",()=>{expect(SESSIONCTL).toContain(`< <(printf '%s' "$created" | herdr_ids)`);for(const field of ["workspace_id","tab_id","pane_id"])expect(SESSIONCTL).toContain(field)})
 test("moves opaque ids over NUL-delimited pipes",()=>{expect(SESSIONCTL).toContain(`{ IFS= read -r -d '' workspace; IFS= read -r -d '' tab; IFS= read -r -d '' pane; }`);expect(SESSIONCTL).toContain(`sys.stdout.write("".join(value+chr(0) for value in ids))`);expect(SESSIONCTL).toContain(`IFS= read -r -d '' value < <(`);expect(SESSIONCTL).toContain(`while IFS= read -r -d '' candidate; do`);expect(SESSIONCTL).not.toContain("cut -d' '");expect(SESSIONCTL).not.toContain(`.get(sys.argv[1]) or ""`)})
 test("treats a restored empty pane as stopped",()=>{expect(SESSIONCTL).toContain(`herdr_cli pane get "$pane" >/dev/null 2>&1 || return 1`);expect(SESSIONCTL).toContain(`marker_alive "$id"`);expect(SESSIONCTL).toContain("fields=stat[stat.rfind(')')+2:].split()");expect(SESSIONCTL).toContain("item['running']=bool(isinstance(pane,str) and pane in panes and marker_alive(key))");expect(SESSIONCTL).toContain(`if ! session_alive "$row"; then`)})
 test("the ready marker carries the atomic pid and its process start time",()=>{expect(INDEX_SOURCE).toContain("readFileSync(\"/proc/self/stat\", \"utf8\")");expect(INDEX_SOURCE).toContain("return `${process.pid} ${startTime}\\n`;");expect(INDEX_SOURCE).not.toContain("`${Date.now()}\\n`")})
 test("persists the captured ids per session",()=>{expect(SESSIONCTL).toContain("item['workspaceId'],item['tabId'],item['paneId']=sys.argv[2],sys.argv[3],sys.argv[4]");expect(SESSIONCTL).toContain(`persist_ids "$id" "$workspace" "$tab" "$pane"`)})
 test("attaching holds the shared attach lease and registers the client",()=>{expect(SESSIONCTL).toContain(`exec 8>"$root/attach.lock"`);expect(SESSIONCTL).toContain("flock -s 8");expect(SESSIONCTL).toContain(`printf '%s %s\\n' "$client" "$client_start" > "$root/clients/$client"`)})
 test("hands the attached client the real terminal on fd 0",()=>{expect(SESSIONCTL).toContain("exec 7<&0");expect(SESSIONCTL).toContain(`herdr --session "$session" <&7 8>&- 9>&- &`)})
 test("startup runs under the registry lock so concurrent ensures cannot duplicate a session",()=>{expect(SESSIONCTL).toContain(`    row=$(session_row "$id")\n    if ! session_alive "$row"; then\n      start_window "$row"\n      row=$(session_row "$id")\n    fi\n    flock -u 9`);expect(SESSIONCTL).toContain(`    start_window "$row"\n    row=$(session_row "$id")\n    flock -u 9`);expect(SESSIONCTL).not.toContain("\n  flock -x 9");expect(SESSIONCTL).not.toContain("\n  flock -u 9")})
 test("detach only signals a process that is still this session's herdr client",()=>{expect(SESSIONCTL).toContain("expected=['herdr','--session',session]");expect(SESSIONCTL).toContain("if len(parts)!=2 or parts[0]!=name or not parts[1].isdigit() or parts[1]!=start or argv!=expected:");expect(SESSIONCTL).toContain("os.kill(int(name),signal.SIGTERM)");expect(SESSIONCTL).toContain("no attached sandbox clients to detach");expect(SESSIONCTL).not.toContain("grep -qa herdr")})
 test("keeps startup output after herdr destroys the pane",()=>{expect(SESSIONCTL).toContain(`log="$root/atomic-start-$id.log"; install -m 600 /dev/null "$log"`);expect(SESSIONCTL).toContain(`exec script -qefc \\"$agent\\" '$log'`);expect(SESSIONCTL.match(/tail -n 200 "\$log" >&2/g)?.length).toBe(2);expect(SESSIONCTL).not.toContain(">&2 2>/dev/null")})
 test("reuses a restored pane instead of leaving a duplicate tab",()=>{expect(SESSIONCTL).toContain(`  if [ -n "$pane" ] && herdr_cli pane get "$pane" >/dev/null 2>&1; then`);expect(SESSIONCTL).toContain(`command="cd '$cwd'; export ATOMIC_EXE_SESSION_ID='$id' GH_HOST=github.int.exe.xyz COLORTERM=truecolor ATOMIC_CODING_AGENT_DIR=`);expect(SESSIONCTL).toContain(`    herdr_cli tab rename "$tab" "$id" >/dev/null\n    close_stale_tab "$stale_tab" "$tab"`);expect(SESSIONCTL).toContain("case \"$output\" in *tab_not_found*) return 0;; esac")})
 test("a spawned node gets its own worktree and can be prompted",()=>{expect(SESSIONCTL).toContain("ensure_worktree");expect(SESSIONCTL).toContain("wt-$id");expect(SESSIONCTL).toContain("pane send-text");expect(SESSIONCTL).toContain("git('diff','HEAD')")})
 test("keeps every state path off the replaced multiplexer",()=>{for(const legacy of LEGACY_COMMANDS)expect(SESSIONCTL).not.toContain(legacy);expect(SESSIONCTL).toContain("$HOME/.local/bin")})
})
describe("remote provisioning and lifecycle guards",()=>{
 test("provisioning installs herdr",()=>expect(REMOTE_SOURCE).toContain("curl -fsSL https://herdr.dev/install.sh | sh"))
 test("provisioning puts the herdr install dir on PATH",()=>expect(REMOTE_SOURCE).toContain(`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`))
 test("provisioning installs the atomic agent, which the exe.dev image does not ship",()=>{expect(REMOTE_SOURCE).toContain(`"$HOME/.bun/bin/bun" install -g "@bastani/atomic@$wanted"`);expect(REMOTE_SOURCE.indexOf("install -g")).toBeGreaterThan(REMOTE_SOURCE.indexOf("apt-get install -y -qq nodejs"))})
 test("provisioning pins Atomic to the host version",()=>{expect(REMOTE_SOURCE).toContain("hostAtomicVersion()");expect(REMOTE_SOURCE).toContain('[ "$installed" = "$wanted" ]')})
 test("provisioning refuses to finish without a working atomic binary",()=>{expect(REMOTE_SOURCE).toContain("command -v atomic >/dev/null 2>&1 || { echo 'Atomic agent install failed: no atomic binary on PATH (looked in $HOME/.local/bin and $HOME/.bun/bin)' >&2; exit 1; }");expect(REMOTE_SOURCE).toContain("Atomic install is $installed, wanted $wanted")})
 test("the bun global bin directory that receives the atomic binary is on PATH everywhere",()=>{expect(REMOTE_SOURCE).toContain(`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`);expect(SESSIONCTL).toContain(`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`)})
 test("starting a session refuses when atomic is missing",()=>expect(SESSIONCTL).toContain(`command -v atomic >/dev/null 2>&1 || { echo 'atomic is not installed in this sandbox: expected the agent on PATH ($HOME/.local/bin or $HOME/.bun/bin)' >&2; exit 1; }`))
 test("destroy and clean refuse to run while a client holds the attach lease",()=>{expect(REMOTE_SOURCE).toContain("flock -n -x 8 || { echo 'Atomic sandbox has attached clients' >&2; exit 1; }");expect(REMOTE_SOURCE.match(/\$\{ATTACH_GUARD\}/g)?.length).toBe(2)})
 test("destroy stops the herdr session instead of the replaced multiplexer",()=>{expect(REMOTE_SOURCE).toContain("herdr session stop ${HERDR_SESSION_NAME}");for(const legacy of LEGACY_COMMANDS)expect(REMOTE_SOURCE).not.toContain(legacy)})
 test("host key pinning survives in the attach path",()=>{
  const attach=readFileSync(new URL("../src/attach.ts",import.meta.url),"utf8");
  expect(attach).toContain("VM_HOST_KEY_ARGS");
  expect(attach).toContain("sessionctl attach");
  expect(attach).toContain("vmHost(vmName)");
  expect(SANDBOX_SOURCE).toContain("attachToSession");
  expect(SANDBOX_SOURCE).not.toContain(`"--remote"`);
  expect(SANDBOX_SOURCE).not.toContain("tui.stop()");
 });
})

import { hostAtomicVersion, parseAtomicVersion } from "../src/remote.js";
describe("the VM Atomic version is the host Atomic version",()=>{
 test("accepts a plain semver and a prerelease",()=>{expect(parseAtomicVersion("0.9.14-alpha.3\n")).toBe("0.9.14-alpha.3");expect(parseAtomicVersion("0.9.12")).toBe("0.9.12")})
 test("rejects junk so it cannot become an npm tag",()=>{for(const raw of ["","latest","@bastani/atomic","0.9","not a version"])expect(()=>parseAtomicVersion(raw)).toThrow("host Atomic version")})
 test("reads atomic --version from PATH",()=>{const version=hostAtomicVersion((_c,args)=>{expect(args).toEqual(["--version"]);return{status:0,stdout:"0.9.14-alpha.3\n"}});expect(version).toBe("0.9.14-alpha.3")})
 test("fails closed when atomic is missing",()=>expect(()=>hostAtomicVersion(()=>({status:127,stderr:"not found"}))).toThrow("atomic --version"))
})

import { noticeComponent } from "../src/index.js";
const ANSI=/\u001b\[[0-9;]*m/g;
const strip=(text:string)=>text.replace(ANSI,"");
const fakeTheme={fg:(_color:string,text:string)=>`\u001b[38;2;10;20;30m${text}\u001b[39m`,bg:(_color:string,text:string)=>`\u001b[48;2;1;2;3m${text}\u001b[49m`};
describe("transfer notice rendering",()=>{
 const first="Session continued in exe.dev sandbox #12",second="Run atomic --sandbox to continue where you left off.";
 const component=noticeComponent([{text:first,color:(text)=>fakeTheme.fg("accent",text)},{text:second,color:(text)=>fakeTheme.fg("dim",text)}],(text)=>fakeTheme.bg("customMessageBg",text));
 for(const width of [100,60,50,41]) test(`fills exactly ${width} visible columns`,()=>{const rendered=component.render(width);expect(rendered).toHaveLength(4);for(const line of rendered){expect(strip(line)).toHaveLength(width);expect(line.endsWith("\u001b[49m")).toBe(true)}})
 test("truncates long text instead of overflowing, keeping the colour reset",()=>{const line=component.render(20)[2];expect(strip(line)).toBe(` ${second.slice(0,18)} `);expect(line).toContain("\u001b[39m")})
 test("pads short text before colouring it",()=>{const line=component.render(100)[1];expect(line).toContain(first.padEnd(98));expect(strip(line)).toBe(` ${first.padEnd(98)} `)})
 test("degenerate widths stay inside the viewport",()=>{for(const width of [0,1,2])for(const line of component.render(width))expect(strip(line).length).toBeLessThanOrEqual(Math.max(width,0))})
})

import { selectGithubIntegration, vmCreateArgs, type ExeIntegration } from "../src/exe.js";
describe("exe.dev GitHub integration binding",()=>{
 // Verbatim shape returned by `integrations list --json`, including the auto:all defaults.
 const live:ExeIntegration[]=[
  {name:"notify",type:"notify",attachments:["auto:all"],config:{}},
  {name:"llm",type:"llm",attachments:["auto:all"],config:{}},
  {name:"reflection",type:"reflection",attachments:["auto:all"],config:{}},
  {name:"bastani-inc-atomic",type:"github",team:true,attachments:["tag:bastani-inc-atomic"],config:{repositories:["bastani-inc/atomic"]}},
 ];
 const personal:ExeIntegration[]=[{name:"blog",type:"github",attachments:["vm:other"],config:{repositories:["ghuser/blog"]}}];

 test("resolves a team integration to its tag",()=>expect(selectGithubIntegration(live,"bastani-inc","atomic")).toEqual({name:"bastani-inc-atomic",team:true,tags:["bastani-inc-atomic"]}));
 test("matches the repository case-insensitively",()=>expect(selectGithubIntegration(live,"BASTANI-INC","Atomic").name).toBe("bastani-inc-atomic"));
 test("ignores non-github integrations",()=>expect(()=>selectGithubIntegration(live,"someone","unrelated")).toThrow("no exe.dev GitHub integration"));
 test("rejects a team integration with no tag attachment",()=>expect(()=>selectGithubIntegration([{name:"orphan",type:"github",team:true,attachments:[],config:{repositories:["a/b"]}}],"a","b")).toThrow("attach only by tag"));

 test("a team integration is bound by tag, never by --integration",()=>{
  const args=vmCreateArgs("atomic-test",["atomic-sandbox"],{name:"bastani-inc-atomic",team:true,tags:["bastani-inc-atomic"]});
  expect(args.some(a=>a.startsWith("--integration="))).toBe(false);
  expect(args).toContain("--tag=bastani-inc-atomic");
  expect(args).toContain("--tag=atomic-sandbox");
 });
 test("a personal integration is still bound by name",()=>{
  const args=vmCreateArgs("atomic-test",["atomic-sandbox"],selectGithubIntegration(personal,"ghuser","blog"));
  expect(args).toContain("--integration=blog");
  expect(args).toContain("--tag=atomic-sandbox");
  expect(args.some(a=>a==="--tag=")).toBe(false);
 });
 test("does not duplicate a tag the sandbox already carries",()=>{
  const args=vmCreateArgs("atomic-test",["atomic-sandbox","shared"],{name:"x",team:true,tags:["shared"]});
  expect(args.filter(a=>a==="--tag=shared")).toHaveLength(1);
 });
 test("keeps the discovery tag so the sandbox stays findable",()=>{
  const args=vmCreateArgs("atomic-test",["atomic-sandbox"],{name:"x",team:true,tags:["other"]});
  expect(args).toContain("--tag=atomic-sandbox");
 });
})

import { parseGitHubRemote as parseRemote } from "../src/git.js";
describe("SSH alias remotes",()=>{
 // Mirrors ~/.ssh/config style aliases: `Host agit` -> `HostName github.com`.
 const resolve=(host:string)=>({agit:"github.com",ngit:"github.com",work:"gitlab.com"})[host];
 test("accepts an alias that resolves to github.com",()=>expect(parseRemote("agit:bastani-inc/atomic.git",resolve)).toEqual({owner:"bastani-inc",repo:"atomic",canonicalRepo:"github.com/bastani-inc/atomic"}));
 test("accepts an alias without the .git suffix",()=>expect(parseRemote("ngit:owner/repo",resolve).repo).toBe("repo"));
 test("rejects an alias that resolves elsewhere",()=>expect(()=>parseRemote("work:owner/repo",resolve)).toThrow("must be a GitHub repository"));
 test("rejects an unresolvable alias",()=>expect(()=>parseRemote("nope:owner/repo",resolve)).toThrow("must be a GitHub repository"));
 test("still rejects a non-GitHub URL",()=>expect(()=>parseRemote("https://example.com/x/y.git",resolve)).toThrow("must be a GitHub repository"));
 test("literal github.com forms do not need resolution",()=>{let called=false;const spy=(h:string)=>{called=true;return resolve(h)};expect(parseRemote("git@github.com:a/b.git",spy).owner).toBe("a");expect(called).toBe(false)});
})

// REMOTE_SOURCE is the remote.ts source; the provisioning script is a literal inside it.
describe("Atomic must not load the exe.dev image's Pi extension",()=>{
 // The exeuntu image ships a Pi-only exe-dev extension in ~/.pi/agent/extensions.
 // Atomic scans that legacy directory unless ATOMIC_CODING_AGENT_DIR is set, and the
 // extension fails to load under Atomic, which blocked session startup on a real VM.
 test("sessionctl pins the agent dir in its own environment",()=>expect(SESSIONCTL).toContain(`ATOMIC_CODING_AGENT_DIR="$HOME/.atomic/agent"`));
 test("every herdr pane is created with the agent dir pinned",()=>{const created=SESSIONCTL.match(/herdr_cli (tab|workspace) create [^\n]*/g)??[];expect(created.length).toBe(2);for(const line of created)expect(line).toContain(`--env "ATOMIC_CODING_AGENT_DIR=$HOME/.atomic/agent"`)});
 test("the agent command re-exports it, because a restored pane loses its environment",()=>expect(SESSIONCTL).toContain("ATOMIC_CODING_AGENT_DIR=\\\"\\$HOME/.atomic/agent\\\";"));
 test("provisioning pins it too",()=>expect(REMOTE_SOURCE).toContain(`ATOMIC_CODING_AGENT_DIR="$HOME/.atomic/agent"`));
 test("provisioning never deletes exe.dev's Pi files",()=>{expect(REMOTE_SOURCE).not.toContain(`rm -rf "$HOME/.pi"`);expect(REMOTE_SOURCE).not.toContain("rm -rf $HOME/.pi")});
})
describe("headless first run",()=>{
 // A sandbox session has no interactive user, so Atomic must never stop at the
 // first-run theme picker. Any truthy onboardedVersion short-circuits that flow.
 test("settings.json is written even when the VM has none",()=>expect(REMOTE_SOURCE).toContain("d=json.load(open(p)) if os.path.exists(p) else {}"));
 test("onboarding is marked complete",()=>expect(REMOTE_SOURCE).toContain("if not d.get('onboardedVersion'): d['onboardedVersion']="));
 test("an existing onboardedVersion is preserved",()=>expect(REMOTE_SOURCE).toContain("if not d.get('onboardedVersion')"));
})

const SANDBOX_SOURCE=readFileSync(new URL("../src/sandbox.ts",import.meta.url),"utf8");
const EXE_SOURCE=readFileSync(new URL("../src/exe.ts",import.meta.url),"utf8");
describe("a new VM is not usable the moment exe.dev returns",()=>{
 // Observed on a real create: exe.dev answered on its lobby REPL and the bootstrap
 // script came back as `exe.dev repl: command not found`, failing creation at random.
 test("creation waits for a real VM shell before the first remote step",()=>{
  const wait=SANDBOX_SOURCE.indexOf("waitForVmShell(vmName)");
  const create=SANDBOX_SOURCE.indexOf("createVm(vmName,");
  const bootstrap=SANDBOX_SOURCE.indexOf("bootstrapRepository(vmName,");
  expect(create).toBeGreaterThan(-1);expect(wait).toBeGreaterThan(create);expect(bootstrap).toBeGreaterThan(wait);
 });
 test("the probe requires output from the VM, not just a zero exit",()=>expect(EXE_SOURCE).toContain('probe.stdout.includes("atomic-exe-ready")'));
 test("a lobby REPL answer is never treated as ready",()=>expect(EXE_SOURCE).toContain("/exe\\.dev repl/i.test(output)"));
 test("the wait is bounded and reports the last error",()=>{expect(EXE_SOURCE).toContain("did not present a shell within");expect(EXE_SOURCE).toContain("timeoutMs=180_000")});
 test("a lobby answer produces an actionable message naming the billable VM",()=>{expect(EXE_SOURCE).toContain("sawLobby");expect(EXE_SOURCE).toContain("exists and is billable");expect(EXE_SOURCE).toContain("exe.dev rm ${vm}")});
})

import { rememberSshDest, vmHost, vmSshArgs, SSH_BASE } from "../src/exe.js";
const CONFIG_SOURCE=readFileSync(new URL("../src/config.ts",import.meta.url),"utf8");
const PROCESS_SOURCE=readFileSync(new URL("../src/process.ts",import.meta.url),"utf8");
describe("VM SSH destinations come from exe.dev",()=>{
 test("falls back to the constructed hostname when exe.dev said nothing",()=>expect(vmHost("never-seen")).toBe("never-seen.exe.xyz"));
 test("prefers the ssh_dest exe.dev returned",()=>{rememberSshDest({vm_name:"vm-a",ssh_dest:"vm-a.shard7.exe.xyz"});expect(vmHost("vm-a")).toBe("vm-a.shard7.exe.xyz")});
 test("accepts a user-qualified destination",()=>{rememberSshDest({vm_name:"vm-b",ssh_dest:"exedev@vm-b.exe.xyz"});expect(vmHost("vm-b")).toBe("exedev@vm-b.exe.xyz")});
 test("ignores a destination carrying a port or metacharacters",()=>{for(const bad of ["vm-c.exe.xyz:2222","vm-c.exe.xyz he","-oProxyCommand=x","' ; rm -rf /"]){rememberSshDest({vm_name:"vm-c",ssh_dest:bad});expect(vmHost("vm-c")).toBe("vm-c.exe.xyz")}});
 test("ignores a non-string destination",()=>{rememberSshDest({vm_name:"vm-d",ssh_dest:undefined});expect(vmHost("vm-d")).toBe("vm-d.exe.xyz")});

 test("every VM connection keeps host-key pinning and the shared timeouts",()=>{
  const args=vmSshArgs("vm-e");
  expect(args).toEqual([...SSH_BASE,"-o","HostKeyAlias=exe.dev","vm-e.exe.xyz"]);
  expect(args).toContain("BatchMode=yes");expect(args).toContain("ConnectTimeout=10");
 });
 test("the config transfer uses the shared prefix instead of building its own",()=>{
  expect(CONFIG_SOURCE).toContain("...vmSshArgs(vm)");
  expect(CONFIG_SOURCE).not.toContain("BatchMode=yes");
  expect(CONFIG_SOURCE).not.toContain(".exe.xyz");
 });
 test("exe.dev responses populate the destination cache",()=>{expect(EXE_SOURCE).toContain("for(const vm of vms)rememberSshDest(vm)");expect(EXE_SOURCE).toContain("rememberSshDest(vm);return vm")});
})
describe("a piped transfer explains its own failure",()=>{
 test("reports both exit codes, named by command",()=>expect(PROCESS_SOURCE).toContain("${source.command}=${lc}, ${sink.command}=${rc}"));
 test("reports both stderr streams, not whichever is truthy first",()=>{expect(PROCESS_SOURCE).toContain('filter(Boolean).join("; ")');expect(PROCESS_SOURCE).not.toContain("${le||re}")});
 test("says so explicitly when neither side spoke",()=>expect(PROCESS_SOURCE).toContain("neither command wrote to stderr"));
 test("swallows the EPIPE that a dead sink causes",()=>expect(PROCESS_SOURCE).toContain('right.stdin.on("error",()=>{})'));
 test("no longer hardcodes tar and ssh in the message",()=>expect(PROCESS_SOURCE).not.toContain("config transfer failed (tar="));
})

import { generationTag, newGeneration, vmNameFor } from "../src/identity.js";
import { claimMatches } from "../src/sandbox.js";
import type { DiscoveredSandbox, ExeVm, SandboxManifest } from "../src/types.js";
describe("a sandbox is claimed by tags, never by its name",()=>{
 // exe.dev keeps routing a recently deleted VM name at its lobby for minutes, so a
 // deterministic name made destroy-then-create produce an unreachable, billable VM.
 const git={canonicalRepo:"github.com/a/r",branchRef:"refs/heads/main",repo:"r",branch:"main"};
 const identity=identityForGit(git);
 const build=(over:Partial<ExeVm>&{manifest?:Partial<SandboxManifest>}={}):DiscoveredSandbox=>{
  const generation=over.manifest?.generation??"0123abcd";
  const vm:ExeVm={vm_name:"atomic-r-main-abc-0123abcd",status:"running",ssh_dest:"x.exe.xyz",tags:[...identity.tags,generationTag(generation)],...over};
  const manifest={identity:identity.id,canonicalRepo:git.canonicalRepo,branchRef:git.branchRef,generation,...over.manifest} as SandboxManifest;
  return{vm,manifest,health:"ready"};
 };

 test("generations are unique",()=>{const seen=new Set(Array.from({length:200},()=>newGeneration()));expect(seen.size).toBe(200);for(const g of seen)expect(g).toMatch(/^[a-f0-9]{8}$/)});
 test("a generated name stays inside exe.dev's 63-character limit",()=>{
  const long=identityForGit({canonicalRepo:"github.com/a/r",branchRef:"refs/heads/"+"b".repeat(80),repo:"r".repeat(60),branch:"b".repeat(80)});
  expect(vmNameFor(long,newGeneration()).length).toBeLessThanOrEqual(63);
 });
 test("two creations for the same branch never produce the same name",()=>expect(vmNameFor(identity,newGeneration())).not.toBe(vmNameFor(identity,newGeneration())));
 test("the name is not part of the match",()=>expect(claimMatches(build({vm_name:"something-entirely-different"}),identity,git)).toBe(true));
 test("a missing identity tag is not a match",()=>expect(claimMatches(build({tags:["atomic-sandbox"]}),identity,git)).toBe(false));
 test("another branch's identity is not a match",()=>expect(claimMatches(build({manifest:{identity:"f".repeat(64)}}),identity,git)).toBe(false));
 test("a manifest generation must still be tagged on the VM",()=>expect(claimMatches(build({tags:[...identity.tags,generationTag("deadbeef")],manifest:{generation:"0123abcd"}}),identity,git)).toBe(false));
 test("a manifest without a generation still matches, for sandboxes made before claims",()=>{
  const found=build();delete (found.manifest as {generation?:string}).generation;
  expect(claimMatches(found,identity,git)).toBe(true);
 });
 test("a VM with no manifest is never claimed",()=>{const found=build();found.manifest=undefined;expect(claimMatches(found,identity,git)).toBe(false)});
})
describe("claim fields survive manifest validation",()=>{
 const id="a".repeat(64);
 const base={schemaVersion:MANIFEST_SCHEMA,identity:id,vmName:"atomic-test",canonicalRepo:"github.com/a/r",owner:"a",repo:"r",branchRef:"refs/heads/main",branch:"main",creationCommit:"b".repeat(40),checkoutPath:`${CHECKOUT_ROOT}/${id}/repo`,state:"ready",createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"} as const;
 test("accepts a well-formed claim",()=>{const m=parseManifest({...base,generation:"0123abcd",account:"0".repeat(16)});expect(m.generation).toBe("0123abcd");expect(m.account).toBe("0".repeat(16))});
 test("still accepts a manifest with no claim at all",()=>expect(parseManifest(base).generation).toBeUndefined());
 test("rejects a malformed generation",()=>expect(()=>parseManifest({...base,generation:"nope"})).toThrow("generation is invalid"));
 test("rejects a malformed account fingerprint",()=>expect(()=>parseManifest({...base,account:"short"})).toThrow("account fingerprint is invalid"));
})
describe("the creating exe.dev account is recorded",()=>{
 test("creation fingerprints the account and stores it in the manifest",()=>{expect(SANDBOX_SOURCE).toContain("account=accountFingerprint()");expect(SANDBOX_SOURCE).toContain("{vmName,generation,account}")});
 test("another account cannot adopt or enter the sandbox",()=>expect(SANDBOX_SOURCE.match(/was created by a different exe\.dev account/g)?.length).toBe(2));
 test("the fingerprint is a hash, never the address itself",()=>{expect(EXE_SOURCE).toContain('createHash("sha256").update(email)');expect(EXE_SOURCE).not.toContain("accountCache=email")});
 test("creation tags the VM with its generation",()=>expect(SANDBOX_SOURCE).toContain("[...identity.tags,generationTag(generation)]"));
})

import { formatTransferPlan, portableTransferPlan, type TransferEntry } from "../src/config.js";
describe("only allowlisted config leaves the machine",()=>{
 // The transfer used to be a denylist, so anything new in the agent directory shipped by
 // default. run-history.jsonl — the same kind of data as the excluded sessions directory —
 // was reaching every sandbox because nobody had thought to exclude it.
 const listed=CONFIG_SOURCE.slice(CONFIG_SOURCE.indexOf("const AGENT_MEMBERS"),CONFIG_SOURCE.indexOf("MEMBER_EXCLUDES"));
 test("the agent directory is not shipped wholesale",()=>{expect(CONFIG_SOURCE).not.toContain('members=[".atomic/agent"]');expect(CONFIG_SOURCE).not.toContain("const EXCLUDES")});
 test("tar is given named members, not a directory plus excludes",()=>expect(CONFIG_SOURCE).toContain("plan.map(entry=>entry.path)"));
 for(const denied of ["run-history","sessions","cache","backups","trust.json","pi-crash"]) test(`${denied} is not on the allowlist`,()=>expect(listed).not.toContain(denied));
 for(const allowed of ["settings.json","auth.json","extensions","skills","prompts","themes"]) test(`${allowed} is on the allowlist`,()=>expect(listed).toContain(allowed));
 test("a transfer with nothing to send fails loudly instead of silently",()=>expect(CONFIG_SOURCE).toContain("nothing to transfer: none of"));

 test("the plan reports real paths and sizes for this machine",()=>{
  const plan=portableTransferPlan();
  for(const entry of plan){expect(entry.path.startsWith(".atomic/agent/")||entry.path===".agents/skills").toBe(true);expect(entry.bytes).toBeGreaterThanOrEqual(0)}
  expect(plan.some(e=>e.path.includes("run-history"))).toBe(false);
 });
 test("credential-shaped names are flagged",()=>{
  const entries:TransferEntry[]=[{path:".atomic/agent/auth.json",bytes:5039,secret:true},{path:".atomic/agent/settings.json",bytes:410,secret:false}];
  const text=formatTransferPlan(entries);
  expect(text).toContain("auth.json — 4.9 KB (secret)");
  expect(text).toContain("settings.json — 410 B");
  expect(text).toContain("total 5.3 KB");
 });
 test("the plan never carries file contents, only sizes",()=>{const plan=portableTransferPlan();for(const entry of plan)expect(Object.keys(entry).sort()).toEqual(["bytes","path","secret"])});
 test("an empty plan says so rather than rendering an empty list",()=>expect(formatTransferPlan([])).toBe("Nothing to transfer."));
 test("the user is shown the plan before approving the transfer",()=>{expect(SANDBOX_SOURCE).toContain("These paths will be streamed to");expect(SANDBOX_SOURCE).toContain("formatTransferPlan(plan)")});
 test("what actually went is reported afterwards",()=>expect(SANDBOX_SOURCE).toContain("formatTransferPlan(sent)"));
})

import { EXE_HOST_KEY_FINGERPRINT, formatChecks, knownHostFingerprints, sshFingerprint, type Check } from "../src/doctor.js";
describe("doctor preflight",()=>{
 // Every VM connection is validated against exe.dev's key through HostKeyAlias, so a
 // wrong or missing known_hosts entry fails with an error that never mentions host keys.
 const realKnownHosts="exe.dev ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDEKtEcRW8OBtro5B/MG+EaisD+ZVwwHFa5";
 test("computes an OpenSSH fingerprint without shelling out",()=>{
  const key=Buffer.from("hello world").toString("base64");
  expect(sshFingerprint(key)).toBe("SHA256:uU0nuZNNPgilLlLX2n2r+sSE7+N6U4DukIj3rOLvzek");
  expect(sshFingerprint(key)).not.toContain("=");
 });
 test("reads fingerprints out of known_hosts output",()=>{const got=knownHostFingerprints(`# comment\n${realKnownHosts}\n`);expect(got).toHaveLength(1);expect(got[0]).toMatch(/^SHA256:/)});
 test("ignores comments and blank lines",()=>expect(knownHostFingerprints("# a\n\n# b\n")).toHaveLength(0));
 test("pins the fingerprint exe.dev publishes",()=>expect(EXE_HOST_KEY_FINGERPRINT).toBe("SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo"));

 test("a failure carries a remediation",()=>{
  const checks:Check[]=[{name:"exe.dev host key",ok:false,detail:"no known_hosts entry",fix:"run `ssh exe.dev` once"}];
  const text=formatChecks(checks);
  expect(text).toContain("✗ exe.dev host key");
  expect(text).toContain("fix: run `ssh exe.dev` once");
  expect(text).toContain("1 of 1 checks failed.");
 });
 test("a clean run says so",()=>expect(formatChecks([{name:"a",ok:true,detail:"fine"}])).toContain("All 1 checks passed."));
 test("passing checks do not print a fix",()=>expect(formatChecks([{name:"a",ok:true,detail:"fine",fix:"unused"}])).not.toContain("fix:"));
 test("the command is wired up and advertised",()=>{expect(INDEX_SOURCE).toContain('command === "doctor"');expect(INDEX_SOURCE).toContain("destroy [--force]|doctor");expect(INDEX_SOURCE).toContain("prompt [id] <text>")});
})

import { formatSessions, type SessionStatus } from "../src/sessions.js";
import { ADVISORY, FAIL, PASS, type Paint, paintFor, PLAIN_PAINT, repaintAfterCommand, RUNNING, STOPPED } from "../src/ui.js";
import type { ExtensionContext } from "@bastani/atomic";
/** Tags instead of escape codes, so a test asserts which tone was chosen, not which theme. */
const tagged:Paint={ok:t=>`<ok>${t}</ok>`,bad:t=>`<bad>${t}</bad>`,warn:t=>`<warn>${t}</warn>`,accent:t=>`<accent>${t}</accent>`,dim:t=>`<dim>${t}</dim>`,bold:t=>`<bold>${t}</bold>`};
describe("command output carries its own colour",()=>{
 // ctx.ui.notify paints the whole message dim, so a report that is not coloured before
 // it is handed over reaches the user as one flat grey block.
 test("a passing check is green, a failing one red, an advisory amber",()=>{
  const text=formatChecks([
   {name:"local tools",ok:true,detail:"present"},
   {name:"host key",ok:false,detail:"missing",fix:"run `ssh exe.dev`"},
   {name:"ssh agent",ok:true,warn:true,detail:"no keys loaded"},
  ],tagged);
  expect(text).toContain(`<ok>${PASS} local tools</ok>`);
  expect(text).toContain(`<bad>${FAIL} host key</bad>`);
  expect(text).toContain(`<warn>${ADVISORY} ssh agent</warn>`);
  expect(text).toContain("<warn>fix: run `ssh exe.dev`</warn>");
 });
 test("the summary states the worst outcome in its own colour",()=>{
  expect(formatChecks([{name:"a",ok:false,detail:"x"}],tagged)).toContain("<bad>1 of 1 checks failed.</bad>");
  expect(formatChecks([{name:"a",ok:true,detail:"x"}],tagged)).toContain("<ok>All 1 checks passed.</ok>");
  expect(formatChecks([{name:"a",ok:true,warn:true,detail:"x"}],tagged)).toContain("<warn>1 advisory to review.</warn>");
 });
 test("an advisory never counts as a failure",()=>expect(formatChecks([{name:"a",ok:true,warn:true,detail:"x"}])).toContain("All 1 checks passed."));
 test("uncoloured output is the default, so print mode never emits escape codes",()=>{
  expect(formatChecks([{name:"a",ok:true,detail:"x"}])).not.toContain("\u001b[");
  expect(formatSessions([{id:1,sessionId:"s",createdAt:"t",running:true,attached:false}])).not.toContain("\u001b[");
 });
 test("a session reads by glyph and by colour",()=>{
  const sessions:SessionStatus[]=[
   {id:1,sessionId:"a",createdAt:"t",running:true,attached:true},
   {id:2,sessionId:"b",createdAt:"t",running:true,attached:false},
   {id:3,sessionId:"c",createdAt:"t",running:false,attached:false,transferred:true},
  ];
  const text=formatSessions(sessions,tagged);
  expect(text).toContain(`<accent>${RUNNING} #1</accent>`);
  expect(text).toContain(`<ok>${RUNNING} #2</ok>`);
  expect(text).toContain(`<dim>${STOPPED} #3</dim>`);
  expect(text).toContain("<dim>  transferred</dim>");
 });
 test("a headless context paints nothing",()=>expect(paintFor({hasUI:false} as unknown as ExtensionContext)).toBe(PLAIN_PAINT));
 test("a theme that lacks a colour still returns readable text",()=>{
  const broken={fg:()=>{throw new Error("Unknown theme color")},bold:()=>{throw new Error("no")}};
  const paint=paintFor({hasUI:true,ui:{theme:broken}} as unknown as ExtensionContext);
  expect(paint.ok("green")).toBe("green");
  expect(paint.bold("strong")).toBe("strong");
 });
})

describe("the Working indicator is taken down without a keystroke",()=>{
 // The host drops its spinner when the command resolves but never asks for a repaint,
 // and an engine-child extension cannot call requestRender, so a scheduled status write
 // is the only thing left that reaches the host after the command is over.
 const fakeCtx=()=>{const calls:Array<[string,string|undefined]>=[];return{calls,ctx:{hasUI:true,ui:{setStatus:(key:string,text:string|undefined)=>{calls.push([key,text])}}} as unknown as ExtensionContext}};
 test("nothing is written while the command is still running",()=>{const {calls,ctx}=fakeCtx();repaintAfterCommand(ctx);expect(calls).toHaveLength(0)});
 test("the repaint lands after the command resolves",async()=>{
  const {calls,ctx}=fakeCtx();
  repaintAfterCommand(ctx);
  await new Promise(resolve=>setTimeout(resolve,120));
  expect(calls.length).toBeGreaterThan(0);
  for(const [key,text] of calls){expect(key).toBe("atomic-exe-sandbox-repaint");expect(text).toBeUndefined()}
 });
 test("a headless run stays silent",async()=>{const calls:string[]=[];repaintAfterCommand({hasUI:false,ui:{setStatus:()=>calls.push("x")}} as unknown as ExtensionContext);await new Promise(resolve=>setTimeout(resolve,120));expect(calls).toHaveLength(0)});
 test("every command path schedules it, including the error path",()=>{
  expect(INDEX_SOURCE).toContain("} finally {\n\t\trepaintAfterCommand(ctx);\n\t}");
  expect(INDEX_SOURCE.match(/repaintAfterCommand\(ctx\);/g)?.length).toBe(2);
 });
})

import { isDirtyWorktree, parseWorktreeStatus } from "../src/git.js";
import {
	confirmDirtyWorktree,
	dirtyWorktreeDialog,
	worktreeWarningCopy,
} from "../src/worktree.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const ACTIVE_ROW_MARKER = "\u001B_atomic:active\u0007";

const ordinary = (xy: string, path: string) =>
	`1 ${xy} N... 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} ${"c".repeat(40)} ${path}`;

describe("a dirty worktree warns instead of failing closed", () => {
	test("classifies staged, unstaged, untracked, and unmerged paths", () => {
		const status = parseWorktreeStatus(
			[
				ordinary("M.", "src/staged.ts"),
				ordinary(".M", "src/unstaged.ts"),
				ordinary("MM", "src/both.ts"),
				"? new.ts",
				`2 R. N... 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} ${"c".repeat(40)} R100 renamed.ts\told.ts`,
				`u UU N... 100644 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} ${"c".repeat(40)} src/conflict.ts`,
			].join("\n"),
		);
		expect(status.staged).toEqual(["src/staged.ts", "src/both.ts", "renamed.ts", "src/conflict.ts"]);
		expect(status.unstaged).toEqual(["src/unstaged.ts", "src/both.ts", "src/conflict.ts"]);
		expect(status.untracked).toEqual(["new.ts"]);
		expect(status.unmerged).toEqual(["src/conflict.ts"]);
		expect(isDirtyWorktree(status)).toBe(true);
	});
	test("a clean porcelain is not dirty", () => {
		expect(isDirtyWorktree(parseWorktreeStatus(""))).toBe(false);
		expect(isDirtyWorktree(parseWorktreeStatus("\n"))).toBe(false);
	});
	test("unquotes C-style paths", () => {
		expect(parseWorktreeStatus('? "file with space.ts"').untracked).toEqual([
			"file with space.ts",
		]);
	});
	test("the warning names what is dirty and that it will not be copied", () => {
		const copy = worktreeWarningCopy({
			staged: ["a.ts"],
			unstaged: ["b.ts", "c.ts"],
			untracked: ["d.ts"],
			unmerged: [],
		});
		expect(copy.title).toBe("Local work stays here");
		expect(copy.summary).toBe(
			"This branch has 1 staged path, 2 unstaged paths, and 1 untracked path.",
		);
		expect(copy.consequence).toContain("None of this local work is copied");
		expect(copy.stayLabel).toBe("Stay here");
		expect(copy.proceedLabel).toBe("Enter sandbox");
		expect(copy.samples).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
	});
	test("long dirty lists keep four sample paths and a remainder", () => {
		const copy = worktreeWarningCopy({
			staged: ["a", "b", "c", "d", "e"],
			unstaged: [],
			untracked: [],
			unmerged: [],
		});
		expect(copy.samples).toEqual(["a", "b", "c", "d", "and 1 more"]);
	});
	test("inspectPublishedGit no longer refuses a dirty worktree", () => {
		const git = readFileSync(new URL("../src/git.ts", import.meta.url), "utf8");
		expect(git).toContain("export function parseWorktreeStatus");
		expect(git).not.toContain("commit before entering the sandbox");
	});
	test("slash sandbox asks before entering, creating, transferring, or auto-connecting", () => {
		expect(INDEX_SOURCE.match(/allowDirtyWorktree\(ctx\)/g)?.length).toBe(4);
		expect(INDEX_SOURCE).toContain("if (!(await allowDirtyWorktree(ctx))) return;");
		expect(INDEX_SOURCE).toContain("Sandbox auto-connect skipped");
	});
	test("doctor treats leftover local work as an advisory", () => {
		const doctor = readFileSync(new URL("../src/doctor.ts", import.meta.url), "utf8");
		expect(doctor).toContain("inspectWorktree(cwd)");
		expect(doctor).toContain("warn: dirty");
		expect(doctor).toContain("local work will not be cloned");
	});
});

describe("the dirty worktree dialog is a reserved pi-tui overlay", () => {
	const status = {
		staged: ["src/a.ts"],
		unstaged: ["src/b.ts"],
		untracked: ["scratch.md"],
		unmerged: [],
	};
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `*${text}*`,
	};
	const keybindings = {
		getKeys: (id: string) =>
			(
				{
					"tui.select.up": ["up"],
					"tui.select.down": ["down"],
					"tui.select.confirm": ["enter"],
					"tui.select.cancel": ["escape", "ctrl+c"],
				} as Record<string, string[]>
			)[id] ?? [],
	};
	const tui = { requestRender() {} };
	const dialog = () =>
		dirtyWorktreeDialog(
			status,
			tui as never,
			theme as never,
			keybindings as never,
			() => {},
		);

	test("every line stays inside the viewport, including a degenerate width", () => {
		const component = dialog();
		for (const width of [0, 1, 2, 40, 60, 80]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(width, 1));
			}
		}
	});
	test("the heading is a warning, and the selected row carries the overlay mark", () => {
		const lines = dialog().render(80);
		const frame = lines.join(" ").replace(/\s+/g, " ");
		expect(frame).toContain("<warning>*Local work stays here*</warning>");
		expect(frame).toContain("None of this local work is copied");
		expect(frame).toContain("Stay here");
		expect(frame).toContain("Enter sandbox");
		const marked = lines.filter((line) => line.includes(ACTIVE_ROW_MARKER));
		expect(marked).toHaveLength(1);
		expect(marked[0]).toContain("Stay here");
	});
	test("without a UI the old fail-closed error remains", async () => {
		await expect(
			confirmDirtyWorktree(
				{ hasUI: false } as unknown as ExtensionContext,
				status,
			),
		).rejects.toThrow("commit before entering the sandbox");
	});
	test("tui mode mounts a reserved bottom overlay", async () => {
		let options: { overlay?: boolean; reserveTranscriptRows?: boolean; handlesCtrlC?: boolean } | undefined;
		const ok = await confirmDirtyWorktree(
			{
				hasUI: true,
				mode: "tui",
				ui: {
					custom: async (_factory: unknown, opts: typeof options) => {
						options = opts;
						return false;
					},
				},
			} as unknown as ExtensionContext,
			status,
		);
		expect(ok).toBe(false);
		expect(options).toMatchObject({
			overlay: true,
			reserveTranscriptRows: true,
			handlesCtrlC: true,
		});
	});
	test("non-tui UI falls back to confirm with the same warning copy", async () => {
		const copy = worktreeWarningCopy(status);
		let title = "";
		let message = "";
		const ok = await confirmDirtyWorktree(
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					confirm: async (givenTitle: string, givenMessage: string) => {
						title = givenTitle;
						message = givenMessage;
						return true;
					},
				},
			} as unknown as ExtensionContext,
			status,
		);
		expect(ok).toBe(true);
		expect(title).toBe(copy.confirmTitle);
		expect(message).toBe(copy.confirmMessage);
	});
});
