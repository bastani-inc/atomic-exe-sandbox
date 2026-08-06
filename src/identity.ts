import { createHash } from "node:crypto";
import type { GitContext,SandboxIdentity } from "./types.js";
export function slug(value:string,max=32):string { return value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,max).replace(/-+$/g,"")||"sandbox" }
export function identityForGit(context:Pick<GitContext,"canonicalRepo"|"branchRef"|"repo"|"branch">):SandboxIdentity { const id=createHash("sha256").update(context.canonicalRepo).update("\0").update(context.branchRef).digest("hex");const shortId=id.slice(0,12);return{id,shortId,vmName:`atomic-${slug(context.repo,20)}-${slug(context.branch,20)}-${shortId}`.slice(0,63),tags:["atomic-sandbox",`atomic-id-${shortId}`,`repo-${slug(context.repo,28)}`]} }
