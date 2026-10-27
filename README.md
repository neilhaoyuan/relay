# Relay

a self-hosted platform for developing software with AI coding agents. run Relay on your own Linux server (i recommend the free oracle vm) and access your projects from a browser through tailscale.

## What can be done?

- **Tasks:** assign work to Codex (future AI agent access in the progress) and follow its progress and approvals.
- **Experiments:** run independent attempts in disposable Docker environments.
- **Review:** compare changes and apply the result to your primary workspace.
- **Code:** open the integrated editor and terminal whenever you need them.

Closing your browser leaves running sessions available to reconnect to while the server stays running.

## Set up your own server

Follow the **[VM setup guide](docs/vm_setup.md)** to install Relay, configure persistent storage, enable private access with Tailscale, and sign into GitHub and Codex.

You'll need a Linux VM or server, Docker, Node.js, and your own Codex account. The guide includes requirements, service setup, first-workspace instructions, and troubleshooting.

Once configured, connect Tailscale on your device and open your server's Relay URL. Your server hosts the platform and stores your work.

Relay is intended for one owner working on trusted repositories. Remote access is controlled by Tailscale; there is no separate Relay login. Future plans for this project include allowing for multiple owners to access without need tailscale. Seperate auth is WIP tho. 
