# atomic-exe-sandbox

Global Atomic extension for persistent [exe.dev](https://exe.dev) sandboxes.

Each published GitHub branch gets one VM. Inside that VM, one herdr session (`atomic-exe`) holds a workspace whose numbered tabs each run one independent Atomic process:

```text
sandbox VM
└── herdr session atomic-exe
    ├── #1  Atomic session
    ├── #2  Atomic session
    └── #3  Atomic session
```

There is no local sandbox registry. VM discovery uses exe.dev tags plus a restricted in-VM manifest. Atomic session state lives only in `~/.atomic-exe/sessions.json` on the VM, together with the opaque herdr workspace, tab, and pane ids that herdr returned when each session was created.

## Start or reconnect

```bash
atomic --sandbox
```

or, from local Atomic:

```text
/sandbox
```

Both guarantee the sandbox exists, creating it when necessary, recover the last numbered Atomic session if herdr or Atomic stopped, and attach to it. `/sandbox <id>` enters a specific session. There is intentionally no `connect` subcommand.

Creation fails closed unless the local branch is named, clean, and exactly equal to its published GitHub upstream. Code is cloned only through `github.int.exe.xyz`; local source code is never copied.

The attached exe.dev GitHub integration also authenticates the GitHub CLI without placing a token in the VM. Remote Atomic processes, child shells, and subagents receive `GH_HOST=github.int.exe.xyz`, so repository-scoped commands work natively:

```bash
gh repo view Y-N-Lab/lapersona.ai
gh pr list -R Y-N-Lab/lapersona.ai
gh api repos/Y-N-Lab/lapersona.ai
```

Authentication is injected at exe.dev's network edge and follows the integration's repository and read/write permissions. The aggregate gateway intentionally rejects account-wide API/GraphQL operations that are not scoped to an attached repository; `gh auth status` may therefore report a misleading verification failure even while supported repository commands are authenticated.

## Local Atomic commands

```text
/sandbox                 create/recover/enter the last session
/sandbox <id>            recover/enter a numbered session
/sandbox list            list all Atomic sessions in this branch sandbox
/sandbox transfer        continue the current local Atomic session in the sandbox
/sandbox create          explicitly create the sandbox
/sandbox clean           clear regenerable caches; preserve sessions and Git
/sandbox destroy         delete after Git/work/client safety checks
/sandbox destroy --force
```

`transfer` requires the local Atomic to be idle. It creates the VM if absent, reserves the next session number, streams the current JSONL, changes only the header `cwd`, starts that session remotely, leaves a visible custom marker in the local JSONL that is excluded from model context, connects, and closes the originating local Atomic after detach. The local JSONL remains as a backup.

## Remote Atomic commands

```text
/sandbox new             create the next numbered Atomic session and switch to it
/sandbox switch          select a numbered session
/sandbox <id>            recover/switch directly
/sandbox list            list all numbered sessions
/sandbox status          show brief sandbox identity
/sandbox detach          disconnect while every Atomic session keeps running
```

The powerline shows only `☁ sandbox #N` remotely. Local Atomic has no environment label.

If SSH drops or a terminal closes, herdr keeps every Atomic process running. Reconnect with `atomic --sandbox` or `/sandbox`. If one Atomic process exited, only its requested session is recreated — with fresh herdr ids — and no VM recreation, Git reset, cache clean, or other-session restart occurs.

## Herdr in the VM

Provisioning installs herdr with `curl -fsSL https://herdr.dev/install.sh | sh`, which drops the binary in `$HOME/.local/bin`, and every remote script puts that directory on `PATH`. A detached herdr server owns the `atomic-exe` session; sessions are created with `herdr workspace create` and `herdr tab create`, started with `herdr pane run`, and switched with `herdr tab focus`.

The exe.dev image ships other coding agents but not Atomic, so provisioning installs it with `bun install -g @bastani/atomic`, which links the binary into `$HOME/.bun/bin`. Provisioning then refuses to finish unless `atomic` is on `PATH` and runs, and starting a session refuses for the same reason, so a sandbox never comes up with a missing agent.

Herdr object ids are opaque. They are read out of the JSON that herdr prints when it creates an object, never predicted, and stored per session in the registry. Rows written before herdr simply have no ids and get new objects on their next start.

Herdr exposes no attached-client count, so an attached client is represented by a shared lease on `~/.atomic-exe/attach.lock` that the attach wrapper holds for exactly as long as the client runs, plus a registered client pid. `destroy` and `clean` take that lease exclusively and refuse to continue while it is held; a lease that cannot be tested counts as attached. `/sandbox detach` terminates the registered clients, leaving the server and every session running.

## Portable Atomic environment

Creation securely streams settings, auth/MCP files, skills, prompts, themes, and local extension source. It excludes sessions, caches, package/Git caches, `node_modules`, native modules, binaries, sockets, PID/lock files, backups, and AppleDouble files. Linux dependencies are rebuilt with Bun and Node 22, and the Atomic agent itself is installed from npm. The exe.dev managed-LLM prompt is disabled; remote Atomic uses the copied local model configuration instead.

VM SSH uses `HostKeyAlias=exe.dev`, validating every generated VM hostname against the already trusted exe.dev host key. Host-key checking is never disabled, and attaching goes through that same pinned SSH invocation rather than `herdr --remote`.

## Install

```bash
atomic install /absolute/path/to/atomic-exe-sandbox
```

Requirements:

- Atomic, plus `ssh`, `git`, and `tar` on the local machine.
- An authenticated exe.dev account. On first connect, confirm the host key fingerprint is `SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo`; every VM connection is validated against that same key.
- The SSH key used for exe.dev must authenticate without an interactive prompt, because every call sets `BatchMode=yes`. Use a passphrase-free key or load it into `ssh-agent` first.
- An exe.dev GitHub integration granting access to the repository, created with `integrations add github --name <name> --repository <owner>/<repo>`. Do not pass `--readonly`: pushes would be rejected, and `destroy` refuses to delete a sandbox that still holds unpushed commits.

## Safety notes

- Tags only find candidates; commands compare manifest repo, branch, identity, VM name, and fixed checkout path with locally derived values.
- Secrets stream over SSH and never appear in argv, comments, or local archive files.
- GitHub credentials are not copied into the VM; exe.dev's attached GitHub integration authenticates Git and `gh` at the network edge.
- `destroy` rejects attached clients, dirty/untracked work, dirty submodules, stashes, missing remotes, and unpushed branches unless forced.
- Repository/Atomic code runs as `exedev`; the manifest prevents accidental mismatch, not malicious in-VM tampering.
- exe.dev exposes no compare-and-delete operation, leaving a small provider-level race between final remote guard and deletion.

## Known limitations

- **Team integrations are not supported.** VM creation attaches the GitHub integration by name, which exe.dev permits only for personal integrations; team integrations attach by tag instead. Create a personal integration for the repository.
- **Herdr does not recognise Atomic natively.** There is no `herdr integration install atomic` and no `agent start --kind atomic`, so herdr cannot resume Atomic sessions after a herdr server restart. Those panes return as plain shells in their saved directories.
- **VM lifecycle paths are source-verified, not live-tested.** Provisioning, session control, attach, and the destroy guards are covered by unit tests, source review, and local herdr probes. Exercising them end to end requires a provisioned exe.dev VM.

## Attribution

Derived from `pi-exe-sandbox` by danim47c, which targets the Pi coding agent and tmux. This project ports it to the Atomic coding agent and replaces tmux with [herdr](https://herdr.dev).
