import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
export interface CommandResult { stdout:string; stderr:string; exitCode:number }
export class CommandError extends Error { constructor(message:string, readonly command:string, readonly result:CommandResult){ super(message) } }
export function run(command:string,args:readonly string[],options:SpawnOptions={}):CommandResult {
  const result=spawnSync(command,[...args],{...options,encoding:"utf8",stdio:[options.stdio==="inherit"?"inherit":"ignore","pipe","pipe"]});
  const output={stdout:typeof result.stdout==="string"?result.stdout:"",stderr:typeof result.stderr==="string"?result.stderr:"",exitCode:result.status??1};
  if(result.error) throw result.error;
  if(output.exitCode!==0) throw new CommandError(`${command} failed (${output.exitCode}): ${output.stderr.trim()||output.stdout.trim()}`,[command,...args].join(" "),output);
  return output;
}
export function runAllowFailure(command:string,args:readonly string[],options:SpawnOptions={}):CommandResult { try{return run(command,args,options)}catch(error){if(error instanceof CommandError)return error.result;throw error} }
export async function pipeCommands(source:{command:string;args:string[];cwd?:string},sink:{command:string;args:string[]}):Promise<void>{
 await new Promise<void>((resolve,reject)=>{const left=spawn(source.command,source.args,{cwd:source.cwd,stdio:["ignore","pipe","pipe"]});const right=spawn(sink.command,sink.args,{stdio:["pipe","pipe","pipe"]});let le="",re="",lc:number|null=null,rc:number|null=null;left.stderr.on("data",c=>le+=c);right.stderr.on("data",c=>re+=c);left.stdout.pipe(right.stdin);const finish=()=>{if(lc===null||rc===null)return;if(lc===0&&rc===0)resolve();else reject(new Error(`config transfer failed (tar=${lc}, ssh=${rc}): ${le||re}`))};left.on("error",reject);right.on("error",reject);left.on("close",c=>{lc=c;finish()});right.on("close",c=>{rc=c;finish()})});
}
export async function pipeBuffer(buffer: Buffer, sink:{command:string;args:string[]}):Promise<void>{
 await new Promise<void>((resolve,reject)=>{const child=spawn(sink.command,sink.args,{stdio:["pipe","pipe","pipe"]});let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);child.on("error",reject);child.on("close",code=>code===0?resolve():reject(new Error(`stream transfer failed (${code}): ${stderr}`)));child.stdin.end(buffer)});
}
