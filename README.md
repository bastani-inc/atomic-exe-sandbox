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

Both guarantee the sandbox exists, creating it when necessary, recover the last numbered Atomic session if herdr or Atomic stopped, and attach to it. `/sandbox <id>` enters a specific session. There is intentionally no `connect` subcommand. From Atomic's isolated interactive TUI the attach cannot take this terminal: if you are already in herdr it opens a focused sibling tab; on Windows it opens Windows Terminal (then `cmd start`); otherwise it opens tmux / iTerm / Ghostty / Terminal.app.

Creation fails closed unless the local branch is named and exactly equal to its published GitHub upstream. A dirty worktree — staged, unstaged, or untracked paths — warns first and asks whether to continue; local source is never copied. Code is cloned only through `github.int.exe.xyz`.

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
/sandbox prompt <id> …   send text into that session as if you typed it
/sandbox transfer        continue the current local Atomic session in the sandbox
/sandbox create          explicitly create the sandbox
/sandbox clean           clear regenerable caches; preserve sessions and Git
/sandbox destroy         delete after Git/work/client safety checks
/sandbox destroy --force
```

`transfer` requires the local Atomic to be idle. It creates the VM if absent, reserves the next session number, streams the current JSONL, changes only the header `cwd`, starts that session remotely, leaves a visible custom marker in the local JSONL that is excluded from model context, connects, and closes the originating local Atomic after detach. The local JSONL remains as a backup.

The local session also registers a `sandbox` tool for the non-TUI sandbox lifecycle and remote Atomic sessions. A node is one remote Atomic session with its own git worktree/branch, so each workflow has its own tool queue:

```text
sandbox { action: create }                  # provision this checkout's sandbox
sandbox { action: ensure }                  # find or provision the sandbox
sandbox { action: spawn, label: "auth" }   # node on atomic-node/auth
sandbox { action: new }                     # session on the published checkout
sandbox { action: list }                    # list sessions
sandbox { action: status, id: 2 }           # inspect one session
sandbox { action: prompt, id: 2, text: "…" } # send a workflow or task
sandbox { action: read, id: 2 }             # read recent output
sandbox { action: collect, id: 2 }          # git status / log / diff
sandbox { action: clean }                   # clear regenerable caches
sandbox { action: destroy }                 # delete after safety checks
sandbox { action: doctor }                  # check prerequisites
```

Combine node branches later with `gh stack`. The tool does not take over this TUI.

## Remote Atomic commands

On the VM's published checkout, `/sandbox` still manages sessions in *this* sandbox (`new`, `switch`, `detach`, `prompt`).

Inside a **node** (a worktree on another branch), `/sandbox` is the host command again: it creates or enters **that branch's** exe.dev sandbox — a sandbox of this sandbox. `/sandbox prompt` then talks to that child VM. If the child has only one session, the id is optional.

```text
/sandbox new             create the next numbered Atomic session and switch to it
/sandbox switch          select a numbered session
/sandbox <id>            recover/switch directly
/sandbox list            list all numbered sessions
/sandbox status          show brief sandbox identity
/sandbox detach          disconnect while every Atomic session keeps running
/sandbox prompt [id] …   send text into the only session, or a numbered one
```

The powerline shows only `☁ sandbox #N` remotely. Local Atomic has no environment label.

If SSH drops or a terminal closes, herdr keeps every Atomic process running. Reconnect with `atomic --sandbox` or `/sandbox`. If one Atomic process exited, only its requested session is recreated — with fresh herdr ids — and no VM recreation, Git reset, cache clean, or other-session restart occurs.

## Herdr in the VM

Provisioning installs herdr with `curl -fsSL https://herdr.dev/install.sh | sh`, which drops the binary in `$HOME/.local/bin`, and every remote script puts that directory on `PATH`. A detached herdr server owns the `atomic-exe` session; sessions are created with `herdr workspace create` and `herdr tab create`, started with `herdr pane run`, and switched with `herdr tab focus`.

The exe.dev image ships other coding agents but not Atomic, so provisioning installs the same version as the host (`atomic --version`) with `bun install -g @bastani/atomic@<host>`. It refuses to finish unless that exact version is on `PATH` and runs. Starting a session also refuses if `atomic` is missing.

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

- **Attach cannot take over Atomic's isolated-engine TUI.** `/sandbox` and `atomic --sandbox` run in the engine child, whose stdout is the JSONL transport, not a TTY. Stealing that pipe painted an empty screen. When the local Atomic is already inside herdr, attach opens a focused sibling tab and runs the host-key-pinned SSH command there. On Windows it opens a Windows Terminal tab, then a `cmd start` console. Otherwise it opens tmux / iTerm / Ghostty / Terminal.app. Detach in that tab with `/sandbox detach`. A Windows host still needs OpenSSH (`ssh`) on `PATH`.
- **Agent status in herdr is reported once, not tracked.** Attaching reports the session identity and an initial `idle` state over herdr's socket API. Atomic does not emit lifecycle events, so a sandbox agent is not shown as `working` or `blocked` while it runs. This affects the herdr sidebar display only.
- **Herdr does not recognise Atomic natively.** There is no `herdr integration install atomic` and no `agent start --kind atomic`, so herdr cannot resume Atomic sessions after a herdr server restart. Those panes return as plain shells in their saved directories.
- **VM lifecycle paths are source-verified, not live-tested.** Provisioning, session control, attach, and the destroy guards are covered by unit tests, source review, and local herdr probes. Exercising them end to end requires a provisioned exe.dev VM.

## Attribution

Derived from `pi-exe-sandbox` by danim47c, which targets the Pi coding agent and tmux. This project ports it to the Atomic coding agent and replaces tmux with [herdr](https://herdr.dev).
