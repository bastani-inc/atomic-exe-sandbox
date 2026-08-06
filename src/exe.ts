import { spawnSync } from "node:child_process";
import { parseManifest } from "./manifest.js";
import { run, runAllowFailure } from "./process.js";
import type { DiscoveredSandbox, ExeVm, SandboxManifest } from "./types.js";

const SSH_BASE = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
export const VM_HOST_KEY_ARGS = ["-o", "HostKeyAlias=exe.dev"] as const;
function quote(value:string):string{return `'${value.replaceAll("'",`'"'"'`)}'`}
function remoteCommand(args:string[]):string{return args.map(quote).join(" ")}

export function exe(...args:string[]):string { return run("ssh",[...SSH_BASE,"exe.dev",remoteCommand(args)]).stdout }
export function vmSsh(vm:string,...args:string[]):string { return run("ssh",[...SSH_BASE,...VM_HOST_KEY_ARGS,`${vm}.exe.xyz`,remoteCommand(args)]).stdout }
export function vmSshAllowFailure(vm:string,...args:string[]){ return runAllowFailure("ssh",[...SSH_BASE,...VM_HOST_KEY_ARGS,`${vm}.exe.xyz`,remoteCommand(args)]) }
export function vmScript(vm:string,script:string,args:string[]=[]):string {
  const result=spawnSync("ssh",[...SSH_BASE,...VM_HOST_KEY_ARGS,`${vm}.exe.xyz`,remoteCommand(["bash","-s","--",...args])],{input:script,encoding:"utf8",stdio:["pipe","pipe","pipe"]});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`remote bootstrap failed (${result.status}): ${String(result.stderr||result.stdout).trim()}`);
  return String(result.stdout||"");
}
/**
 * A new VM answers SSH before its shell is routable; until then exe.dev replies on the
 * lobby REPL, which reports `command not found` for the bootstrap script.
 *
 * Measured against exe.dev: a fresh VM name becomes routable in seconds, but a name
 * reused immediately after `rm` stayed on the lobby for more than five minutes and did
 * not recover. VM names here are derived from the repository and branch, so destroying
 * a sandbox and recreating it reuses the same name and hits exactly that state. Waiting
 * longer does not help, so the wait is bounded and the error says what to do instead.
 */
export function waitForVmShell(vm:string,timeoutMs=180_000):void{
 const deadline=Date.now()+timeoutMs;let last="not reachable";let sawLobby=false;
 for(;;){
  const probe=vmSshAllowFailure(vm,"printf","atomic-exe-ready");
  const output=`${probe.stdout}${probe.stderr}`;
  if(probe.exitCode===0&&probe.stdout.includes("atomic-exe-ready")&&!/exe\.dev repl/i.test(output))return;
  if(/exe\.dev repl/i.test(output))sawLobby=true;
  last=(probe.stderr||probe.stdout).trim()||last;
  if(Date.now()>=deadline)throw new Error(
   `VM ${vm} did not present a shell within ${Math.round(timeoutMs/1000)}s: ${last.slice(0,200)}`+
   (sawLobby?`\nexe.dev kept answering on its lobby REPL, which happens when a VM name is reused soon after the previous VM of that name was deleted. The VM exists and is billable: delete it with 'exe.dev rm ${vm}', then either wait before recreating this branch's sandbox or work from a differently named branch.`:"")
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2_000);
 }
}
export function listVms():ExeVm[]{const parsed=JSON.parse(exe("ls","--json")) as {vms:ExeVm[]};return parsed.vms??[]}
export interface ExeIntegration { name:string; type:string; team?:boolean; attachments?:string[]; config?:{repositories?:string[]} }
/** How the repository's GitHub integration must be bound to a new VM. */
export interface GithubIntegration { name:string; team:boolean; tags:string[] }
export function listIntegrations():ExeIntegration[]{return JSON.parse(exe("integrations","list","--json"))}
/** Pure selection step, split out from the network call so it can be unit tested. */
export function selectGithubIntegration(integrations:ExeIntegration[],owner:string,repo:string):GithubIntegration{
 const wanted=`${owner}/${repo}`.toLowerCase();const found=integrations.find(i=>i.type==="github"&&i.config?.repositories?.some(r=>r.toLowerCase()===wanted));
 if(!found)throw new Error(`no exe.dev GitHub integration grants access to ${owner}/${repo}`);
 const tags=(found.attachments??[]).filter(a=>a.startsWith("tag:")).map(a=>a.slice(4)).filter(Boolean);
 if(found.team===true&&tags.length===0)throw new Error(`exe.dev team integration '${found.name}' is not attached to a tag; team integrations attach only by tag. Run: integrations attach ${found.name} tag:<name>`);
 return{name:found.name,team:found.team===true,tags};
}
export function githubIntegration(owner:string,repo:string):GithubIntegration{return selectGithubIntegration(listIntegrations(),owner,repo)}
export function readManifest(vm:ExeVm):DiscoveredSandbox{
 const result=vmSshAllowFailure(vm.vm_name,"sh","-lc",`set -eu; d=$HOME/.atomic-exe; f=$d/manifest.json; [ \"$(stat -c %U:%a \"$d\")\" = \"exedev:700\" ]; [ \"$(stat -c %U:%a \"$f\")\" = \"exedev:600\" ]; [ ! -L \"$d\" ] && [ ! -L \"$f\" ]; cat \"$f\"`);
 if(result.exitCode!==0)return{vm,health:"unreachable",detail:result.stderr.trim()||"manifest unavailable"};
 try{const manifest=parseManifest(JSON.parse(result.stdout),vm.vm_name);return{vm,manifest,health:manifest.state}}
 catch(error){return{vm,health:"invalid",detail:(error as Error).message}}
}
export function discover():DiscoveredSandbox[]{return listVms().filter(vm=>vm.tags?.includes("atomic-sandbox")).map(readManifest)}
export function findByIdentity(identity:string):DiscoveredSandbox|undefined{return discover().find(s=>s.manifest?.identity===identity)}
/** Pure argument construction, split out from the network call so it can be unit tested. */
export function vmCreateArgs(vmName:string,tags:string[],integration:GithubIntegration):string[]{
 // exe.dev binds team integrations by tag only; --integration would request a vm: attachment,
 // which exe.dev rejects for team integrations. Carry the integration's tags instead.
 const merged=[...new Set([...tags,...(integration.team?integration.tags:[])])];
 const attach=integration.team?[]:[`--integration=${integration.name}`];
 return["new",`--name=${vmName}`,"--no-email","--json",`--comment=atomic-exe-sandbox creating`,...attach,...merged.map(t=>`--tag=${t}`)];
}
export function createVm(vmName:string,tags:string[],integration:GithubIntegration):ExeVm{
 const value=JSON.parse(exe(...vmCreateArgs(vmName,tags,integration)));return (value.vm??value) as ExeVm;
}
export function deleteVm(vmName:string):void{exe("rm",vmName,"--json")}
export function setComment(vmName:string,text:string):void{exe("comment",vmName,text,"--json")}
export function manifestMatches(manifest:SandboxManifest,identity:string):boolean{return manifest.identity===identity}
