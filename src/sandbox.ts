import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { formatTransferPlan, portableTransferPlan, transferPortableConfig, validatePortableConfig } from "./config.js";
import { accountFingerprint, createVm, deleteVm, discover, githubIntegration, setComment, vmSshAllowFailure, waitForVmShell, VM_HOST_KEY_ARGS } from "./exe.js";
import { inspectGitIdentity, inspectPublishedGit } from "./git.js";
import { generationTag, identityForGit, newGeneration, vmNameFor } from "./identity.js";
import { startHerdrBridge } from "./herdr.js";
import { bootstrapRepository, cleanSandbox, finalize, guardDestroy, initialManifest, markManifestError } from "./remote.js";
import { ensureRemoteSession, initializeSessions, listRemoteSessions, type SandboxSession } from "./sessions.js";
import type { DiscoveredSandbox, GitContext, SandboxIdentity } from "./types.js";

const PROGRESS_KEY="atomic-exe-sandbox-progress";
async function progress(ctx:ExtensionContext,message:string):Promise<void>{
 if(!ctx.hasUI)return;
 const text=`⏳ exe.dev · ${message}`;
 ctx.ui.setStatus(PROGRESS_KEY,text);
 ctx.ui.setWidget(PROGRESS_KEY,["",text],{placement:"aboveEditor"});
 await new Promise(resolve=>setTimeout(resolve,50));
}
export function clearProgress(ctx:ExtensionContext):void{
 if(!ctx.hasUI)return;
 ctx.ui.setStatus(PROGRESS_KEY,undefined);
 ctx.ui.setWidget(PROGRESS_KEY,undefined);
}

/**
 * A VM is matched by its identity tag and manifest, never by its name. The name is unique
 * per creation so that destroying and recreating a branch's sandbox never reuses a name
 * exe.dev is still routing to its lobby.
 */
export function claimMatches(found:DiscoveredSandbox,identity:SandboxIdentity,git:Pick<GitContext,"canonicalRepo"|"branchRef">):boolean{
 const {vm,manifest}=found;
 if(!manifest)return false;
 if(!vm.tags?.includes(identity.idTag))return false;
 if(manifest.identity!==identity.id||manifest.canonicalRepo!==git.canonicalRepo||manifest.branchRef!==git.branchRef)return false;
 // A generation recorded in the manifest must still be the one tagged on the VM.
 if(manifest.generation&&!vm.tags.includes(generationTag(manifest.generation)))return false;
 return true;
}
export function exactSandbox(cwd:string):DiscoveredSandbox{
 const git=inspectGitIdentity(cwd),identity=identityForGit(git);
 const matches=discover().filter(found=>claimMatches(found,identity,git));
 if(matches.length===0)throw new Error(`no sandbox exists for ${git.owner}/${git.repo}:${git.branch}`);
 if(matches.length!==1)throw new Error(`ambiguous sandbox identity: found ${matches.length} validated VMs for ${git.owner}/${git.repo}:${git.branch}`);
 const found=matches[0];
 if(!found.manifest||found.health==="invalid"||found.health==="unreachable")throw new Error(`sandbox ${found.vm.vm_name} is ${found.health}: ${found.detail??"manifest validation failed"}`);
 if(found.manifest.account&&found.manifest.account!==accountFingerprint())throw new Error(`sandbox ${found.vm.vm_name} was created by a different exe.dev account`);
 return found;
}
export function listText():string{
 const sandboxes=discover();if(!sandboxes.length)return"No atomic-exe sandboxes found.";
 return sandboxes.map(s=>{const m=s.manifest;return`${s.vm.vm_name.padEnd(55)} ${s.health.padEnd(11)} ${m?`${m.owner}/${m.repo}:${m.branch}`:(s.detail??"")}`}).join("\n");
}
export async function createSandbox(cwd:string,ctx:ExtensionContext,options:{startDefault?:boolean}={}):Promise<DiscoveredSandbox>{
 const git=inspectPublishedGit(cwd),identity=identityForGit(git),account=accountFingerprint();
 // Existing sandboxes are found by identity tag, not by name, so a half-built VM from a
 // previous attempt is still recognised even though its name is unique to that attempt.
 const claimed=discover().filter(found=>claimMatches(found,identity,git));
 if(claimed.length>1)throw new Error(`ambiguous sandbox identity: found ${claimed.length} validated VMs for ${git.owner}/${git.repo}:${git.branch}`);
 const existing=claimed[0];
 let reuse=false,vmName:string,generation:string;
 if(existing?.manifest){
  if(existing.manifest.account&&existing.manifest.account!==account)throw new Error(`sandbox ${existing.vm.vm_name} was created by a different exe.dev account`);
  if(existing.health==="ready")return existing;
  if(existing.health==="creating"||existing.health==="error"){reuse=true;vmName=existing.vm.vm_name;generation=existing.manifest.generation??newGeneration()}
  else throw new Error(`sandbox ${existing.vm.vm_name} is ${existing.health}; destroy it before creating a new one`);
 }else{generation=newGeneration();vmName=vmNameFor(identity,generation)}
 const packages=validatePortableConfig();
 // Show exactly what will leave the machine, rather than describing it in prose.
 const plan=portableTransferPlan();
 if(ctx.hasUI){const ok=await ctx.ui.confirm("Transfer your Atomic environment?",`These paths will be streamed to ${vmName} over SSH:\n\n${formatTransferPlan(plan)}\n\nLocal packages: ${packages.map(p=>basename(p.source)).join(", ")||"none"}. Nothing else in the Atomic agent directory is sent — sessions, caches, run history, and binaries stay on this machine.`);if(!ok)throw new Error("sandbox creation cancelled")}
 const manifest=initialManifest(git,identity,{vmName,generation,account});
 try{
  await progress(ctx,reuse?"Resuming existing VM…":"Checking GitHub integration…");
  if(!reuse){const integration=githubIntegration(git.owner,git.repo);await progress(ctx,"Creating VM…");createVm(vmName,[...identity.tags,generationTag(generation)],integration)}
  // exe.dev answers on its lobby REPL until the VM shell is routable, so every remote
  // step below would fail with 'command not found' if it started immediately.
  await progress(ctx,"Waiting for the VM to accept connections…");waitForVmShell(vmName);
  await progress(ctx,"Cloning and verifying the published branch…");bootstrapRepository(vmName,manifest);
  await progress(ctx,"Copying portable Atomic config and credentials…");const sent=await transferPortableConfig(vmName,packages);
  if(ctx.hasUI)ctx.ui.notify(`Transferred to ${vmName}:\n${formatTransferPlan(sent)}`,"info");
  await progress(ctx,"Installing Linux dependencies…");finalize(vmName,manifest,packages);
  await progress(ctx,options.startDefault===false?"Preparing sandbox sessions…":"Starting sandbox session #1…");initializeSessions(vmName,manifest,options.startDefault!==false);
  await progress(ctx,"Verifying the remote session…");setComment(vmName,`atomic ${git.owner}/${git.repo}:${git.branch} ${identity.shortId}`);
  return exactSandbox(cwd)
 }catch(error){const message=(error as Error).message;try{markManifestError(vmName,message)}catch{}try{setComment(vmName,`atomic-exe-sandbox error: ${message.slice(0,150)}`)}catch{}throw error}
 finally{clearProgress(ctx)}
}
export function sandboxSessions(cwd:string){const found=exactSandbox(cwd);return listRemoteSessions(found.vm.vm_name)}
export function cleanCurrent(cwd:string):DiscoveredSandbox{const found=exactSandbox(cwd);if(found.health!=="ready"||!found.manifest)throw new Error(`sandbox is ${found.health}`);cleanSandbox(found.vm.vm_name,found.manifest);return found}
export function destroyCurrent(cwd:string,force:boolean):string{const found=exactSandbox(cwd);if(!found.manifest)throw new Error("validated manifest required");guardDestroy(found.vm.vm_name,found.manifest,force);deleteVm(found.vm.vm_name);return found.vm.vm_name}
export async function ensureSandbox(cwd:string,ctx:ExtensionContext,options:{startDefault?:boolean}={}):Promise<DiscoveredSandbox>{
 try{return exactSandbox(cwd)}catch(error){if(!(error as Error).message.startsWith("no sandbox exists"))throw error;return createSandbox(cwd,ctx,options)}
}
export async function connectCurrent(cwd:string,ctx:ExtensionContext,id?:number):Promise<void>{const found=await ensureSandbox(cwd,ctx);await connect(found,ctx,id)}
export async function connect(found:DiscoveredSandbox,ctx:ExtensionContext,id?:number):Promise<void>{
 if(found.health!=="ready"||!found.manifest)throw new Error(`sandbox is ${found.health}`);if(ctx.mode!=="tui")throw new Error("entering a sandbox requires Atomic TUI mode");
 const session:SandboxSession=ensureRemoteSession(found.vm.vm_name,id);
 const herdr=startHerdrBridge(session.id);
 if(herdr)vmSshAllowFailure(found.vm.vm_name,"rm","-f",herdr.remoteSocket);
 // The attach runs through sessionctl so the client holds the sandbox attach lease.
 // Host-key checking stays pinned to exe.dev; herdr --remote would bypass it.
 await ctx.ui.custom<number|null>((tui,_theme,_kb,done)=>{let status:number|null=1;tui.stop();try{process.stdout.write("\x1b[2J\x1b[H");const forwarding=herdr?["-o","ExitOnForwardFailure=yes","-o","StreamLocalBindUnlink=yes","-R",`${herdr.remoteSocket}:${herdr.localSocket}`]:[];const result=spawnSync("ssh",[...VM_HOST_KEY_ARGS,...forwarding,"-tt",`${found.vm.vm_name}.exe.xyz`,`~/.atomic-exe/sessionctl report-herdr '${session.id}'; exec ~/.atomic-exe/sessionctl attach '${session.id}'`],{stdio:"inherit",env:process.env});status=result.status}catch(error){process.stderr.write(`${(error as Error).message}\n`)}finally{if(herdr)vmSshAllowFailure(found.vm.vm_name,"rm","-f",herdr.remoteSocket);herdr?.stop();tui.start();tui.requestRender(true);done(status)}return{render:()=>[],invalidate:()=>{}}});
}
