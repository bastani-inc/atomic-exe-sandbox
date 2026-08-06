import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { vmSsh, vmSshArgs } from "./exe.js";
import { pipeCommands } from "./process.js";

const HOME=homedir();
const AGENT=join(HOME,".atomic","agent");
const SAFE_ROOTS=[AGENT,join(HOME,".agents")].flatMap((path)=>{try{return[realpathSync(path)]}catch{return[]}});
const EXCLUDES=[
 "--exclude=.atomic/agent/sessions","--exclude=.atomic/agent/git","--exclude=.atomic/agent/npm","--exclude=.atomic/agent/cache","--exclude=.atomic/agent/backups","--exclude=.atomic/agent/bin",
 "--exclude=node_modules","--exclude=*/node_modules","--exclude=*.node","--exclude=*.sock","--exclude=*.pid","--exclude=*.lock","--exclude=.DS_Store"
 ,"--exclude=._*"
];
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
export async function transferPortableConfig(vm:string,packages:LocalPackage[]):Promise<void>{
 vmSsh(vm,"sh","-lc",`rm -rf "$HOME/.atomic-exe/config-stage"; install -d -m 700 "$HOME/.atomic-exe/config-stage" "$HOME/.atomic-exe/local-packages"`);
 const members=[".atomic/agent"];try{realpathSync(join(HOME,".agents","skills"));members.push(".agents/skills")}catch{}
 await pipeCommands({command:"tar",args:["-C",HOME,...EXCLUDES,"-cf","-",...members]},{command:"ssh",args:[...vmSshArgs(vm),"tar -C /home/exedev/.atomic-exe/config-stage -xf -"]});
 for(const pkg of packages){vmSsh(vm,"rm","-rf",pkg.remote);await pipeCommands({command:"tar",cwd:dirname(pkg.source),args:["--exclude=.git","--exclude=node_modules","--exclude=*.node","-cf","-",basename(pkg.source)]},{command:"ssh",args:[...vmSshArgs(vm),"tar -C /home/exedev/.atomic-exe/local-packages -xf -"]})}
}
