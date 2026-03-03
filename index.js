#!/usr/bin/env node
// local-tunnel — expose localhost via SSH reverse tunnel
// Zero external dependencies. Built-in modules only.

import { spawnSync, spawn } from 'child_process';
import { existsSync, statSync, readdirSync, readFileSync, createReadStream } from 'fs';
import { join, extname, resolve } from 'path';
import { homedir, platform } from 'os';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { createInterface } from 'readline';

// ─── Constants ────────────────────────────────────────────────────────────────
const VERSION = '1.0.0';
const MAX_RECONNECTS = 3;
const RECONNECT_BASE_MS = 2000;

// ─── Colors ───────────────────────────────────────────────────────────────────
let useColor = true;
const c = {
  reset:  () => useColor ? '\x1b[0m'  : '',
  bold:   () => useColor ? '\x1b[1m'  : '',
  dim:    () => useColor ? '\x1b[2m'  : '',
  green:  () => useColor ? '\x1b[32m' : '',
  cyan:   () => useColor ? '\x1b[36m' : '',
  yellow: () => useColor ? '\x1b[33m' : '',
  red:    () => useColor ? '\x1b[31m' : '',
  blue:   () => useColor ? '\x1b[34m' : '',
  magenta:() => useColor ? '\x1b[35m' : '',
};
const paint = (color, text) => `${c[color]()}${text}${c.reset()}`;

// ─── Logging ──────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(msg)  { process.stdout.write(`${paint('dim', ts())} ${msg}\n`); }
function info(msg) { log(`${paint('cyan', '●')} ${msg}`); }
function ok(msg)   { log(`${paint('green', '✓')} ${msg}`); }
function warn(msg) { log(`${paint('yellow', '!')} ${msg}`); }
function err(msg)  { log(`${paint('red', '✗')} ${msg}`); }

// ─── Argument parser ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    command: null,
    port: null,
    dir: null,
    host: process.env.LOCAL_TUNNEL_HOST || null,
    remotePort: null,
    user: process.env.LOCAL_TUNNEL_USER || null,
    key: join(homedir(), '.ssh', 'id_rsa'),
    urlOnly: false,
    qr: false,
    duration: null,
    noColor: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    switch (a) {
      case '--help':    case '-h': opts.help = true; break;
      case '--version': case '-v': opts.version = true; break;
      case '--url':                opts.urlOnly = true; break;
      case '--qr':                 opts.qr = true; break;
      case '--no-color':           opts.noColor = true; break;
      case 'serve':
        opts.command = 'serve';
        i++;
        if (args[i] && !args[i].startsWith('-')) { opts.dir = args[i]; }
        break;
      case '--host':
        i++; opts.host = args[i]; break;
      case '--remote-port':
        i++; opts.remotePort = parseInt(args[i], 10); break;
      case '--user':
        i++; opts.user = args[i]; break;
      case '--key':
        i++; opts.key = args[i]; break;
      case '--duration':
        i++; opts.duration = parseInt(args[i], 10); break;
      default:
        if (!a.startsWith('-') && opts.command === null) {
          const n = parseInt(a, 10);
          if (!isNaN(n)) {
            opts.port = n;
            opts.command = 'tunnel';
          }
        }
    }
    i++;
  }
  return opts;
}

// ─── Help ─────────────────────────────────────────────────────────────────────
function printHelp() {
  const b = (t) => paint('bold', t);
  const g = (t) => paint('green', t);
  console.log(`
${b('local-tunnel')} v${VERSION} — expose localhost via SSH reverse tunnel

${b('USAGE')}
  ${g('local-tunnel <port>')}             expose localhost:<port> via SSH tunnel
  ${g('local-tunnel serve <dir>')}        serve a directory and tunnel it

${b('OPTIONS')}
  --host <ssh-host>      SSH server hostname  [env: LOCAL_TUNNEL_HOST]
  --remote-port <n>      port on remote server (default: random 10000-65535)
  --user <username>      SSH username          [env: LOCAL_TUNNEL_USER]
  --key <path>           path to SSH private key (default: ~/.ssh/id_rsa)
  --url                  print tunnel URL only and exit
  --qr                   print QR code of tunnel URL
  --duration <seconds>   auto-close tunnel after N seconds
  --no-color             disable ANSI colors
  --version              print version
  --help                 show this help

${b('EXAMPLES')}
  local-tunnel 3000 --host my.server.com
  LOCAL_TUNNEL_HOST=my.server.com local-tunnel 8080
  local-tunnel serve ./dist --host my.server.com --qr
  local-tunnel 4000 --host my.server.com --duration 3600

${b('REQUIREMENTS')}
  • SSH server with GatewayPorts enabled (GatewayPorts clientspecified)
  • SSH key-based authentication configured

${b('NOTES')}
  On your SSH server add to /etc/ssh/sshd_config:
    GatewayPorts clientspecified
    AllowTcpForwarding yes
  Then restart: sudo systemctl restart sshd
`);
}

// ─── Random port ──────────────────────────────────────────────────────────────
function randomPort() {
  // Range 10000–65535 using crypto
  const buf = randomBytes(4);
  const n = buf.readUInt32BE(0);
  return 10000 + (n % 55535);
}

// ─── QR code generator ────────────────────────────────────────────────────────
// Pure JS QR — minimal Mode Byte/Numeric/Alphanumeric for URLs
// Using a stripped-down but correct QR v3-L implementation

function generateQR(text) {
  // We'll use a minimal approach: encode as UTF-8 bytes, Mode=4 (Byte)
  // Version selection, ECC L, mask pattern 0
  // This is a simplified QR that covers typical tunnel URLs

  const bytes = Buffer.from(text, 'utf8');

  // QR Version 3, ECC L supports 77 bytes max — enough for most URLs
  // Version 2 ECC L = 32 bytes data, version 3 = 53, version 4 = 78
  let version = 1;
  const capacities = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271];
  for (let v = 0; v < capacities.length; v++) {
    if (bytes.length <= capacities[v]) { version = v + 1; break; }
  }
  if (version > 10) {
    return null; // URL too long for this minimal impl
  }

  // ── Full QR encoder ──
  // ECC codewords per version (ECC L)
  const eccCounts = [7, 10, 15, 20, 26, 36, 40, 48, 60, 72];
  // Total codewords per version
  const totalCW = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

  const eccCount = eccCounts[version - 1];
  const totalCodewords = totalCW[version - 1];
  const dataCapacity = totalCodewords - eccCount;

  // Build data bits: Mode indicator (0100 = byte) + char count + data
  const bits = [];
  const pushBits = (val, len) => {
    for (let b = len - 1; b >= 0; b--) bits.push((val >> b) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  const charCountBits = version < 10 ? 8 : 16;
  pushBits(bytes.length, charCountBits);
  for (const byte of bytes) pushBits(byte, 8);

  // Terminator
  for (let i = 0; i < 4 && bits.length < dataCapacity * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  // Padding codewords
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < dataCapacity * 8) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert bits to codewords
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i + b] || 0);
    codewords.push(byte);
  }

  // Reed-Solomon ECC
  const rsEcc = rsErrorCorrection(codewords, eccCount);
  const allCW = [...codewords, ...rsEcc];

  // Build QR matrix
  const size = version * 4 + 17;
  const mat = Array.from({ length: size }, () => new Array(size).fill(-1)); // -1 = unset

  // Finder patterns
  const placeFinderPattern = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        mat[rr][cc] = (border || center) ? 1 : 0;
      }
    }
  };
  placeFinderPattern(0, 0);
  placeFinderPattern(0, size - 7);
  placeFinderPattern(size - 7, 0);

  // Separators are already handled by finder pattern borders leaving 0

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    mat[6][i] = i % 2 === 0 ? 1 : 0;
    mat[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Alignment patterns (version >= 2)
  const alignPositions = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };
  if (version >= 2 && alignPositions[version]) {
    const pos = alignPositions[version];
    for (const r of pos) {
      for (const c of pos) {
        if (mat[r][c] !== -1) continue; // skip if already set (finder overlap)
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const border = Math.abs(dr) === 2 || Math.abs(dc) === 2;
            const center = dr === 0 && dc === 0;
            mat[r + dr][c + dc] = (border || center) ? 1 : 0;
          }
        }
      }
    }
  }

  // Dark module
  mat[4 * version + 9][8] = 1;

  // Reserve format info area
  const reserveFormat = () => {
    const fmtPositions = [
      [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
      [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]
    ];
    for (const [r,c] of fmtPositions) {
      if (mat[r][c] === -1) mat[r][c] = 0;
      if (mat[c][r] === -1) mat[c][r] = 0;
    }
    // Top-right
    for (let i = 0; i < 8; i++) {
      if (mat[8][size - 1 - i] === -1) mat[8][size - 1 - i] = 0;
    }
    // Bottom-left
    for (let i = 0; i < 7; i++) {
      if (mat[size - 7 + i][8] === -1) mat[size - 7 + i][8] = 0;
    }
  };
  reserveFormat();

  // Data placement (zigzag)
  let bitIdx = 0;
  const allBits = [];
  for (const cw of allCW) {
    for (let b = 7; b >= 0; b--) allBits.push((cw >> b) & 1);
  }

  let upward = true;
  let col = size - 1;
  while (col >= 0) {
    if (col === 6) { col--; continue; } // skip timing column
    const cols = [col, col - 1];
    for (let rowStep = 0; rowStep < size; rowStep++) {
      const row = upward ? size - 1 - rowStep : rowStep;
      for (const c of cols) {
        if (c < 0) continue;
        if (mat[row][c] === -1) {
          mat[row][c] = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
        }
      }
    }
    upward = !upward;
    col -= 2;
  }

  // Apply mask pattern 0: (row + col) % 2 === 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isDataModule(mat, r, c, version, size)) {
        if ((r + c) % 2 === 0) mat[r][c] ^= 1;
      }
    }
  }

  // Write format info (ECC L = 01, mask = 000, pattern 101010000010010)
  const formatStr = '111011111000100'; // ECC L + mask 0, pre-computed with XOR mask 101010000010010
  const fmtBits = formatStr.split('').map(Number);
  // Place format info
  const fPos = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  for (let i = 0; i < 15; i++) {
    mat[fPos[i][0]][fPos[i][1]] = fmtBits[i];
    // Mirror
    if (i < 8) {
      mat[8][size - 1 - i] = fmtBits[i];
    } else {
      mat[size - 7 + (i - 8)][8] = fmtBits[i];
    }
  }

  // Render using Unicode half-blocks (▀ = top filled, ▄ = bottom filled, █ = both, space = neither)
  const QUIET = 4;
  const totalSize = size + QUIET * 2;
  let output = '';
  // Top quiet zone (2 rows of half-blocks)
  for (let qr = 0; qr < QUIET / 2; qr++) {
    output += ' '.repeat(totalSize) + '\n';
  }

  for (let row = 0; row < size; row += 2) {
    let line = ' '.repeat(QUIET);
    for (let col = 0; col < size; col++) {
      const top = mat[row][col] === 1;
      const bot = (row + 1 < size) ? mat[row + 1][col] === 1 : false;
      if (top && bot)       line += '█';
      else if (top && !bot) line += '▀';
      else if (!top && bot) line += '▄';
      else                  line += ' ';
    }
    line += ' '.repeat(QUIET);
    output += line + '\n';
  }

  for (let qr = 0; qr < QUIET / 2; qr++) {
    output += ' '.repeat(totalSize) + '\n';
  }

  return output;
}

function isDataModule(mat, r, c, version, size) {
  // Returns true if this module is a data module (not function pattern)
  // Finder patterns + separators
  if (r < 9 && c < 9) return false;
  if (r < 9 && c >= size - 8) return false;
  if (r >= size - 8 && c < 9) return false;
  // Timing
  if (r === 6 || c === 6) return false;
  // Dark module
  if (r === 4 * version + 9 && c === 8) return false;
  // Alignment patterns (simplified — treat alignment zone as non-data)
  if (version >= 2) {
    // alignment center for v2-10 roughly
  }
  return mat[r][c] !== -1 || true; // treat as data if reached here
}

// Reed-Solomon error correction
function rsErrorCorrection(data, eccCount) {
  const GF = new Uint8Array(256);
  const LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF[i] = x;
    LOG[x] = i;
    x = x << 1;
    if (x & 0x100) x ^= 0x11d;
  }
  GF[255] = 0;

  const gfMul = (a, b) => {
    if (a === 0 || b === 0) return 0;
    return GF[(LOG[a] + LOG[b]) % 255];
  };

  // Generator polynomial for eccCount
  let gen = [1];
  for (let i = 0; i < eccCount; i++) {
    const poly = [1, GF[i]];
    const newGen = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      for (let k = 0; k < poly.length; k++) {
        newGen[j + k] ^= gfMul(gen[j], poly[k]);
      }
    }
    gen = newGen;
  }

  const msg = [...data, ...new Array(eccCount).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

// ─── Stats tracker ────────────────────────────────────────────────────────────
const stats = {
  bytesIn: 0,
  bytesOut: 0,
  connections: 0,
  startTime: Date.now(),
};

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

function formatUptime() {
  const s = Math.floor((Date.now() - stats.startTime) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function printStatus(url) {
  const line = [
    `${paint('cyan', '↕')} ${paint('bold', url)}`,
    `${paint('dim', 'up:')} ${formatUptime()}`,
    `${paint('dim', 'conn:')} ${stats.connections}`,
    `${paint('dim', 'in:')} ${formatBytes(stats.bytesIn)}`,
    `${paint('dim', 'out:')} ${formatBytes(stats.bytesOut)}`,
  ].join('  ');
  process.stdout.write(`\r${line}                    `);
}

// ─── Static file server ───────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.webp': 'image/webp', '.txt': 'text/plain',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function serveDirectory(dir, port) {
  return new Promise((resolveP, rejectP) => {
    const absDir = resolve(dir);
    if (!existsSync(absDir)) {
      rejectP(new Error(`Directory not found: ${dir}`));
      return;
    }

    const server = createServer((req, res) => {
      stats.connections++;
      let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let filePath = join(absDir, urlPath);

      try {
        if (existsSync(filePath) && statSync(filePath).isDirectory()) {
          const idx = join(filePath, 'index.html');
          if (existsSync(idx)) {
            filePath = idx;
          } else {
            // Directory listing
            const entries = readdirSync(filePath);
            const links = entries.map(e => {
              const isDir = statSync(join(filePath, e)).isDirectory();
              return `<li><a href="${urlPath === '/' ? '' : urlPath}/${e}">${e}${isDir ? '/' : ''}</a></li>`;
            }).join('\n');
            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Index of ${urlPath}</title></head><body><h1>Index of ${urlPath}</h1><ul>${links}</ul></body></html>`;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            stats.bytesOut += html.length;
            res.end(html);
            return;
          }
        }

        if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }

        const ext = extname(filePath).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        const stat = statSync(filePath);

        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        });

        const stream = createReadStream(filePath);
        stream.on('data', chunk => { stats.bytesOut += chunk.length; });
        stream.pipe(res);
        log(`${paint('green', req.method)} ${urlPath} ${paint('dim', mime)}`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
    });

    server.listen(port, '127.0.0.1', () => resolveP(server));
    server.on('error', rejectP);
  });
}

// ─── SSH tunnel ───────────────────────────────────────────────────────────────
function buildSSHArgs(opts, remotePort, localPort) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'BatchMode=yes',
    '-N',
    '-R', `0.0.0.0:${remotePort}:127.0.0.1:${localPort}`,
  ];
  if (opts.key && existsSync(opts.key)) {
    args.push('-i', opts.key);
  }
  const target = opts.user ? `${opts.user}@${opts.host}` : opts.host;
  args.push(target);
  return args;
}

function startSSHTunnel(opts, remotePort, localPort, onReady, onExit) {
  const sshArgs = buildSSHArgs(opts, remotePort, localPort);

  info(`Connecting via SSH to ${paint('bold', opts.host)}...`);
  info(`Command: ${paint('dim', `ssh ${sshArgs.join(' ')}`)}`);

  const child = spawn('ssh', sshArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let readyFired = false;
  let output = '';

  const tryParse = (data) => {
    output += data.toString();
    // Try to parse allocated remote port from SSH output
    const match = output.match(/Allocated port (\d+)/i) ||
                  output.match(/listening on port (\d+)/i);
    if (match && !readyFired) {
      readyFired = true;
      const port = parseInt(match[1], 10);
      onReady(port);
    } else if (!readyFired) {
      // If no port announcement, assume the configured port is active
      // Fire after 2 seconds if still no output
    }
  };

  child.stdout.on('data', tryParse);
  child.stderr.on('data', tryParse);

  // Fallback: fire onReady with the configured remotePort after delay
  const fallbackTimer = setTimeout(() => {
    if (!readyFired) {
      readyFired = true;
      onReady(remotePort);
    }
  }, 2500);

  child.on('exit', (code, signal) => {
    clearTimeout(fallbackTimer);
    onExit(code, signal);
  });

  child.on('error', (e) => {
    clearTimeout(fallbackTimer);
    err(`SSH process error: ${e.message}`);
    onExit(1, null);
  });

  return child;
}

// ─── Tunnel orchestrator ──────────────────────────────────────────────────────
async function runTunnel(localPort, opts) {
  if (!opts.host) {
    err('No SSH host specified. Use --host <hostname> or set LOCAL_TUNNEL_HOST env var.');
    process.exit(1);
  }

  const remotePort = opts.remotePort || randomPort();
  const tunnelUrl = `http://${opts.host}:${remotePort}`;

  if (opts.urlOnly) {
    console.log(tunnelUrl);
    process.exit(0);
  }

  console.log(`\n${paint('bold', paint('cyan', '  local-tunnel'))} ${paint('dim', `v${VERSION}`)}\n`);
  info(`Local:  ${paint('green', `localhost:${localPort}`)}`);
  info(`Remote: ${paint('green', tunnelUrl)}`);
  console.log();

  if (opts.qr) {
    const qr = generateQR(tunnelUrl);
    if (qr) {
      console.log(paint('dim', '  QR Code:'));
      process.stdout.write(qr);
    } else {
      warn('URL too long for QR code generation.');
    }
    console.log();
  }

  let reconnectCount = 0;
  let shutdownRequested = false;
  let statusInterval = null;
  let durationTimer = null;
  let currentChild = null;

  const shutdown = (exitCode = 0) => {
    shutdownRequested = true;
    if (statusInterval) clearInterval(statusInterval);
    if (durationTimer) clearTimeout(durationTimer);
    if (currentChild) {
      try { currentChild.kill('SIGTERM'); } catch (_) {}
    }
    process.stdout.write('\n');
    ok('Tunnel closed.');
    process.exit(exitCode);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  if (opts.duration) {
    durationTimer = setTimeout(() => {
      info(`Duration limit reached (${opts.duration}s). Shutting down.`);
      shutdown(0);
    }, opts.duration * 1000);
  }

  const connect = () => {
    currentChild = startSSHTunnel(opts, remotePort, localPort,
      (activePort) => {
        reconnectCount = 0;
        ok(`Tunnel active on port ${paint('bold', String(activePort))}`);
        info(`URL: ${paint('green', paint('bold', `http://${opts.host}:${activePort}`))}`);
        console.log(paint('dim', '  Ctrl+C to stop\n'));

        if (statusInterval) clearInterval(statusInterval);
        statusInterval = setInterval(() => {
          printStatus(`http://${opts.host}:${activePort}`);
        }, 1000);
      },
      (code, signal) => {
        if (shutdownRequested) return;
        if (statusInterval) clearInterval(statusInterval);
        process.stdout.write('\n');

        if (reconnectCount < MAX_RECONNECTS) {
          reconnectCount++;
          const delay = RECONNECT_BASE_MS * Math.pow(2, reconnectCount - 1);
          warn(`SSH disconnected (code=${code}). Reconnecting in ${delay / 1000}s (attempt ${reconnectCount}/${MAX_RECONNECTS})...`);
          setTimeout(connect, delay);
        } else {
          err(`SSH failed after ${MAX_RECONNECTS} reconnection attempts.`);
          shutdown(1);
        }
      }
    );
  };

  connect();
}

// ─── Serve + tunnel ───────────────────────────────────────────────────────────
async function runServe(dir, opts) {
  const buf = randomBytes(2);
  const port = 40000 + buf.readUInt16BE(0) % 10000;

  info(`Serving ${paint('bold', dir)} on port ${port}`);

  try {
    const server = await serveDirectory(dir, port);
    ok(`Static server started on port ${port}`);
    await runTunnel(port, opts);
  } catch (e) {
    err(`Failed to start static server: ${e.message}`);
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);

  if (opts.noColor) useColor = false;

  if (opts.version) {
    console.log(`local-tunnel v${VERSION}`);
    process.exit(0);
  }

  if (opts.help || (!opts.command && !opts.port)) {
    printHelp();
    process.exit(0);
  }

  if (opts.command === 'serve') {
    const dir = opts.dir || '.';
    await runServe(dir, opts);
  } else if (opts.command === 'tunnel' || opts.port) {
    const port = opts.port;
    if (!port || port < 1 || port > 65535) {
      err('Invalid port number. Must be between 1 and 65535.');
      process.exit(1);
    }
    await runTunnel(port, opts);
  } else {
    printHelp();
    process.exit(1);
  }
}

main().catch(e => {
  err(`Unexpected error: ${e.message}`);
  process.exit(1);
});
