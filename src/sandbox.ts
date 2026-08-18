import { basename } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { attachToSession, isolatedEngineAttach } from "./attach.js";
import { formatTransferPlan, portableTransferPlan, transferPortableConfig, validatePortableConfig } from "./config.js";
import { accountFingerprint, createVm, deleteVm, discover, githubIntegration, setComment, vmSshAllowFailure, waitForVmShell } from "./exe.js";
import { inspectGitIdentity, inspectPublishedGit } from "./git.js";
import { generationTag, identityForGit, newGeneration, vmNameFor } from "./identity.js";
import { startHerdrBridge } from "./herdr.js";
import { bootstrapRepository, cleanSandbox, finalize, guardDestroy, initialManifest, markManifestError } from "./remote.js";
import { ensureRemoteSession, initializeSessions, listRemoteSessions } from "./sessions.js";
import type { DiscoveredSandbox, GitContext, SandboxIdentity } from "./types.js";
import { PASS, type Paint, paintFor, PLAIN_PAINT, clearProgress, showProgress } from "./ui.js";

export { clearProgress };

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
export function listText(paint:Paint=PLAIN_PAINT):string{
 const sandboxes=discover();if(!sandboxes.length)return paint.dim("No atomic-exe sandboxes found.");
 return sandboxes.map(s=>{
  const m=s.manifest,tint=s.health==="ready"?paint.ok:s.health==="creating"?paint.warn:paint.bad;
  return `${tint(s.vm.vm_name.padEnd(55))} ${tint(s.health.padEnd(11))} ${paint.dim(m?`${m.owner}/${m.repo}:${m.branch}`:(s.detail??""))}`;
 }).join("\n");
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
  await showProgress(ctx,reuse?"Resuming existing VM…":"Checking GitHub integration…");
  if(!reuse){const integration=githubIntegration(git.owner,git.repo);await showProgress(ctx,"Creating VM…");createVm(vmName,[...identity.tags,generationTag(generation)],integration)}
  // exe.dev answers on its lobby REPL until the VM shell is routable, so every remote
  // step below would fail with 'command not found' if it started immediately.
  await showProgress(ctx,"Waiting for the VM to accept connections…");waitForVmShell(vmName);
  await showProgress(ctx,"Cloning and verifying the published branch…");bootstrapRepository(vmName,manifest);
  await showProgress(ctx,"Copying portable Atomic config and credentials…");const sent=await transferPortableConfig(vmName,packages);
  if(ctx.hasUI){const paint=paintFor(ctx);ctx.ui.notify(`${paint.ok(`${PASS} Transferred to ${vmName}`)}\n${paint.dim(formatTransferPlan(sent))}`,"info")}
  await showProgress(ctx,"Installing Linux dependencies…");finalize(vmName,manifest,packages);
  await showProgress(ctx,options.startDefault===false?"Preparing sandbox sessions…":"Starting sandbox session #1…");initializeSessions(vmName,manifest,options.startDefault!==false);
  await showProgress(ctx,"Verifying the remote session…");setComment(vmName,`atomic ${git.owner}/${git.repo}:${git.branch} ${identity.shortId}`);
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
 const session=ensureRemoteSession(found.vm.vm_name,id);
 const herdr=startHerdrBridge(session.id);
 if(herdr)vmSshAllowFailure(found.vm.vm_name,"rm","-f",herdr.remoteSocket);
 // Isolated Atomic cannot give SSH this TTY. A real terminal is opened instead.
 // Host-key checking stays pinned to exe.dev; herdr --remote would bypass it.
 try{await attachToSession(ctx,found.vm.vm_name,session.id,herdr)}
 finally{if(!isolatedEngineAttach()&&herdr)vmSshAllowFailure(found.vm.vm_name,"rm","-f",herdr.remoteSocket)}
}
