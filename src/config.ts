import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { vmSsh, vmSshArgs } from "./exe.js";
import { pipeCommands } from "./process.js";

const HOME=homedir();
const AGENT=join(HOME,".atomic","agent");
const SAFE_ROOTS=[AGENT,join(HOME,".agents")].flatMap((path)=>{try{return[realpathSync(path)]}catch{return[]}});

/**
 * Only these paths ever leave the machine.
 *
 * This was previously a denylist, which meant anything new in the agent directory
 * shipped by default. That is how run-history.jsonl — a log of past runs, the same kind
 * of data as the deliberately excluded sessions directory — ended up on every sandbox.
 * An allowlist makes the contract explicit: adding a file here is a decision.
 */
const AGENT_MEMBERS=[
 "settings.json",      // model choice, powerline, package list
 "auth.json",          // provider credentials the remote agent needs to run
 "mcp.json",           // MCP server definitions
 "models-store.json",  // model catalogue
 "extensions",
 "skills",
 "prompts",
 "themes",
];
/** Noise that can appear inside an allowed directory and is never useful remotely. */
const MEMBER_EXCLUDES=["--exclude=node_modules","--exclude=*/node_modules","--exclude=*.node","--exclude=*.sock","--exclude=*.pid","--exclude=*.lock","--exclude=.DS_Store","--exclude=._*"];
/** Names that usually hold credentials; sizes are reported, contents never are. */
const SECRET_SHAPED=/key|token|secret|password|pass|credential|auth/i;

export interface TransferEntry { path:string; bytes:number; secret:boolean }
function treeBytes(path:string):number{
 const stat=lstatSync(path);
 if(stat.isSymbolicLink())return 0;
 if(!stat.isDirectory())return stat.size;
 let total=0;
 for(const entry of readdirSync(path)){if(entry==="node_modules")continue;try{total+=treeBytes(join(path,entry))}catch{}}
 return total;
}
/** Exactly what transferPortableConfig would send, so it can be shown before it is sent. */
export function portableTransferPlan():TransferEntry[]{
 const entries:TransferEntry[]=[];
 for(const member of AGENT_MEMBERS){
  const full=join(AGENT,member);
  try{statSync(full)}catch{continue}
  entries.push({path:`.atomic/agent/${member}`,bytes:treeBytes(full),secret:SECRET_SHAPED.test(member)});
 }
 try{const skills=join(HOME,".agents","skills");statSync(skills);entries.push({path:".agents/skills",bytes:treeBytes(skills),secret:false})}catch{}
 return entries;
}
function human(bytes:number):string{return bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`}
export function formatTransferPlan(entries:TransferEntry[]):string{
 if(!entries.length)return "Nothing to transfer.";
 const total=entries.reduce((sum,e)=>sum+e.bytes,0);
 return [...entries.map(e=>`  ${e.path} — ${human(e.bytes)}${e.secret?" (secret)":""}`),`  total ${human(total)}`].join("\n");
}
export interface LocalPackage { configured:string; source:string; remote:string }
function inside(path:string,root:string):boolean{const rel=relative(root,path);return rel===""||(!rel.startsWith("..")&&!rel.startsWith("/"))}
function walkSymlinks(root:string):void{
 const visit=(path:string)=>{for(const entry of readdirSync(path)){const full=join(path,entry),stat=lstatSync(full);if(stat.isSymbolicLink()){const target=realpathSync(full);if(!SAFE_ROOTS.some(r=>inside(target,r)))throw new Error(`configuration symlink escapes portable roots: ${full} -> ${target}`)}else if(stat.isDirectory()&&entry!=="node_modules"&&!["sessions","git","npm","cache","backups","bin"].includes(entry))visit(full)}};visit(root)
}
export function localPackages():LocalPackage[]{
 const settings=JSON.parse(readFileSync(join(AGENT,"settings.json"),"utf8")) as {packages?:unknown[]};
 const values=(settings.packages??[]).filter((p):p is string=>typeof p==="string"&&!p.startsWith("npm:")&&!p.startsWith("git:"));const names=new Set<string>();
 return values.map(configured=>{const real=realpathSync(configured.startsWith("/")?configured:join(AGENT,configured)),name=basename(real);if(names.has(name))throw new Error(`local Atomic packages collide by basename: ${name}`);names.add(name);if(!lstatSync(join(real,"package.json")).isFile())throw new Error(`local Atomic package has no package.json: ${configured}`);return{configured,source:real,remote:`/home/exedev/.atomic-exe/local-packages/${name}`}})
}
export function validatePortableConfig():LocalPackage[]{walkSymlinks(AGENT);const agents=join(HOME,".agents");try{walkSymlinks(agents)}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}return localPackages()}
export async function transferPortableConfig(vm:string,packages:LocalPackage[]):Promise<TransferEntry[]>{
 const plan=portableTransferPlan();
 if(!plan.length)throw new Error(`nothing to transfer: none of ${AGENT_MEMBERS.join(", ")} exist under ${AGENT}`);
 vmSsh(vm,"sh","-lc",`rm -rf "$HOME/.atomic-exe/config-stage"; install -d -m 700 "$HOME/.atomic-exe/config-stage" "$HOME/.atomic-exe/local-packages"`);
 // Named members only. Nothing outside the allowlist can be swept up by a missing exclude.
 await pipeCommands({command:"tar",args:["-C",HOME,...MEMBER_EXCLUDES,"-cf","-",...plan.map(entry=>entry.path)]},{command:"ssh",args:[...vmSshArgs(vm),"tar -C /home/exedev/.atomic-exe/config-stage -xf -"]});
 for(const pkg of packages){vmSsh(vm,"rm","-rf",pkg.remote);await pipeCommands({command:"tar",cwd:dirname(pkg.source),args:["--exclude=.git","--exclude=node_modules","--exclude=*.node","-cf","-",basename(pkg.source)]},{command:"ssh",args:[...vmSshArgs(vm),"tar -C /home/exedev/.atomic-exe/local-packages -xf -"]})}
 return plan;
}
