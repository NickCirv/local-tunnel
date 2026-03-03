# local-tunnel

Expose localhost to the internet via SSH reverse tunnel. A zero-dependency ngrok alternative that uses your own SSH server.

```
local-tunnel 3000 --host my.server.com
```

**No external npm dependencies.** Built on Node.js built-in modules only (`fs`, `path`, `os`, `crypto`, `net`, `http`, `child_process`, etc.)

---

## Requirements

- Node.js >= 18
- An SSH server you control with the following in `/etc/ssh/sshd_config`:

```
GatewayPorts clientspecified
AllowTcpForwarding yes
```

Then restart: `sudo systemctl restart sshd`

---

## Installation

### npx (no install)

```bash
npx local-tunnel 3000 --host my.server.com
```

### Global install

```bash
npm install -g local-tunnel
```

### Clone and run

```bash
git clone https://github.com/NickCirv/local-tunnel.git
cd local-tunnel
node index.js 3000 --host my.server.com
```

---

## Usage

```
local-tunnel <port> [options]
local-tunnel serve <dir> [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--host <ssh-host>` | SSH server hostname | `LOCAL_TUNNEL_HOST` env var |
| `--remote-port <n>` | Port on the remote server | Random (10000–65535) |
| `--user <username>` | SSH username | `LOCAL_TUNNEL_USER` env var |
| `--key <path>` | Path to SSH private key | `~/.ssh/id_rsa` |
| `--url` | Print the tunnel URL and exit | — |
| `--qr` | Print ASCII QR code of the URL | — |
| `--duration <seconds>` | Auto-close after N seconds | — |
| `--no-color` | Disable ANSI colors | — |
| `--version` | Print version | — |
| `--help` | Show help | — |

### Environment variables

| Variable | Description |
|----------|-------------|
| `LOCAL_TUNNEL_HOST` | Default SSH server hostname |
| `LOCAL_TUNNEL_USER` | Default SSH username |

---

## Examples

```bash
# Expose port 3000 via SSH server
local-tunnel 3000 --host my.server.com

# Using environment variable for host
export LOCAL_TUNNEL_HOST=my.server.com
local-tunnel 8080

# With SSH username and custom key
local-tunnel 3000 --host my.server.com --user ubuntu --key ~/.ssh/my_key

# Fix the remote port instead of using a random one
local-tunnel 3000 --host my.server.com --remote-port 9000

# Print tunnel URL only (useful in scripts)
local-tunnel 3000 --host my.server.com --url

# Print QR code (scan with phone to open instantly)
local-tunnel 3000 --host my.server.com --qr

# Auto-close after 1 hour
local-tunnel 3000 --host my.server.com --duration 3600

# Serve a static directory and tunnel it
local-tunnel serve ./dist --host my.server.com

# Serve current directory
local-tunnel serve . --host my.server.com --qr

# Short alias
ltunnel 3000 --host my.server.com
```

---

## Status display

While the tunnel is active, a live status bar updates every second:

```
↕ http://my.server.com:42819  up: 4m 12s  conn: 7  in: 12.4KB  out: 2.1MB
```

---

## How it works

`local-tunnel` spawns an `ssh` subprocess with the `-R` flag (remote port forwarding):

```
ssh -R 0.0.0.0:<remote-port>:127.0.0.1:<local-port> -N <user>@<host>
```

Traffic hitting `my.server.com:<remote-port>` is forwarded by SSH to `localhost:<local-port>` on your machine. No relay servers, no accounts, no rate limits.

### Reconnection

If the SSH connection drops, `local-tunnel` automatically reconnects up to 3 times with exponential backoff (2s, 4s, 8s).

### `serve` subcommand

`local-tunnel serve <dir>` starts a zero-dependency HTTP file server (built on Node's `http` module) on a random local port, then tunnels that port — exposing your static files to the internet in one command.

### QR code

The `--qr` flag generates an ASCII QR code using pure JavaScript (no libraries). It uses Unicode block characters (`█ ▀ ▄`) for a compact, readable QR in most terminals.

---

## Server setup guide

### DigitalOcean / Linode / any VPS

1. Create a droplet (Ubuntu 22.04, $4/mo cheapest tier works)
2. SSH into your server
3. Edit `/etc/ssh/sshd_config`:
   ```
   GatewayPorts clientspecified
   AllowTcpForwarding yes
   ```
4. Restart SSH: `sudo systemctl restart sshd`
5. Open the port range in your firewall:
   ```bash
   sudo ufw allow 10000:65535/tcp
   ```
6. Run `local-tunnel`:
   ```bash
   local-tunnel 3000 --host YOUR_SERVER_IP --user root
   ```

---

## Security

- Zero external npm dependencies — no supply chain risk
- Uses `spawnSync`/`spawn` only — never `exec`
- Sensitive values via environment variables only — never hardcoded
- Uses `crypto.randomBytes()` for port selection — not `Math.random()`
- Traffic is encrypted by SSH in transit between your machine and the server

**Note:** traffic from the remote server port to the internet is plain HTTP unless you configure TLS (e.g., nginx + Let's Encrypt) on the server side.

---

## Comparison

| | local-tunnel | ngrok | cloudflared |
|---|---|---|---|
| Requires your own server | Yes | No | No |
| External dependencies | 0 | N/A | N/A |
| Rate limits | None | Free tier limited | Free tier limited |
| Cost | Your server cost | Free/paid plans | Free/paid plans |
| Account required | No | Yes | Yes |
| Works offline/LAN | N/A | No | No |

---

## License

MIT — Nicholas Ashkar / NickCirv
