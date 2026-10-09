# Run Relay on the Oracle VM

## Prerequisites

Use a supported Linux VM with Node.js 22.16 or newer, npm, Git, Docker Engine, Python 3, and C/C++ build tools (for `node-pty`). The workspace image installs its own Node/Git/build tools for project code. Build the image on the target machine so Docker selects the native architecture.

Confirm the VM's actual CPU, RAM, and disk allocation before choosing limits. Oracle account creation does not guarantee that an eligible VM has been provisioned or that a requested shape has capacity. Keep access private with SSH forwarding or Tailscale; Relay defaults to loopback port 8080.

## First manual launch

Transfer this implemented checkout to the VM, including its lockfile. Do not transfer `.relay-data`, `.env`, `node_modules`, or the old-code backup unless deliberately restoring protected state.

```sh
npm ci
docker build -f infrastructure/Dockerfile.workspace -t relay-workspace:0.1.0 .
cp .env.example .env
npm run build
npm start
```

Run the server as a regular user with access to Docker. Do not run two Relay processes against the same data directory.

Read `.relay-data/access-token` on the VM and enter it in the browser. Alternatively configure `RELAY_ACCESS_TOKEN` as a random string of at least 24 characters before starting; no token file is written when that variable is set.

For initial access, an SSH tunnel is sufficient:

```sh
ssh -L 8080:127.0.0.1:8080 your-user@your-vm
```

Open `http://127.0.0.1:8080` locally. For Tailscale Serve, expose the loopback service through your private tailnet HTTPS name and set `RELAY_PUBLIC_ORIGIN` to that exact origin, without a trailing slash. Restart Relay after configuration changes. The public origin is used for browser-origin validation and secure session cookies.

## First workspace and Codex login

Create a workspace from an HTTPS Git URL, an existing server-authorized `git@host:owner/repo.git` URL, or an empty repository. Private Git access uses the server user's Git/SSH setup. Never put an access token into the repository URL.

Start the environment. Click **Log into Codex**; this runs `codex login --device-auth` in its terminal. Complete the displayed login flow. If your account does not permit device authentication, configure the supported Codex login method in that terminal before continuing. Relay does not implement its own OAuth flow.

The `/codex` directory is mounted from Relay's shared persistent Codex home. Log in once; new environments use that login while keeping separate source directories and thread IDs. This is intended for your own trusted repositories.

Use the terminal to install dependencies (`npm ci` where a lockfile exists), run tests, or inspect Git. Dependency directories are not copied into experiments; install them again there as needed.

## Install as a service

The supplied unit expects `/opt/relay` as the checkout, `/var/lib/relay` as persistent data, a `relay` account, and `/usr/bin/node`. Adapt those paths if your Node installation uses another location.

After placing the checkout in `/opt/relay`, prepare the service account and storage as an administrator:

```sh
sudo useradd --create-home --shell /bin/bash relay
sudo usermod -aG docker relay
sudo chown -R relay:relay /opt/relay
sudo install -d -o relay -g relay -m 700 /var/lib/relay
```

Skip account creation if that account already exists. As the `relay` user, install dependencies, build the application, build the workspace image, and configure `/opt/relay/.env`. Set `RELAY_DATA_DIR=/var/lib/relay` there so it matches the service unit. Ensure your origin is correct.

```sh
sudo cp /opt/relay/infrastructure/relay.service /etc/systemd/system/relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now relay
sudo systemctl status relay
```

The Docker group gives the trusted backend host-level infrastructure access. Workload containers receive no Docker socket. If using rootless Docker, adapt the service group/environment to its socket rather than using this default unit unchanged.

Useful operations:

```sh
sudo journalctl -u relay -f
sudo systemctl restart relay
sudo systemctl stop relay
docker ps --filter label=relay.installation
```

## VM acceptance checklist

The local test suite does not replace these real-infrastructure checks:

1. Build and start the image on the VM's actual architecture. Check `node --version`, `git --version`, and `codex --version` inside a workspace terminal.
2. Log into Codex. Ask it to create a small file and run a command. Verify structured output and the resulting file in the editor.
3. Close all browser tabs while a task runs; reconnect and inspect the same run and its retained output.
4. Stop and restart a workspace. Verify files and the saved Codex login survive.
5. Create an experiment from a dirty primary workspace. Verify the copied changes, edit the experiment, and check that the primary is unchanged.
6. Launch two parallel tasks. Verify separate files/threads and observe their resource limits using `docker stats`. If testing a larger batch through the API, confirm extra tasks queue and completed workers free capacity.
7. Cancel one task that has a long-running shell command. Verify its container stops and its sibling continues.
8. Review and apply one result. Then create another result, modify the primary, and verify stale promotion is rejected.
9. Restart the backend during a task. Verify the old run is interrupted, queued work is retained, and no duplicate task is launched. Continue its conversation with a new prompt.
10. Reboot the VM. Verify the service starts, files/history survive, and interrupted tasks are not silently reported as running.

## Backup and cleanup

For a simple consistent backup, stop Relay and its remaining managed containers, then back up the entire data directory and `.env` to protected storage outside this VM. The directory contains source code, Git data, SQLite files, login credentials, and conversation history. Restart Relay afterward. Restore under the same OS ownership and rebuild the pinned image before starting workloads.

Discard temporary workspaces through the UI after retaining desired changes. This removes their containers/source trees and retains SQLite task history and stored proposals. Primary deletion and automatic expiry are intentionally unavailable in V1. Monitor disk usage: persistent event history and the shared Codex home currently have no automatic retention policy.

## Troubleshooting

- **Docker unavailable:** check the daemon and the backend user's Docker access. Browsing/editing files can still work.
- **Image unavailable:** run the image build command; allow up to 15 seconds for the UI status to refresh.
- **Queued tasks do not start:** inspect idle primary/experiment containers and stop one, or adjust limits to fit the host. Parallel worker containers stop automatically when done.
- **Codex authentication failure:** open a running environment's terminal and run `codex login status`, then sign in again if needed.
- **Request origin rejected:** match `RELAY_PUBLIC_ORIGIN` to the exact browser origin and restart the backend.
- **Save conflict:** reload the file and reconcile your edits with the newer contents.
- **Snapshot rejected:** remove unsupported symlinks/submodules or exclude generated output. Limits are 20,000 entries and 128 MiB of eligible source.
- **Interrupted promotion:** inspect the primary files and the SQLite operation record marked `needs-review`; do not assume the patch is unapplied. Resolve manually and take a fresh snapshot.
