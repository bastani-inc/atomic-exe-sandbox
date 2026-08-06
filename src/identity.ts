import { createHash, randomBytes } from "node:crypto";
import type { GitContext,SandboxIdentity } from "./types.js";
export function slug(value:string,max=32):string { return value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,max).replace(/-+$/g,"")||"sandbox" }
/**
 * Identity is carried by the manifest and the tags, never by the VM name. exe.dev keeps
 * routing a recently deleted name at its lobby for minutes, so reusing a deterministic
 * name after destroy produces a running, billable VM that cannot be reached. Names are
 * therefore unique per creation and are not used to decide what a VM is.
 */
export function identityForGit(context:Pick<GitContext,"canonicalRepo"|"branchRef"|"repo"|"branch">):SandboxIdentity {
 const id=createHash("sha256").update(context.canonicalRepo).update("\0").update(context.branchRef).digest("hex");
 const shortId=id.slice(0,12),idTag=`atomic-id-${shortId}`;
 // Leaves room for "-" plus an 8-character generation inside exe.dev's 63-character limit.
 const vmNameBase=`atomic-${slug(context.repo,20)}-${slug(context.branch,20)}-${shortId}`.slice(0,54).replace(/-+$/g,"");
 return{id,shortId,vmNameBase,idTag,tags:["atomic-sandbox",idTag,`repo-${slug(context.repo,28)}`]};
}
/** A fresh claim generation. Written to the VM as a tag and into the manifest. */
export function newGeneration():string { return randomBytes(4).toString("hex") }
export function generationTag(generation:string):string { return `atomic-gen-${generation}` }
export function vmNameFor(identity:SandboxIdentity,generation:string):string { return `${identity.vmNameBase}-${generation}` }
