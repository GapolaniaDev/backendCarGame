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
//   - per-VM runtime state (T-29, audit N8): a brand-new account gets its
//     profile and garage from the after-auth hook, and a valid 1-player
//     private race (neon_blvd, class S, 3 x 32.1 s after a ~97 s wait) ends
//     `closed` with rewards (`--skip-race` skips the wait);
//   - `docker compose logs nakama` since the last boot: no error-level
//     lines, no "rpc registration failed", no "auto-create failed",
//     periodic service-ticker ticks, and the cost of loading the runtime
//     state in each VM (R-07: one "runtime state ready" line per VM).
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
const SKIP_RACE = argv.includes('--skip-race');
const BASE = `http://${HOST}:${PORT}`;
const RUNTIME_READY_LOG = /^runtime state ready: .* in (\d+)ms \((boot|vm)\)$/;
/** R-07 budget for loading the runtime state in one VM. */
const RUNTIME_LOAD_BUDGET_MS = 1000;
// 1-player private race: neon_blvd private = 3 laps, class S >= 32 000 ms/lap.
const RACE_LAPS = [32_100, 32_100, 32_100];
const RACE_TOTAL_MS = RACE_LAPS.reduce((x, y) => x + y, 0);

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
  // The subscription scanner reports its failures at warn level.
  const scannerErrors = msgs.filter((m) => (m.level === 'error' || m.level === 'warn')
    && /scanner|ticker/i.test(String(m.msg)) && /fail|could not/i.test(String(m.msg)));
  record('logs: no scanner / service-ticker errors', scannerErrors.length === 0,
    scannerErrors.map((m) => String(m.msg).slice(0, 120)).slice(0, 3).join(' | '));
  record('logs: no error-level lines since boot', errors.length === 0,
    errors.length ? `${errors.length}: ${[...new Set(errors.map((m) => String(m.msg).slice(0, 120)))].slice(0, 4).join(' | ')}` : `since ${started}`);
  const autoCreate = msgs.filter((m) => /auto-create failed/i.test(String(m.msg)));
  record('logs: no after-auth "auto-create failed"', autoCreate.length === 0,
    autoCreate.map((m) => String(m.msg).slice(0, 120)).slice(0, 2).join(' | '));
  const noBus = msgs.filter((m) => /no EventBus installed/i.test(String(m.msg)));
  record('logs: no race closes skipped for a missing EventBus', noBus.length === 0, noBus.length ? `${noBus.length} line(s)` : '');
  // R-07: one line per VM that loaded its state, with the load time.
  const loads = msgs.map((m) => RUNTIME_READY_LOG.exec(String(m.msg))).filter(Boolean)
    .map((m) => ({ ms: Number(m[1]), kind: m[2] }));
  const vmLoads = loads.filter((l) => l.kind === 'vm').map((l) => l.ms).sort((x, y) => x - y);
  const boot = loads.find((l) => l.kind === 'boot');
  const median = vmLoads.length ? vmLoads[Math.floor(vmLoads.length / 2)] : 0;
  const max = vmLoads.length ? vmLoads[vmLoads.length - 1] : 0;
  record('R-07: runtime state load per VM', vmLoads.length > 0 && max <= RUNTIME_LOAD_BUDGET_MS,
    `${vmLoads.length} VM(s): median ${median} ms, max ${max} ms (budget ${RUNTIME_LOAD_BUDGET_MS} ms); boot ${boot ? `${boot.ms} ms` : 'n/a'}`);
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

// ── 1-player private race (T-29: the race bus exists in every VM) ───────────
async function startPrivateRace(acct) {
  const created = await rpc(acct.token, 'race_session_create', {
    matchId: `smoke-${Date.now()}`,
    mode: 'private',
    trackId: 'neon_blvd',
    size: 2,
    hostLoadout: { classId: 'S', bodyId: 'coupe' },
    hostUserId: acct.uid,
  });
  if (created.envelope?.ok !== true) {
    record('1-player private race closes with rewards', false, `create: ${errCode(created)}`);
    return null;
  }
  const sessionId = created.envelope.data.sessionId;
  const started = await rpc(acct.token, 'race_session_start', { sessionId });
  if (started.envelope?.ok !== true) {
    record('1-player private race closes with rewards', false, `start: ${errCode(started)}`);
    return null;
  }
  return { sessionId, startedAtMs: Date.now() };
}

async function finishPrivateRace(acct, race) {
  // The server accepts totalMs <= elapsed clock (+500 ms): wait it out.
  const waitMs = race.startedAtMs + RACE_TOTAL_MS + 1500 - Date.now();
  if (waitMs > 0) {
    console.log(`waiting ${Math.ceil(waitMs / 1000)} s for the race clock…`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const sub = await rpc(acct.token, 'race_submit_result', {
    sessionId: race.sessionId,
    report: { userId: acct.uid, totalMs: RACE_TOTAL_MS, laps: RACE_LAPS, isBotReport: false },
  });
  const got = await rpc(acct.token, 'race_session_get', { sessionId: race.sessionId });
  const state = got.envelope?.data?.session?.state;
  const rewards = sub.envelope?.data?.rewards?.[acct.uid];
  record('1-player private race closes with rewards',
    sub.envelope?.ok === true && state === 'closed' && rewards !== undefined,
    `submit=${errCode(sub)} state=${state} confidence=${sub.envelope?.data?.confidence} rewards=${JSON.stringify(rewards ?? null).slice(0, 120)}`);
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

  // A brand-new account (unique per run): checks the after-auth hook and
  // runs the race, so the private-room reward cap (3/day) never applies.
  const fresh = await authDevice(serverKey, `smoke-${day}-${Date.now()}-D-device`);
  // Start the 1-player race now; the other checks run while its clock does.
  const race = SKIP_RACE ? null : await startPrivateRace(fresh);

  // Registration: every id the bundle registers must answer with an envelope.
  const ids = bundleRpcIds();
  const missing = [];
  const noEnvelope = [];
  const latencies = [];
  for (const id of ids) {
    const t0 = Date.now();
    const r = await rpc(c.token, id, {});
    latencies.push(Date.now() - t0);
    if (r.status === 404 && /RPC function not found/i.test(JSON.stringify(r.raw))) missing.push(id);
    else if (!r.envelope) noEnvelope.push(`${id}(HTTP ${r.status})`);
  }
  record(`RPCs registered ${ids.length - missing.length}/${ids.length}`, missing.length === 0, missing.join(', '));
  record('every RPC answers with an envelope', noEnvelope.length === 0, noEnvelope.slice(0, 8).join(', '));
  latencies.sort((x, y) => x - y);
  record('R-07: client latency of the RPC sweep', true,
    `median ${latencies[Math.floor(latencies.length / 2)]} ms, max ${latencies[latencies.length - 1]} ms over ${latencies.length} calls`);

  // After-auth (T-29): a brand-new account gets a profile and a garage.
  for (const id of ['profile_get', 'garage_get']) {
    const r = await rpc(fresh.token, id, { clientVersion: '0.1.0', platform: 'android' });
    record(`${id} (brand-new account) ok`, r.envelope?.ok === true, errCode(r));
  }
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

  if (race) await finishPrivateRace(fresh, race);
  else record('1-player private race closes with rewards', null, '--skip-race');

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
