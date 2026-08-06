import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface HerdrBridge {
	localSocket: string;
	remoteSocket: string;
	stop(): void;
}

const PROXY_SOURCE = String.raw`
const net=require("node:net");
const fs=require("node:fs");
const [listen,target,pane]=process.argv.slice(1);
try{fs.unlinkSync(listen)}catch{}
const server=net.createServer(client=>{
  const upstream=net.createConnection(target);
  let pending="";
  client.on("data",chunk=>{
    pending+=chunk.toString("utf8");
    for(;;){const at=pending.indexOf("\n");if(at<0)break;const line=pending.slice(0,at);pending=pending.slice(at+1);
      try{const request=JSON.parse(line);if(request&&request.params&&typeof request.params==="object")request.params.pane_id=pane;upstream.write(JSON.stringify(request)+"\n")}catch{upstream.write(line+"\n")}
    }
  });
  upstream.on("data",chunk=>client.write(chunk));
  upstream.on("end",()=>client.end()); upstream.on("error",()=>client.destroy());
  client.on("end",()=>upstream.end()); client.on("error",()=>upstream.destroy());
});
server.listen(listen,()=>{fs.chmodSync(listen,0o600);process.stdout.write("ready\n")});
for(const signal of ["SIGTERM","SIGINT"]){process.on(signal,()=>server.close(()=>process.exit(0)))}
`;

export function herdrAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && Boolean(env.HERDR_SOCKET_PATH) && Boolean(env.HERDR_PANE_ID);
}

export function remoteHerdrSocket(sessionId: number): string {
	return `/home/exedev/.atomic-exe/herdr-${sessionId}.sock`;
}

export function startHerdrBridge(sessionId: number): HerdrBridge | undefined {
	const targetSocket = process.env.HERDR_SOCKET_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	if (!herdrAvailable() || !targetSocket || !paneId || !existsSync(targetSocket)) return undefined;
	// Darwin limits Unix-domain socket paths to 104 bytes. Keep this deliberately short.
	const localSocket = `/tmp/atomic-exe-herdr-${process.pid}-${randomUUID().slice(0, 8)}.sock`;
	const child: ChildProcess = spawn(
		process.execPath,
		["-e", PROXY_SOURCE, localSocket, targetSocket, paneId],
		{ stdio: ["ignore", "ignore", "ignore"] },
	);
	const deadline = Date.now() + 2_000;
	while (!existsSync(localSocket) && child.exitCode === null && Date.now() < deadline) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
	if (!existsSync(localSocket)) {
		child.kill();
		rmSync(localSocket, { force: true });
		throw new Error("could not start the local Herdr socket bridge");
	}
	let stopped = false;
	return {
		localSocket,
		remoteSocket: remoteHerdrSocket(sessionId),
		stop() {
			if (stopped) return;
			stopped = true;
			child.kill("SIGTERM");
			rmSync(localSocket, { force: true });
		},
	};
}
