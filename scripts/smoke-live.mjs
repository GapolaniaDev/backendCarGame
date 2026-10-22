#!/usr/bin/env node
// Live smoke test against the local Docker stack (plan card T-05, D-07).
//
//   npm run smoke:live                      # 127.0.0.1:8081, full run
//   npm run smoke:live -- --skip-docker     # HTTP checks only
//   npm run smoke:live -- --host <h> --port <p>   # explicit remote target
//
// What it checks (one OK/FAIL row each; exit code 1 if any FAIL):
//   - published ports 8081/8090/3000/9090/9100 bind to 127.0.0.1 only
//     (docker compose publishers + the host's listening sockets);
//   - device login for smoke-<date>-A/B/C; session JWT exp-iat = 7200 s and
//     refresh JWT exp-iat = 604800 s (plan D-02);
//   - every RPC registered by the built bundle answers with an envelope
//     (an unregistered id answers 404 "RPC function not found");
//   - identity (D-03): a foreign callerUserId is FORBIDDEN, an http_key call
//     without a session is UNAUTHENTICATED;
//   - minimal F0 flow: config_get, profile_get, garage_get, wallet_get, and a
//     direct client leaderboard write is rejected;
//   - `docker compose logs nakama` since the last boot: no error-level
//     lines, no "rpc registration failed", periodic service-ticker ticks.
//
// Secrets: keys are read from .env and never printed; tokens are redacted.
// Target: 127.0.0.1 unless --host is given explicitly.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_PORTS = [8081, 8090, 3000, 9090, 9100];
const COMPOSE_ARGS = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.local.yml'];
const TICK_LOG = /service ticker tick/;

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const HOST = argValue('--host', '127.0.0.1');
const PORT = Number(argValue('--port', '8081'));
const SKIP_DOCKER = argv.includes('--skip-docker') || HOST !== '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

// ── report ──────────────────────────────────────────────────────────────────
const rows = [];
function record(check, ok, detail = '') {
  rows.push({ check, status: ok === null ? 'SKIP' : ok ? 'OK' : 'FAIL', detail });
}

// ── .env (values never printed) ─────────────────────────────────────────────
function readEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) throw new Error('.env not found next to docker-compose.yml');
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// ── docker ──────────────────────────────────────────────────────────────────
function dockerBin() {
  const candidates = ['docker', 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      // try the next one
    }
  }
  return null;
}

function docker(bin, args) {
  return execFileSync(bin, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function checkPublishedPorts(bin) {
  const raw = docker(bin, [...COMPOSE_ARGS, 'ps', '--format', 'json']).trim();
  const services = raw.startsWith('[') ? JSON.parse(raw) : raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const bad = [];
  const seen = new Set();
  for (const s of services) {
    for (const p of s.Publishers ?? []) {
      if (!p.PublishedPort) continue;
      seen.add(p.PublishedPort);
      if (p.URL !== '127.0.0.1') bad.push(`${s.Name}:${p.PublishedPort} on ${p.URL || '0.0.0.0'}`);
    }
  }
  const missing = LOCAL_PORTS.filter((p) => !seen.has(p));
  record('docker publishes ports on 127.0.0.1 only', bad.length === 0, bad.join(', ') || `published: ${[...seen].sort((a, b) => a - b).join(', ')}`);
  record('all local ports published (8081 8090 3000 9090 9100)', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
}

function checkHostListeners() {
  let out;
  try {
    out = execFileSync('netstat', ['-an'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    record('host sockets listen on 127.0.0.1 only', null, 'netstat not available');
    return;
  }
  const bad = [];
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    const local = line.trim().split(/\s+/)[1] ?? '';
    const m = local.match(/^(.*)[:.](\d+)$/);
    if (!m) continue;
    const [, addr, port] = m;
    if (!LOCAL_PORTS.includes(Number(port))) continue;
    if (addr !== '127.0.0.1') bad.push(`${addr}:${port}`);
  }
  record('host sockets listen on 127.0.0.1 only', bad.length === 0, bad.join(', '));
}

function nakamaLogsSinceBoot(bin) {
  const started = docker(bin, ['inspect', '-f', '{{.State.StartedAt}}', 'nakama']).trim();
  const logs = docker(bin, [...COMPOSE_ARGS, 'logs', '--no-color', '--since', started, 'nakama']);
  return { started, lines: logs.split(/\r?\n/) };
}

function checkLogs(bin) {
  const { started, lines } = nakamaLogsSinceBoot(bin);
  const msgs = [];
  for (const line of lines) {
    const j = line.indexOf('{');
    if (j < 0) continue;
    try {
      msgs.push(JSON.parse(line.slice(j)));
    } catch {
      // not a JSON log line
    }
  }
  const errors = msgs.filter((m) => m.level === 'error' || m.level === 'fatal');
  const regFail = msgs.filter((m) => /rpc registration failed|could not be extracted/i.test(String(m.msg)));
  record('logs: no "rpc registration failed"', regFail.length === 0, regFail.map((m) => m.msg).slice(0, 3).join(' | '));
  record('logs: no error-level lines since boot', errors.length === 0,
    errors.length ? `${errors.length}: ${[...new Set(errors.map((m) => String(m.msg).slice(0, 120)))].slice(0, 4).join(' | ')}` : `since ${started}`);
  const registered = msgs.filter((m) => m.msg === 'Registered JavaScript runtime RPC function invocation').length;
  const ticks = msgs.filter((m) => TICK_LOG.test(String(m.msg)));
  const uptimeSec = (Date.now() - Date.parse(started)) / 1000;
  if (uptimeSec < 150) {
    record('logs: periodic service-ticker ticks', ticks.length > 0 ? true : null,
      `${ticks.length} tick(s), uptime ${Math.round(uptimeSec)} s (need >= 150 s to require 2)`);
  } else {
    record('logs: periodic service-ticker ticks', ticks.length >= 2, `${ticks.length} tick(s) in ${Math.round(uptimeSec)} s`);
  }
  return registered;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
async function http(method, path, { body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { nonJson: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

function jwtClaims(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

async function authDevice(serverKey, deviceId) {
  const basic = Buffer.from(`${serverKey}:`).toString('base64');
  const r = await http('POST', '/v2/account/authenticate/device?create=true', {
    body: { id: deviceId },
    headers: { Authorization: `Basic ${basic}` },
  });
  if (r.status !== 200 || !r.json?.token) throw new Error(`device auth failed: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return { token: r.json.token, refresh: r.json.refresh_token, uid: jwtClaims(r.json.token).uid };
}

/** POST /v2/rpc/{id}: the HTTP body is the payload serialized as a JSON string. */
async function rpc(token, id, payload, { httpKey } = {}) {
  const path = httpKey ? `/v2/rpc/${id}?http_key=${encodeURIComponent(httpKey)}` : `/v2/rpc/${id}`;
  const r = await http('POST', path, {
    body: JSON.stringify(JSON.stringify(payload ?? {})),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let envelope = null;
  if (typeof r.json?.payload === 'string') {
    try {
      envelope = JSON.parse(r.json.payload);
    } catch {
      envelope = null;
    }
  }
  return { status: r.status, envelope, raw: r.json };
}

const errCode = (r) => r.envelope?.error?.code ?? (r.envelope?.ok ? 'ok' : `HTTP ${r.status}`);

function bundleRpcIds() {
  const file = resolve(ROOT, 'modules', 'index.js');
  const src = readFileSync(file, 'utf8');
  return [...new Set([...src.matchAll(/initializer\.registerRpc\("([a-z0-9_]+)"/g)].map((m) => m[1]))].sort();
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`smoke-live → ${BASE}${SKIP_DOCKER ? ' (docker checks skipped)' : ''}`);
  const env = readEnv();
  const serverKey = env.NAKAMA_SERVER_KEY;
  const httpKey = env.NAKAMA_RUNTIME_HTTP_KEY;
  if (!serverKey) throw new Error('NAKAMA_SERVER_KEY missing in .env');

  let bin = null;
  if (!SKIP_DOCKER) {
    bin = dockerBin();
    if (!bin) {
      record('docker CLI available', false, 'docker not found (add Docker Desktop resources/bin to PATH)');
    } else {
      checkPublishedPorts(bin);
      checkHostListeners();
    }
  }

  // Accounts.
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const accounts = {};
  for (const name of ['A', 'B', 'C']) {
    accounts[name] = await authDevice(serverKey, `smoke-${day}-${name}-device`);
  }
  record('device login A/B/C', true, Object.entries(accounts).map(([k, v]) => `${k}=${v.uid.slice(0, 8)}…`).join(' '));
  const a = accounts.A;
  const b = accounts.B;
  const c = accounts.C;
  const claims = jwtClaims(a.token);
  record('session JWT exp - iat = 7200 s', claims.exp - claims.iat === 7200, `exp-iat=${claims.exp - claims.iat}`);
  const rclaims = jwtClaims(a.refresh);
  record('refresh JWT exp - iat = 604800 s', rclaims.exp - rclaims.iat === 604800, `exp-iat=${rclaims.exp - rclaims.iat}`);

  // Registration: every id the bundle registers must answer with an envelope.
  const ids = bundleRpcIds();
  const missing = [];
  const noEnvelope = [];
  for (const id of ids) {
    const r = await rpc(c.token, id, {});
    if (r.status === 404 && /RPC function not found/i.test(JSON.stringify(r.raw))) missing.push(id);
    else if (!r.envelope) noEnvelope.push(`${id}(HTTP ${r.status})`);
  }
  record(`RPCs registered ${ids.length - missing.length}/${ids.length}`, missing.length === 0, missing.join(', '));
  record('every RPC answers with an envelope', noEnvelope.length === 0, noEnvelope.slice(0, 8).join(', '));
  const probe = await rpc(c.token, 'smoke_not_a_real_rpc', {});
  record('unknown RPC id → 404 (probe is meaningful)', probe.status === 404, `HTTP ${probe.status}`);

  // Identity (D-03).
  const sg = await rpc(a.token, 'race_session_get', { callerUserId: b.uid });
  record('race_session_get with another account → FORBIDDEN', errCode(sg) === 'FORBIDDEN', errCode(sg));
  const wg = await rpc(a.token, 'wallet_get', { callerUserId: b.uid });
  record('wallet_get with another account → FORBIDDEN', errCode(wg) === 'FORBIDDEN', errCode(wg));
  if (httpKey) {
    const nk = await rpc(null, 'wallet_get', { callerUserId: a.uid }, { httpKey });
    record('http_key call without session → UNAUTHENTICATED', errCode(nk) === 'UNAUTHENTICATED', errCode(nk));
  } else {
    record('http_key call without session → UNAUTHENTICATED', null, 'NAKAMA_RUNTIME_HTTP_KEY not in .env');
  }

  // Minimal F0 flow (what BackendSmoke needs first).
  const cfg = await rpc(a.token, 'config_get', {});
  record('config_get ok with serverTimeMs', cfg.envelope?.ok === true && typeof cfg.envelope?.data?.serverTimeMs === 'number', errCode(cfg));
  for (const id of ['profile_get', 'garage_get', 'wallet_get']) {
    const r = await rpc(a.token, id, { callerUserId: a.uid, clientVersion: '0.1.0', platform: 'android' });
    record(`${id} (own account) ok`, r.envelope?.ok === true, errCode(r));
  }
  const lbw = await http('POST', '/v2/leaderboard/wins_week', {
    body: { score: '999' },
    headers: { Authorization: `Bearer ${a.token}` },
  });
  record('client leaderboard write rejected', lbw.status >= 400, `HTTP ${lbw.status}`);

  if (bin) {
    const registered = checkLogs(bin);
    record('logs: RPC registrations since boot', registered === ids.length, `${registered}/${ids.length}`);
  }
}

function printTable() {
  const w = Math.max(...rows.map((r) => r.check.length), 10);
  console.log('');
  for (const r of rows) {
    console.log(`${r.status.padEnd(4)}  ${r.check.padEnd(w)}  ${r.detail}`);
  }
  const fails = rows.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${rows.length - fails}/${rows.length} checks without FAIL${fails ? ` — ${fails} FAIL` : ''}`);
  return fails;
}

main()
  .catch((e) => record('smoke run', false, e instanceof Error ? e.message : String(e)))
  .finally(() => {
    process.exitCode = printTable() > 0 ? 1 : 0;
  });
