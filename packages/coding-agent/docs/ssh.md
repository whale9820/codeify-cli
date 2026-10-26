# Persistent SSH shells

Codeify provides `ssh_manage` and `ssh` by default. Ask the agent to save an SSH profile, then run commands on it. Profiles survive CLI restarts. Each profile gets one live SSH connection and remote POSIX shell for the current Codeify session: commands reuse that shell without another SSH handshake, and `cd`, variables, functions and exports persist between calls.

For an existing SSH config alias:

```json
{"action":"add","name":"codeify","profile":{"host":"codeify","configFile":"~/.ssh/codeify_vps"}}
```

Or supply a hostname, user, port and key path:

```json
{"action":"add","name":"vps","profile":{"host":"vps.example.com","user":"root","port":22,"identityFile":"~/.ssh/id_ed25519"}}
```

The agent then calls `ssh`:

```json
{"profile":"codeify","command":"cd /root/qoder/re"}
```

The terminal displays `● SSH(cd /root/qoder/re) (codeify)`, with the profile in muted gray. A subsequent `pwd` or build runs in `/root/qoder/re` on the same shell. Output streams and expands like Bash output, with the same output limits and Ctrl+B background support. Calls to one profile run in order; different profiles have independent shells.

Manage profiles with `ssh_manage`:

```json
{"action":"list"}
{"action":"edit","name":"codeify","profile":{"user":"deploy","identityFile":null}}
{"action":"disconnect","name":"codeify"}
{"action":"delete","name":"codeify"}
```

Edit merges fields; `null` removes an optional field. Edit and delete close the active shell. Disconnect closes the shell while retaining the profile. List includes whether this session has an open shell for each profile.

Profiles are saved atomically in `~/.codeify/agent/ssh.json` with owner-only file permissions (or the configured agent directory). Only connection settings and key paths are stored. The system `ssh` executable handles keys, ssh-agent, proxy jumps and SSH config. Password prompts and interactive authentication are disabled. Establish host trust through normal SSH first when needed; Codeify does not disable host-key verification.

Commands use a noninteractive POSIX `sh`, with no terminal and no stdin. Use heredocs or files for input. Redirect output for jobs deliberately detached with `&`, so their later output cannot mix with subsequent commands. Avoid replacing or exiting the shell, changing its input/output descriptors, or enabling shell options that terminate it on errors.

The connection stays open until disconnect, profile edit/delete, session disposal, connection failure, timeout or cancellation. Timeout and cancellation close the shell; remote processes may have already made changes and are not guaranteed to stop when the SSH connection closes. The next call starts a fresh shell and reports that its state is fresh. Interrupted commands are never automatically replayed. Live shell state does not survive a CLI restart or network disconnect.

Use `--tools ssh,ssh_manage` to allow only SSH tools, or `--exclude-tools ssh,ssh_manage` to disable them. `--no-tools` and `--no-builtin-tools` also disable them by default.
