<div align="center">

# local-tunnel

**Expose any local port to the internet using your own SSH server — no accounts, no rate limits**

[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen?labelColor=0B0A09)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?labelColor=0B0A09)](package.json)

</div>

## Install

```bash
npx github:NickCirv/local-tunnel <port> --host my.server.com
```

## Usage

```bash
# Expose a local port
npx github:NickCirv/local-tunnel 3000 --host my.server.com

# Serve a static directory and tunnel it
npx github:NickCirv/local-tunnel serve ./dist --host my.server.com --qr
```

| Flag | Description |
|------|-------------|
| `--host <ssh-host>` | SSH server hostname (or set `LOCAL_TUNNEL_HOST` env var) |
| `--remote-port <n>` | Fixed port on remote server (default: random 10000–65535) |
| `--user <username>` | SSH username (or set `LOCAL_TUNNEL_USER` env var) |
| `--key <path>` | Path to SSH private key (default: `~/.ssh/id_rsa`) |
| `--url` | Print tunnel URL and exit (useful in scripts) |
| `--qr` | Print ASCII QR code of the URL |
| `--duration <seconds>` | Auto-close after N seconds |
| `--no-color` | Disable ANSI colors |

## What it does

`local-tunnel` spawns an SSH subprocess with `-R` (remote port forwarding) to route public traffic from your server to a local port. It requires a VPS you control with `GatewayPorts clientspecified` enabled in `sshd_config`. The `serve` subcommand also spins up a zero-dependency HTTP file server locally before tunnelling, letting you expose a static directory in one command. Auto-reconnects up to 3 times on connection drop with exponential backoff.

---
<sub>Zero dependencies · Node ≥ 18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
