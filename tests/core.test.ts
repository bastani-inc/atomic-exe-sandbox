import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseGitHubRemote } from "../src/git.js";
import { identityForGit, slug } from "../src/identity.js";
import { parseManifest } from "../src/manifest.js";
import { CHECKOUT_ROOT, HERDR_SESSION_NAME, MANIFEST_SCHEMA } from "../src/types.js";

describe("identity",()=>{
 test("is stable for repo and branch across paths",()=>{const a=identityForGit({canonicalRepo:"github.com/y-n-lab/lapersona.ai",branchRef:"refs/heads/preview",repo:"lapersona.ai",branch:"preview"});const b=identityForGit({canonicalRepo:"github.com/y-n-lab/lapersona.ai",branchRef:"refs/heads/preview",repo:"lapersona.ai",branch:"preview"});expect(a.id).toBe(b.id);expect(a.vmName).toMatch(/^atomic-lapersona-ai-preview-[a-f0-9]{12}$/)})
 test("changes with branch",()=>{const base={canonicalRepo:"github.com/a/r",repo:"r"};expect(identityForGit({...base,branch:"a",branchRef:"refs/heads/a"}).id).not.toBe(identityForGit({...base,branch:"b",branchRef:"refs/heads/b"}).id)})
 test("slug is hostname-safe",()=>expect(slug("Feature/YN-123: Café")).toBe("feature-yn-123-caf"))
 test("tags identify atomic sandboxes",()=>expect(identityForGit({canonicalRepo:"github.com/a/r",branchRef:"refs/heads/main",repo:"r",branch:"main"}).tags[0]).toBe("atomic-sandbox"))
})
describe("GitHub remotes",()=>{for(const remote of ["git@github.com:Y-N-Lab/lapersona.ai.git","https://github.com/Y-N-Lab/lapersona.ai.git","ssh://git@github.com/Y-N-Lab/lapersona.ai.git"])test(remote,()=>expect(parseGitHubRemote(remote)).toEqual({owner:"Y-N-Lab",repo:"lapersona.ai",canonicalRepo:"github.com/y-n-lab/lapersona.ai"}));test("rejects non GitHub",()=>expect(()=>parseGitHubRemote("https://example.com/x/y.git")).toThrow())})
describe("manifest",()=>{const id="a".repeat(64),base={schemaVersion:MANIFEST_SCHEMA,identity:id,vmName:"atomic-test",canonicalRepo:"github.com/a/r",owner:"a",repo:"r",branchRef:"refs/heads/main",branch:"main",creationCommit:"b".repeat(40),checkoutPath:`${CHECKOUT_ROOT}/${id}/repo`,state:"ready",createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"} as const;test("accepts fixed-root manifest",()=>expect(parseManifest(base,"atomic-test").identity).toBe(id));test("rejects traversal",()=>expect(()=>parseManifest({...base,checkoutPath:`${CHECKOUT_ROOT}/${id}/../evil`})).toThrow("escapes"));test("rejects VM mismatch",()=>expect(()=>parseManifest(base,"other")).toThrow("mismatch"))})

describe("hostile identity input",()=>{
 test("branch metacharacters affect data only",()=>{const result=identityForGit({canonicalRepo:"github.com/a/r",branchRef:"refs/heads/x$(touch-pwn)",repo:"r",branch:"x$(touch-pwn)"});expect(result.vmName).toMatch(/^atomic-r-x-touch-pwn-[a-f0-9]{12}$/);expect(result.id).toHaveLength(64)})
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
 test("rejects non-string ids",()=>expect(()=>parseSession({...legacy,paneId:3})).toThrow("paneId"))
 test("rejects empty ids",()=>expect(()=>parseSession({...legacy,tabId:""})).toThrow("tabId"))
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
 test("reuses a restored pane instead of leaving a duplicate tab",()=>{expect(SESSIONCTL).toContain(`  if [ -n "$pane" ] && herdr_cli pane get "$pane" >/dev/null 2>&1; then`);expect(SESSIONCTL).toContain(`command="cd '$checkout'; export ATOMIC_EXE_SESSION_ID='$id' GH_HOST=github.int.exe.xyz COLORTERM=truecolor;`);expect(SESSIONCTL).toContain(`    herdr_cli tab rename "$tab" "$id" >/dev/null\n    close_stale_tab "$stale_tab" "$tab"`);expect(SESSIONCTL).toContain("case \"$output\" in *tab_not_found*) return 0;; esac")})
 test("keeps every state path off the replaced multiplexer",()=>{for(const legacy of LEGACY_COMMANDS)expect(SESSIONCTL).not.toContain(legacy);expect(SESSIONCTL).toContain("$HOME/.local/bin")})
})
describe("remote provisioning and lifecycle guards",()=>{
 test("provisioning installs herdr",()=>expect(REMOTE_SOURCE).toContain("curl -fsSL https://herdr.dev/install.sh | sh"))
 test("provisioning puts the herdr install dir on PATH",()=>expect(REMOTE_SOURCE).toContain(`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`))
 test("provisioning installs the atomic agent, which the exe.dev image does not ship",()=>{expect(REMOTE_SOURCE).toContain(`  "$HOME/.bun/bin/bun" install -g @bastani/atomic`);expect(REMOTE_SOURCE.indexOf("install -g @bastani/atomic")).toBeGreaterThan(REMOTE_SOURCE.indexOf("apt-get install -y -qq nodejs"))})
 test("provisioning refuses to finish without a working atomic binary",()=>{expect(REMOTE_SOURCE).toContain("command -v atomic >/dev/null 2>&1 || { echo 'Atomic agent install failed: no atomic binary on PATH (looked in $HOME/.local/bin and $HOME/.bun/bin)' >&2; exit 1; }");expect(REMOTE_SOURCE).toContain("atomic --version >/dev/null 2>&1 || { echo 'Atomic agent is installed but not executable; check that node 20 or newer is on PATH' >&2; exit 1; }")})
 test("the bun global bin directory that receives the atomic binary is on PATH everywhere",()=>{expect(REMOTE_SOURCE).toContain(`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`);expect(SESSIONCTL).toContain(`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`)})
 test("starting a session refuses when atomic is missing",()=>expect(SESSIONCTL).toContain(`command -v atomic >/dev/null 2>&1 || { echo 'atomic is not installed in this sandbox: expected the agent on PATH ($HOME/.local/bin or $HOME/.bun/bin)' >&2; exit 1; }`))
 test("destroy and clean refuse to run while a client holds the attach lease",()=>{expect(REMOTE_SOURCE).toContain("flock -n -x 8 || { echo 'Atomic sandbox has attached clients' >&2; exit 1; }");expect(REMOTE_SOURCE.match(/\$\{ATTACH_GUARD\}/g)?.length).toBe(2)})
 test("destroy stops the herdr session instead of the replaced multiplexer",()=>{expect(REMOTE_SOURCE).toContain("herdr session stop ${HERDR_SESSION_NAME}");for(const legacy of LEGACY_COMMANDS)expect(REMOTE_SOURCE).not.toContain(legacy)})
 test("host key pinning survives in the attach path",()=>{const sandbox=readFileSync(new URL("../src/sandbox.ts",import.meta.url),"utf8");expect(sandbox).toContain("VM_HOST_KEY_ARGS");expect(sandbox).toContain("sessionctl attach");expect(sandbox).not.toContain(`"--remote"`)})
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
