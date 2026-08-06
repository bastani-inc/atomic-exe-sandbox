export const MANIFEST_SCHEMA = 1 as const;
export const CHECKOUT_ROOT = "/home/exedev/atomic-sandboxes";
export const HERDR_SESSION_NAME = "atomic-exe";
export interface GitContext { root:string; branch:string; branchRef:string; commit:string; upstream:string; owner:string; repo:string; canonicalRepo:string }
export interface SandboxIdentity { id:string; shortId:string; vmNameBase:string; idTag:string; tags:string[] }
export type ManifestState = "creating"|"ready"|"error"|"destroying";
export interface SandboxManifest { schemaVersion:typeof MANIFEST_SCHEMA; identity:string; vmName:string; canonicalRepo:string; owner:string; repo:string; branchRef:string; branch:string; creationCommit:string; checkoutPath:string; state:ManifestState; createdAt:string; updatedAt:string; error?:string; generation?:string; account?:string }
export interface ExeVm { vm_name:string; status:string; tags:string[]; ssh_dest:string; created_at?:string; comment?:string }
export interface DiscoveredSandbox { vm:ExeVm; manifest?:SandboxManifest; health:"ready"|"creating"|"error"|"destroying"|"invalid"|"unreachable"; detail?:string }
