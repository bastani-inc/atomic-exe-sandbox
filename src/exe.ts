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
export function listVms():ExeVm[]{const parsed=JSON.parse(exe("ls","--json")) as {vms:ExeVm[]};return parsed.vms??[]}
export function listIntegrations():Array<{name:string;type:string;config?:{repositories?:string[]}}>{return JSON.parse(exe("integrations","list","--json"))}
export function githubIntegration(owner:string,repo:string):string{
 const wanted=`${owner}/${repo}`.toLowerCase();const found=listIntegrations().find(i=>i.type==="github"&&i.config?.repositories?.some(r=>r.toLowerCase()===wanted));
 if(!found)throw new Error(`no exe.dev GitHub integration grants access to ${owner}/${repo}`);return found.name;
}
export function readManifest(vm:ExeVm):DiscoveredSandbox{
 const result=vmSshAllowFailure(vm.vm_name,"sh","-lc",`set -eu; d=$HOME/.atomic-exe; f=$d/manifest.json; [ \"$(stat -c %U:%a \"$d\")\" = \"exedev:700\" ]; [ \"$(stat -c %U:%a \"$f\")\" = \"exedev:600\" ]; [ ! -L \"$d\" ] && [ ! -L \"$f\" ]; cat \"$f\"`);
 if(result.exitCode!==0)return{vm,health:"unreachable",detail:result.stderr.trim()||"manifest unavailable"};
 try{const manifest=parseManifest(JSON.parse(result.stdout),vm.vm_name);return{vm,manifest,health:manifest.state}}
 catch(error){return{vm,health:"invalid",detail:(error as Error).message}}
}
export function discover():DiscoveredSandbox[]{return listVms().filter(vm=>vm.tags?.includes("atomic-sandbox")).map(readManifest)}
export function findByIdentity(identity:string):DiscoveredSandbox|undefined{return discover().find(s=>s.manifest?.identity===identity)}
export function createVm(vmName:string,tags:string[],integration:string):ExeVm{
 const args=["new",`--name=${vmName}`,"--no-email","--json",`--comment=atomic-exe-sandbox creating`, `--integration=${integration}`,...tags.map(t=>`--tag=${t}`)];
 const value=JSON.parse(exe(...args));return (value.vm??value) as ExeVm;
}
export function deleteVm(vmName:string):void{exe("rm",vmName,"--json")}
export function setComment(vmName:string,text:string):void{exe("comment",vmName,text,"--json")}
export function manifestMatches(manifest:SandboxManifest,identity:string):boolean{return manifest.identity===identity}
