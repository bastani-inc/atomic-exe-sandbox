import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@bastani/atomic";
import { validatePortableConfig, transferPortableConfig } from "./config.js";
import { createVm, deleteVm, discover, githubIntegration, listVms, readManifest, setComment, vmSshAllowFailure, VM_HOST_KEY_ARGS } from "./exe.js";
import { inspectGitIdentity, inspectPublishedGit } from "./git.js";
import { identityForGit } from "./identity.js";
import { startHerdrBridge } from "./herdr.js";
import { bootstrapRepository, cleanSandbox, finalize, guardDestroy, initialManifest, markManifestError } from "./remote.js";
import { ensureRemoteSession, initializeSessions, listRemoteSessions, type SandboxSession } from "./sessions.js";
import type { DiscoveredSandbox } from "./types.js";

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

export function exactSandbox(cwd:string):DiscoveredSandbox{
 const git=inspectGitIdentity(cwd),identity=identityForGit(git);
 const matches=discover().filter(({vm,manifest})=>vm.vm_name===identity.vmName&&manifest?.identity===identity.id&&manifest.canonicalRepo===git.canonicalRepo&&manifest.branchRef===git.branchRef);
 if(matches.length===0)throw new Error(`no sandbox exists for ${git.owner}/${git.repo}:${git.branch}`);
 if(matches.length!==1)throw new Error(`ambiguous sandbox identity: found ${matches.length} validated VMs for ${git.owner}/${git.repo}:${git.branch}`);
 const found=matches[0];
 if(!found.manifest||found.health==="invalid"||found.health==="unreachable")throw new Error(`sandbox ${found.vm.vm_name} is ${found.health}: ${found.detail??"manifest validation failed"}`);
 return found;
}
export function listText():string{
 const sandboxes=discover();if(!sandboxes.length)return"No atomic-exe sandboxes found.";
 return sandboxes.map(s=>{const m=s.manifest;return`${s.vm.vm_name.padEnd(55)} ${s.health.padEnd(11)} ${m?`${m.owner}/${m.repo}:${m.branch}`:(s.detail??"")}`}).join("\n");
}
export async function createSandbox(cwd:string,ctx:ExtensionContext,options:{startDefault?:boolean}={}):Promise<DiscoveredSandbox>{
 const git=inspectPublishedGit(cwd),identity=identityForGit(git),existingVms=listVms(),sameName=existingVms.find(v=>v.vm_name===identity.vmName);
 let reuse=false;
 if(sameName){
  const inspected=readManifest(sameName),manifest=inspected.manifest;
  const matches=manifest?.identity===identity.id&&manifest.canonicalRepo===git.canonicalRepo&&manifest.branchRef===git.branchRef;
  if(matches&&inspected.health==="ready")return inspected;
  if(matches&&(inspected.health==="creating"||inspected.health==="error"))reuse=true;
  else throw new Error(`VM name collision: ${identity.vmName} exists but does not match this published branch`);
 }
 const packages=validatePortableConfig();
 if(ctx.hasUI){const ok=await ctx.ui.confirm("Transfer your Atomic environment?",`This securely streams portable Atomic config, MCP credentials, model auth, skills, prompts, themes, and local extension source to ${identity.vmName}. Sessions, caches, binaries, node_modules, and Git package caches are excluded and Linux dependencies are rebuilt.`);if(!ok)throw new Error("sandbox creation cancelled")}
 const manifest=initialManifest(git,identity);
 try{
  await progress(ctx,reuse?"Resuming existing VM…":"Checking GitHub integration…");
  if(!reuse){const integration=githubIntegration(git.owner,git.repo);await progress(ctx,"Creating VM…");createVm(identity.vmName,identity.tags,integration)}
  await progress(ctx,"Cloning and verifying the published branch…");bootstrapRepository(identity.vmName,manifest);
  await progress(ctx,"Copying portable Atomic config and credentials…");await transferPortableConfig(identity.vmName,packages);
  await progress(ctx,"Installing Linux dependencies…");finalize(identity.vmName,manifest,packages);
  await progress(ctx,options.startDefault===false?"Preparing sandbox sessions…":"Starting sandbox session #1…");initializeSessions(identity.vmName,manifest,options.startDefault!==false);
  await progress(ctx,"Verifying the remote session…");setComment(identity.vmName,`atomic ${git.owner}/${git.repo}:${git.branch} ${identity.shortId}`);
  return exactSandbox(cwd)
 }catch(error){const message=(error as Error).message;try{markManifestError(identity.vmName,message)}catch{}try{setComment(identity.vmName,`atomic-exe-sandbox error: ${message.slice(0,150)}`)}catch{}throw error}
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
