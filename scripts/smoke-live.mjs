#!/usr/bin/env node
// Live smoke test against the local Docker stack (plan card T-05, D-07).
//
//   npm run smoke:live                      # 127.0.0.1:8081, full run
//   npm run smoke:live -- --skip-docker     # HTTP checks only
//   npm run smoke:live -- --skip-restart    # no Nakama restart at the end
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
//     private race (neon_blvd, the starter car's class D, 3 x 48.1 s after
//     a ~146 s wait) ends `closed` (`--skip-race` skips every race);
//   - F1 races (plan T-06…T-10), with fresh accounts, during the same wait:
//     a 3-account race where one never reports closes after
//     CLOSE_GRACE_MS with that player DNF and its late report CONFLICT;
//     a declared unowned class-S car keeps the class-D floor; the
//     active session comes back from race_session_get without an id; a
//     host that stops polling is claimed by the next player (NOT_HOST
//     while it polls) and its race is closed by the service ticker; two
//     matchmaker sockets get the same race session; a submit retried
//     with the same requestId after > 60 s returns the same response;
//   - F2 economy and store (plan T-11, T-12), with fresh accounts funded
//     through the local console (127.0.0.1:8090, credentials from .env):
//     the closing race submit pays its rewards (no wallet-ledger errors);
//     10 concurrent store_buy of one offer charge once (wallet and ledger);
//     the price charged equals store_get's finalPrice and every offer
//     reports owned; no special_offer names a SKU unknown to store.json;
//     concurrent buys of different offers that lose the garage CAS charge
//     nothing and their rebuy charges (HT-73); then Nakama is restarted
//     (same compose files) and neither a rebuy nor a retried race submit
//     charges or pays again (`--skip-restart` skips this part);
//   - `docker compose logs nakama` since the last boot: no error-level
//     lines, no "rpc registration failed", no "auto-create failed",
//     periodic service-ticker ticks, and the cost of loading the runtime
//     state in each VM (R-07: one "runtime state ready" line per VM).
//     Nakama logs every rolled-back multiUpdate at error level; the
//     rollbacks the smoke provokes on purpose (lost CAS, short balance)
//     are counted in their own row instead.
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
const SKIP_RESTART = argv.includes('--skip-restart');
const BASE = `http://${HOST}:${PORT}`;
const RUNTIME_READY_LOG = /^runtime state ready: .* in (\d+)ms \((boot|vm)\)$/;
/** R-07 budget for loading the runtime state in one VM. */
const RUNTIME_LOAD_BUDGET_MS = 1000;
// Races: neon_blvd private = 3 laps; the starter car is class D (>= 48 000
// ms/lap), and the server takes the class from the garage (T-10).
const RACE_LAPS = [48_100, 48_100, 48_100];
const RACE_TOTAL_MS = RACE_LAPS.reduce((x, y) => x + y, 0);
/** Valid only for a class-S car (>= 32 000 ms/lap): below the class-D floor. */
const S_LAPS = [32_100, 32_100, 32_100];
/** Server constants (modules/src/race/constants.ts). */
const CLOSE_GRACE_MS = 30_000;
const HOST_STALE_MS = 10_000;
/** The wallet ledger bug fixed by T-11 (F2): text of its log lines. */
const T11_LOG = /walletLedgerUpdate|race close payout failed|no rows in result set/i;
/** A rolled-back multiUpdate the smoke provokes on purpose (core_multi.go). */
const EXPECTED_ROLLBACK = /version check failed|rejected negative value/;
const isExpectedRollback = (m) => m.msg === 'Error running multi update.' && EXPECTED_ROLLBACK.test(String(m.error));
/** RPCs that still answer HTTP 500 to `{}`, and the plan card that fixes each. */
const KNOWN_RPC_500 = { club_search: 'T-21 (groupsList signature)', ranked_get: 'F3 (ranked table not created yet)' };

// ── report ──────────────────────────────────────────────────────────────────
const rows = [];
function record(check, ok, detail = '') {
  rows.push({ check, status: ok === null ? 'SKIP' : ok ? 'OK' : 'FAIL', detail });
}
/** A failure that is expected until a later plan card fixes it. */
function known(check, detail) {
  rows.push({ check, status: 'KNOWN', detail });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

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

function parseLogLines(lines) {
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
  return msgs;
}

/** Error-level lines split into the expected rollbacks, the KNOWN 500s and the rest. */
function classifyErrors(msgs) {
  const allErrors = msgs.filter((m) => m.level === 'error' || m.level === 'fatal');
  const rollbacks = allErrors.filter(isExpectedRollback);
  const rpc500 = allErrors.filter((m) => m.mode === 'rpc' && m.id in KNOWN_RPC_500);
  const errors = allErrors.filter((m) => !rollbacks.includes(m) && !rpc500.includes(m));
  return { allErrors, rollbacks, rpc500, errors };
}

function recordErrors(check, { errors }, since) {
  record(check, errors.length === 0,
    errors.length ? `${errors.length}: ${[...new Set(errors.map((m) => `${String(m.msg).slice(0, 80)} ${String(m.error ?? '').slice(0, 60)}`))].slice(0, 4).join(' | ')}` : `since ${since}`);
}

function checkLogs(bin) {
  const { started, lines } = nakamaLogsSinceBoot(bin);
  const msgs = parseLogLines(lines);
  const classified = classifyErrors(msgs);
  const { allErrors, rollbacks, rpc500 } = classified;
  if (rpc500.length > 0) {
    known('logs: uncaught exceptions of RPCs fixed by later cards',
      [...new Set(rpc500.map((m) => `${m.id} → ${KNOWN_RPC_500[m.id]}`))].join(', '));
  }
  const t11 = allErrors.filter((m) => T11_LOG.test(JSON.stringify(m)));
  record('logs: no wallet-ledger errors (T-11)', t11.length === 0,
    t11.length ? `${t11.length} line(s): ${[...new Set(t11.map((m) => String(m.msg).slice(0, 80)))].slice(0, 2).join(' | ')}` : '');
  record('logs: rolled-back transactions are the provoked ones only', true,
    `${rollbacks.length} (${[...new Set(rollbacks.map((m) => String(m.error).slice(0, 50)))].join(' | ') || 'none'})`);
  const regFail = msgs.filter((m) => /rpc registration failed|could not be extracted/i.test(String(m.msg)));
  record('logs: no "rpc registration failed"', regFail.length === 0, regFail.map((m) => m.msg).slice(0, 3).join(' | '));
  // The subscription scanner reports its failures at warn level.
  const scannerErrors = msgs.filter((m) => (m.level === 'error' || m.level === 'warn')
    && /scanner|ticker/i.test(String(m.msg)) && /fail|could not/i.test(String(m.msg)));
  record('logs: no scanner / service-ticker errors', scannerErrors.length === 0,
    scannerErrors.map((m) => String(m.msg).slice(0, 120)).slice(0, 3).join(' | '));
  recordErrors('logs: no error-level lines since boot', classified, started);
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
    hostLoadout: { classId: 'D', bodyId: 'starter_viper' },
    hostUserId: acct.uid,
  });
  if (created.envelope?.ok !== true) {
    record('1-player private race closes', false, `create: ${errCode(created)}`);
    return null;
  }
  const sessionId = created.envelope.data.sessionId;
  const started = await rpc(acct.token, 'race_session_start', { sessionId });
  if (started.envelope?.ok !== true) {
    record('1-player private race closes', false, `start: ${errCode(started)}`);
    return null;
  }
  return { sessionId, startedAtMs: Date.now() };
}

/** Wait until a report of `totalMs` fits the race clock (server: totalMs <= elapsed + 500 ms). */
async function waitRaceClock(startedAtMs, totalMs = RACE_TOTAL_MS) {
  const waitMs = startedAtMs + totalMs + 1500 - Date.now();
  if (waitMs > 0) {
    console.log(`waiting ${Math.ceil(waitMs / 1000)} s for the race clock…`);
    await sleep(waitMs);
  }
}

const dLaps = (uid) => ({ userId: uid, totalMs: RACE_TOTAL_MS, laps: RACE_LAPS, isBotReport: false });

/** The closing submit pays the rewards (HTTP 500 until T-11: wallet-ledger bug). */
function recordPayoutSubmit(check, sub) {
  record(check, sub.envelope?.ok === true && sub.envelope.data?.rewards !== undefined,
    sub.envelope?.ok ? `rewards=${JSON.stringify(sub.envelope.data?.rewards ?? null).slice(0, 100)}` : errCode(sub));
}

async function finishPrivateRace(acct, race) {
  await waitRaceClock(race.startedAtMs);
  const sub = await rpc(acct.token, 'race_submit_result', { sessionId: race.sessionId, report: dLaps(acct.uid) });
  const got = await rpc(acct.token, 'race_session_get', { sessionId: race.sessionId });
  const state = got.envelope?.data?.session?.state;
  record('1-player private race closes', state === 'closed', `state=${state} submit=${errCode(sub)}`);
  recordPayoutSubmit('1-player private race: closing submit returns rewards', sub);
}

// ── F1 races (plan T-06…T-10) ───────────────────────────────────────────────
async function freshAccounts(serverKey, tag, names) {
  const out = {};
  for (const n of names) out[n] = await authDevice(serverKey, `smoke-${Date.now()}-${tag}${n}-device`);
  return out;
}

/** 3 accounts declare an unowned class-S car; P3 will never report validly. */
async function setupThreePlayerRace(p) {
  const declared = { classId: 'S', bodyId: 'titan_s1' };
  const created = await rpc(p.P1.token, 'race_session_create', {
    matchId: `smoke-f1-${Date.now()}`, mode: 'private', trackId: 'neon_blvd', size: 4,
    hostLoadout: declared, hostUserId: p.P1.uid,
  });
  if (created.envelope?.ok !== true) {
    record('F1 3-account race set up', false, `create: ${errCode(created)}`);
    return null;
  }
  const sid = created.envelope.data.sessionId;
  for (const n of ['P2', 'P3']) {
    const j = await rpc(p[n].token, 'race_session_join', { sessionId: sid, userId: p[n].uid, loadout: declared });
    if (j.envelope?.ok !== true) {
      record('F1 3-account race set up', false, `join ${n}: ${errCode(j)}`);
      return null;
    }
  }
  const started = await rpc(p.P1.token, 'race_session_start', { sessionId: sid });
  if (started.envelope?.ok !== true) {
    record('F1 3-account race set up', false, `start: ${errCode(started)}`);
    return null;
  }
  record('F1 3-account race set up', true, `sid=${sid.slice(0, 8)}…`);
  return { sid, startedAtMs: Date.now() };
}

async function checkLoadoutAndActive(p, race) {
  // T-08: P2 restarts its client and asks for its session without an id.
  const active = await rpc(p.P2.token, 'race_session_get', {});
  const s = active.envelope?.data?.session;
  record('T-08 race_session_get without id → the active session',
    s?.id === race.sid && s?.state === 'started', `${errCode(active)} sid=${String(s?.id).slice(0, 8)} state=${s?.state}`);
  // T-10: the declared class-S car is not owned → garage starter, class D.
  const classes = (s?.roster ?? []).map((e) => `${e.loadout?.bodyId}/${e.loadout?.classId}`);
  record('T-10 declared unowned class-S car → garage car class D',
    classes.length === 3 && classes.every((c) => c === 'starter_viper/D'), classes.join(' '));
}

/** H1 hosts and goes silent; H2 keeps polling and claims. */
async function hostClaimScenario(h) {
  const created = await rpc(h.H1.token, 'race_session_create', {
    matchId: `smoke-claim-${Date.now()}`, mode: 'private', trackId: 'neon_blvd', size: 2,
    hostLoadout: { classId: 'D', bodyId: 'starter_viper' }, hostUserId: h.H1.uid,
  });
  const sid = created.envelope?.data?.sessionId;
  const joined = sid ? await rpc(h.H2.token, 'race_session_join', {
    sessionId: sid, userId: h.H2.uid, loadout: { classId: 'D', bodyId: 'starter_viper' },
  }) : null;
  const started = sid ? await rpc(h.H1.token, 'race_session_start', { sessionId: sid }) : null;
  if (started?.envelope?.ok !== true) {
    record('T-07 host claim race set up', false, `create=${errCode(created)} join=${joined ? errCode(joined) : '-'} start=${started ? errCode(started) : '-'}`);
    return null;
  }
  const startedAtMs = Date.now();
  await rpc(h.H1.token, 'race_session_get', { sessionId: sid });
  const early = await rpc(h.H2.token, 'race_host_claim', { sessionId: sid });
  record('T-07 claim while the host polls → FORBIDDEN NOT_HOST',
    errCode(early) === 'FORBIDDEN' && early.envelope?.error?.details?.reason === 'NOT_HOST',
    `${errCode(early)} reason=${early.envelope?.error?.details?.reason}`);
  // H1 stops polling; H2 polls every 2 s like the client.
  const silentFrom = Date.now();
  while (Date.now() - silentFrom < HOST_STALE_MS + 2_000) {
    await rpc(h.H2.token, 'race_session_get', { sessionId: sid });
    await sleep(2_000);
  }
  const claim = await rpc(h.H2.token, 'race_host_claim', { sessionId: sid });
  const after = await rpc(h.H2.token, 'race_session_get', { sessionId: sid });
  record('T-07 host silent > HOST_STALE_MS → next player claims',
    claim.envelope?.ok === true && after.envelope?.data?.session?.host === h.H2.uid,
    `${errCode(claim)} newHost=${claim.envelope?.data?.newHost === h.H2.uid ? 'H2' : claim.envelope?.data?.newHost}`);
  return { sid, startedAtMs };
}

/** Minimal Nakama realtime client (JSON protocol) for the matchmaker. */
function openSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws?lang=en&status=false&format=json&token=${encodeURIComponent(token)}`);
    const seen = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      seen.push(msg);
      for (const w of [...waiters]) {
        if (msg[w.key] !== undefined) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg[w.key]);
        }
      }
    };
    ws.onerror = () => reject(new Error('websocket error'));
    ws.onopen = () => resolve({
      send: (obj) => ws.send(JSON.stringify(obj)),
      waitFor: (key, timeoutMs) => {
        const hit = seen.find((m) => m[key] !== undefined);
        if (hit) return Promise.resolve(hit[key]);
        return new Promise((res) => {
          const w = { key, resolve: res };
          waiters.push(w);
          setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) {
              waiters.splice(i, 1);
              res(null);
            }
          }, timeoutMs);
        });
      },
      close: () => ws.close(),
    });
  });
}

/** The matchmaker ticket exactly as the Unity client builds it (BackendCarGameTicketSource). */
function clientTicket(params) {
  const { query, metadata } = params.ticket;
  const stringProperties = { ...metadata };
  const numericProperties = {};
  const parts = [];
  for (const key of Object.keys(query).sort()) {
    const v = query[key];
    let formatted;
    if (typeof v === 'string') {
      stringProperties[key] = v;
      formatted = /^[A-Za-z0-9_.-]+$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    } else if (typeof v === 'boolean') {
      formatted = v ? 'true' : 'false';
      stringProperties[key] = formatted;
    } else if (typeof v === 'number') {
      numericProperties[key] = v;
      formatted = String(v);
    } else {
      continue;
    }
    parts.push(`+properties.${key}:${formatted}`);
  }
  const size = params.output.size;
  return { min_count: size, max_count: size, query: parts.join(' '), string_properties: stringProperties, numeric_properties: numericProperties };
}

async function matchmakerScenario(m) {
  const sockets = [];
  try {
    for (const n of ['M1', 'M2']) {
      const params = await rpc(m[n].token, 'mm_ticket_params', { mode: 'quick', size: 2 });
      if (params.envelope?.ok !== true) {
        record('T-09 matchmaker: both players get the same race session', false, `mm_ticket_params ${n}: ${errCode(params)}`);
        return;
      }
      const sock = await openSocket(m[n].token);
      sockets.push(sock);
      sock.send({ matchmaker_add: clientTicket(params.envelope.data) });
    }
    const matched = await Promise.all(sockets.map((s) => s.waitFor('matchmaker_matched', 45_000)));
    if (matched.some((x) => x === null)) {
      record('T-09 matchmaker: both players get the same race session', false, 'no matchmaker_matched within 45 s');
      return;
    }
    const got = [];
    for (const n of ['M1', 'M2']) got.push(await rpc(m[n].token, 'race_session_get', {}));
    const ids = got.map((g) => g.envelope?.data?.session?.id);
    const s = got[0]?.envelope?.data?.session;
    record('T-09 matchmaker: both players get the same race session',
      typeof ids[0] === 'string' && ids[0] === ids[1] && s?.state === 'created' && s?.roster?.length === 2,
      `${got.map(errCode).join('/')} sid=${String(ids[0]).slice(0, 8)}=${String(ids[1]).slice(0, 8)} state=${s?.state} track=${s?.trackId}`);
  } catch (e) {
    record('T-09 matchmaker: both players get the same race session', false, e instanceof Error ? e.message : String(e));
  } finally {
    for (const s of sockets) s.close();
  }
}

/** Reports, grace close, late report, requestId retry and the ticker close. */
async function finishF1Races(p, race, h, claimRace, bin) {
  await waitRaceClock(Math.max(race.startedAtMs, claimRace?.startedAtMs ?? 0));
  // T-10: P3's class-S times are below the class-D floor of its garage car.
  const fast = await rpc(p.P3.token, 'race_submit_result', {
    sessionId: race.sid, report: { userId: p.P3.uid, totalMs: S_LAPS.reduce((x, y) => x + y, 0), laps: S_LAPS, isBotReport: false },
  });
  const d = fast.envelope?.error?.details;
  record('T-10 class-S times from the class-D car → BELOW_MIN_TIME (floor unchanged)',
    errCode(fast) === 'INVALID_RESULT' && d?.reason === 'BELOW_MIN_TIME' && d?.classId === 'D',
    `${errCode(fast)} reason=${d?.reason} class=${d?.classId}`);

  const p1Submit = { sessionId: race.sid, report: dLaps(p.P1.uid), requestId: 'smoke-p1' };
  const first = await rpc(p.P1.token, 'race_submit_result', p1Submit);
  const firstReportMs = Date.now();
  const second = await rpc(p.P2.token, 'race_submit_result', { sessionId: race.sid, report: dLaps(p.P2.uid) });
  record('F1 reports from P1 and P2 accepted (race stays open for P3)',
    first.envelope?.ok === true && second.envelope?.ok === true, `${errCode(first)}/${errCode(second)}`);
  let claimReportMs = 0;
  if (claimRace) {
    const r = await rpc(h.H2.token, 'race_submit_result', { sessionId: claimRace.sid, report: dLaps(h.H2.uid) });
    claimReportMs = Date.now();
    record('T-07 new host reports; the silent old host never does', r.envelope?.ok === true, errCode(r));
  }

  // T-06: inside the grace the race is open; after it, P1's read closes it.
  const during = await rpc(p.P1.token, 'race_session_get', { sessionId: race.sid });
  const duringState = during.envelope?.data?.session?.state;
  await sleep(firstReportMs + CLOSE_GRACE_MS + 1_000 - Date.now());
  const after = await rpc(p.P1.token, 'race_session_get', { sessionId: race.sid });
  const s = after.envelope?.data?.session;
  const byUser = new Map((s?.results ?? []).map((r) => [r.userId, r]));
  record('T-06 absent player: Closed after CLOSE_GRACE_MS with the absent one DNF',
    duringState === 'started' && s?.state === 'closed' && byUser.get(p.P3.uid)?.abandoned === true
      && byUser.get(p.P1.uid)?.abandoned === false && byUser.get(p.P2.uid)?.abandoned === false,
    `during=${duringState} after=${s?.state} P3 dnf=${byUser.get(p.P3.uid)?.abandoned} ranks=${[p.P1, p.P2, p.P3].map((a) => byUser.get(a.uid)?.rank).join(',')}`);
  const late = await rpc(p.P3.token, 'race_submit_result', { sessionId: race.sid, report: dLaps(p.P3.uid) });
  record('T-06 late report after the close → CONFLICT', errCode(late) === 'CONFLICT', `${errCode(late)} ${late.envelope?.error?.details?.reason ?? ''}`);

  // T-07: nobody polls the claimed race; the service ticker closes it.
  if (claimRace && bin) {
    const deadline = claimReportMs + CLOSE_GRACE_MS + 25_000;
    let byTicker = false;
    while (!byTicker && Date.now() < deadline) {
      await sleep(5_000);
      const { lines } = nakamaLogsSinceBoot(bin);
      byTicker = lines.some((l) => l.includes(`race close due sid=${claimRace.sid} source=service_ticker`));
    }
    const got = await rpc(h.H2.token, 'race_session_get', { sessionId: claimRace.sid });
    const cs = got.envelope?.data?.session;
    const h1 = (cs?.results ?? []).find((r) => r.userId === h.H1.uid);
    record('T-06 service ticker closes a race nobody reads (silent host DNF)',
      byTicker && cs?.state === 'closed' && h1?.abandoned === true, `ticker=${byTicker} state=${cs?.state} H1 dnf=${h1?.abandoned}`);
  }

  // T-09: the same requestId more than 60 s later replays the response.
  await sleep(firstReportMs + 61_000 - Date.now());
  const retry = await rpc(p.P1.token, 'race_submit_result', p1Submit);
  record('T-09 submit retried with the same requestId after > 60 s → same response',
    retry.envelope?.ok === true && JSON.stringify(retry.envelope) === JSON.stringify(first.envelope),
    `${errCode(retry)} after ${Math.round((Date.now() - firstReportMs) / 1000)} s, equal=${JSON.stringify(retry.envelope) === JSON.stringify(first.envelope)}`);
  return first.envelope?.ok ? { acct: p.P1, payload: p1Submit, envelope: first.envelope } : null;
}

// ── F2 economy and store (plan T-11, T-12) ──────────────────────────────────
const CONSOLE_BASE = `http://${HOST}:8090`;
const FUNDS = { coins: 40_000, gems: 100 };
const SAME_OFFER = 'perm_paint_matte_black';
const SAME_OFFER_AFTER_RESTART = 'perm_wheels_neon_rim';
const RACERS = 10;
const GATE = { clientVersion: '0.1.0', platform: 'android' };
/** store.json offers by id (the source of truth for SKUs and refIds). */
const STORE_OFFERS = new Map(JSON.parse(readFileSync(resolve(ROOT, 'modules', 'src', 'catalogs', 'store.json'), 'utf8'))
  .sections.flatMap((s) => s.offers.map((o) => [o.offerId, o])));

/** Console session (local admin console, credentials from .env, never printed). */
async function consoleToken(env) {
  if (!env.NAKAMA_CONSOLE_USER || !env.NAKAMA_CONSOLE_PASSWORD) return null;
  const res = await fetch(`${CONSOLE_BASE}/v2/console/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.NAKAMA_CONSOLE_USER, password: env.NAKAMA_CONSOLE_PASSWORD }),
  });
  return res.ok ? (await res.json()).token ?? null : null;
}

/** Set a smoke account's wallet through the console (test funds). */
async function fund(ct, uid, wallet = FUNDS) {
  const res = await fetch(`${CONSOLE_BASE}/v2/console/account/${uid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ct}` },
    body: JSON.stringify({ wallet: JSON.stringify(wallet) }),
  });
  if (!res.ok) throw new Error(`console wallet update HTTP ${res.status}`);
}

/** Wallet ledger rows of an account (console), changeset/metadata parsed. */
async function ledgerOf(ct, uid) {
  const res = await fetch(`${CONSOLE_BASE}/v2/console/account/${uid}/wallet?limit=100`, {
    headers: { Authorization: `Bearer ${ct}` },
  });
  if (!res.ok) throw new Error(`console ledger HTTP ${res.status}`);
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v || '{}') : v ?? {});
  return ((await res.json()).items ?? []).map((i) => ({ changeset: parse(i.changeset), metadata: parse(i.metadata) }));
}

async function walletOf(acct) {
  const r = await rpc(acct.token, 'wallet_get', GATE);
  return r.envelope?.ok ? { coins: r.envelope.data.coins, gems: r.envelope.data.gems } : null;
}

/** Ledger rows that charged `coins` (a store price) for one idempotency key prefix. */
const charges = (ledger, coins, keyPart) => ledger.filter((l) => l.changeset.coins === -coins
  && String(l.metadata.idempotencyKey ?? '').includes(keyPart));

async function storeOffers(acct) {
  const r = await rpc(acct.token, 'store_get', {});
  if (!r.envelope?.ok) return null;
  return r.envelope.data.sections.flatMap((s) => s.offers);
}

/** Ten concurrent store_buy of one offer: one charge, every answer ok or "already owned". */
async function sameOfferRace(ct, acct, offerId, label) {
  const before = await walletOf(acct);
  const answers = await Promise.all(Array.from({ length: RACERS }, () => rpc(acct.token, 'store_buy', { offerId })));
  const after = await walletOf(acct);
  const price = answers.find((a) => a.envelope?.ok)?.envelope.data.pricePaid?.coins ?? 0;
  const codes = answers.map(errCode);
  const okCount = codes.filter((c) => c === 'ok').length;
  const odd = codes.filter((c) => c !== 'ok' && c !== 'CONFLICT');
  const ledger = await ledgerOf(ct, acct.uid);
  const charged = charges(ledger, price, `store:buy:cosmetic:${acct.uid}`).length;
  record(`${label}: ${RACERS} concurrent store_buy of one offer → one charge`,
    price > 0 && okCount >= 1 && odd.length === 0 && before && after && before.coins - after.coins === price && charged === 1,
    `ok=${okCount} conflict=${codes.length - okCount - odd.length}${odd.length ? ` other=${odd.join(',')}` : ''} price=${price} charged=${before && after ? before.coins - after.coins : '?'} ledger=${charged}`);
  return { price, charged };
}

/**
 * Store and wallet checks of F2. Returns what the post-restart checks need.
 * Accounts are fresh per run and funded through the local console.
 */
async function economyScenario(serverKey, env) {
  const ct = await consoleToken(env);
  if (!ct) {
    record('F2 store and wallet checks', null, 'console login failed (NAKAMA_CONSOLE_USER/PASSWORD in .env)');
    return null;
  }
  const e = await freshAccounts(serverKey, 'econ', ['E1', 'E2', 'E3']);
  for (const a of Object.values(e)) {
    await rpc(a.token, 'garage_get', GATE);
    await fund(ct, a.uid);
  }

  // T-11: same key, ten concurrent calls.
  const race = await sameOfferRace(ct, e.E1, SAME_OFFER, 'T-11');

  // T-12: the price charged is the price shown, and `owned` is reported.
  const shown = await storeOffers(e.E3);
  const pick = (shown ?? []).filter((o) => o.offer.kind === 'cosmetic' && o.finalPrice.coins > 0)
    .sort((x, y) => x.finalPrice.coins - y.finalPrice.coins)[0];
  record('T-12 store_get: every offer has owned=false and {coins, gems} prices',
    Array.isArray(shown) && shown.length > 0 && shown.every((o) => o.owned === false
      && typeof o.finalPrice?.coins === 'number' && typeof o.finalPrice?.gems === 'number'),
    `${shown?.length ?? 0} offers`);
  if (pick) {
    const before = await walletOf(e.E3);
    const buy = await rpc(e.E3.token, 'store_buy', { offerId: pick.offer.offerId });
    const after = await walletOf(e.E3);
    const paid = buy.envelope?.data?.pricePaid;
    record('T-12 price charged = price shown (store_get finalPrice)',
      buy.envelope?.ok === true && before && after && before.coins - after.coins === pick.finalPrice.coins
        && before.gems - after.gems === pick.finalPrice.gems && paid?.coins === pick.finalPrice.coins
        && JSON.stringify(buy.envelope.data.newBalance) === JSON.stringify(after),
      `${pick.offer.offerId} shown=${JSON.stringify(pick.finalPrice)} paid=${JSON.stringify(paid)} delta=${before && after ? before.coins - after.coins : '?'} newBalance=${JSON.stringify(buy.envelope?.data?.newBalance)}`);
  } else {
    record('T-12 price charged = price shown (store_get finalPrice)', false, 'no coin-priced cosmetic listed');
  }

  // T-12: no special offer names an unknown SKU.
  const events = await rpc(e.E3.token, 'event_list', {});
  const offers = (events.envelope?.data?.events ?? []).filter((x) => x.kind === 'special_offer');
  const unknownSku = offers.filter((x) => !STORE_OFFERS.has(x.payload?.sku));
  record('T-12 no special_offer with a SKU unknown to store.json',
    events.envelope?.ok === true && unknownSku.length === 0,
    `${offers.length} special offer(s) listed${unknownSku.length ? `, unknown: ${unknownSku.map((x) => x.payload?.sku).join(',')}` : ''}`);

  // T-11 / HT-73: concurrent buys of different offers race on the garage;
  // a lost CAS charges nothing, and the rebuy charges.
  const wave = (await storeOffers(e.E2) ?? []).filter((o) => o.finalPrice.coins > 0 && o.finalPrice.gems === 0
    && (o.offer.kind === 'cosmetic' || o.offer.kind === 'pack'));
  const start = await walletOf(e.E2);
  const first = await Promise.all(wave.map((o) => rpc(e.E2.token, 'store_buy', { offerId: o.offer.offerId })));
  const afterWave = await walletOf(e.E2);
  const won = wave.filter((_, i) => first[i].envelope?.ok === true);
  const lost = wave.filter((_, i) => errCode(first[i]) === 'CONFLICT');
  const odd = first.map(errCode).filter((c) => c !== 'ok' && c !== 'CONFLICT');
  /** Net coins a successful buy takes: its price minus the coins a pack holds. */
  const netCoins = (o, r) => o.finalPrice.coins - (r.envelope?.data?.delivery?.changeset?.coins ?? 0);
  const wonNet = wave.reduce((sum, o, i) => sum + (first[i].envelope?.ok === true ? netCoins(o, first[i]) : 0), 0);
  const waveOk = start && afterWave && start.coins - afterWave.coins === wonNet;
  const rebuys = [];
  for (const o of lost) rebuys.push(await rpc(e.E2.token, 'store_buy', { offerId: o.offer.offerId }));
  const end = await walletOf(e.E2);
  const rebuyNet = lost.reduce((sum, o, i) => sum + netCoins(o, rebuys[i]), 0);
  const rebuyOk = rebuys.every((r) => r.envelope?.ok === true) && afterWave && end && afterWave.coins - end.coins === rebuyNet;
  if (lost.length === 0) {
    record('T-11 lost garage CAS → nothing charged; the rebuy charges (HT-73)', null,
      `no CAS lost in a wave of ${wave.length} (all committed${waveOk ? ', charges exact' : ', CHARGES WRONG'}); covered by tests/e2e/refund-safety.test.ts`);
    if (!waveOk) record('T-11 concurrent different offers charge exactly what was delivered', false, `start=${JSON.stringify(start)} after=${JSON.stringify(afterWave)}`);
  } else {
    record('T-11 lost garage CAS → nothing charged; the rebuy charges (HT-73)', waveOk && rebuyOk && odd.length === 0,
      `wave of ${wave.length}: ${won.length} ok, ${lost.length} CONFLICT (charged ${start && afterWave ? start.coins - afterWave.coins : '?'} = delivered ${wonNet}); rebuys ${rebuys.map(errCode).join(',')} charged ${afterWave && end ? afterWave.coins - end.coins : '?'} = ${rebuyNet}`);
  }

  return { ct, e, race };
}

/** Restart Nakama (same compose files) and wait for the API. */
async function restartNakama(bin) {
  docker(bin, [...COMPOSE_ARGS, 'restart', 'nakama']);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(2_000);
    try {
      const r = await fetch(`${BASE}/healthcheck`);
      if (r.ok) {
        await sleep(2_000);
        return true;
      }
    } catch {
      // not up yet
    }
  }
  return false;
}

/** After a restart nothing replays a charge or a payout (durable keys, PC-11). */
async function afterRestartChecks(econ, f1Retry) {
  const { ct, e, race } = econ;
  const before = await walletOf(e.E1);
  const again = await rpc(e.E1.token, 'store_buy', { offerId: SAME_OFFER });
  const after = await walletOf(e.E1);
  const garage = await rpc(e.E1.token, 'garage_get', GATE);
  const bag = garage.envelope?.data?.garage?.cosmeticsBag ?? [];
  const refId = STORE_OFFERS.get(SAME_OFFER)?.refId;
  const copies = bag.filter((c) => c === refId).length;
  const ledger = await ledgerOf(ct, e.E1.uid);
  const charged = charges(ledger, race.price, `store:buy:cosmetic:${e.E1.uid}`).length;
  record('T-11 after a restart: no second charge, no second delivery',
    errCode(again) === 'CONFLICT' && before && after && before.coins === after.coins
      && charged === 1 && copies === 1,
    `rebuy=${errCode(again)} delta=${before && after ? before.coins - after.coins : '?'} ledger charges=${charged} copies in the garage=${copies}`);
  await sameOfferRace(ct, e.E1, SAME_OFFER_AFTER_RESTART, 'T-11 after a restart');
  if (f1Retry) {
    const w0 = await walletOf(f1Retry.acct);
    const retry = await rpc(f1Retry.acct.token, 'race_submit_result', f1Retry.payload);
    const w1 = await walletOf(f1Retry.acct);
    record('T-11 after a restart: a retried race submit replays, the payout is not repeated',
      retry.envelope?.ok === true && JSON.stringify(retry.envelope) === JSON.stringify(f1Retry.envelope)
        && w0 && w1 && w0.coins === w1.coins && w0.gems === w1.gems,
      `${errCode(retry)} equal=${JSON.stringify(retry.envelope) === JSON.stringify(f1Retry.envelope)} wallet ${JSON.stringify(w0)} → ${JSON.stringify(w1)}`);
  }
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
  // Start the races now; the other checks run while their clocks do.
  const race = SKIP_RACE ? null : await startPrivateRace(fresh);
  let f1 = null;
  if (!SKIP_RACE) {
    const p = await freshAccounts(serverKey, 'f1', ['P1', 'P2', 'P3']);
    const h = await freshAccounts(serverKey, 'claim', ['H1', 'H2']);
    const m = await freshAccounts(serverKey, 'mm', ['M1', 'M2']);
    const three = await setupThreePlayerRace(p);
    if (three) await checkLoadoutAndActive(p, three);
    const claimRace = await hostClaimScenario(h);
    f1 = { p, h, m, three, claimRace };
  }

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
  const unknown500 = noEnvelope.filter((x) => !(x.split('(')[0] in KNOWN_RPC_500));
  record('every RPC answers with an envelope (except the KNOWN ones)', unknown500.length === 0, unknown500.slice(0, 8).join(', '));
  const known500 = noEnvelope.filter((x) => x.split('(')[0] in KNOWN_RPC_500);
  if (known500.length > 0) {
    known('RPCs answering HTTP 500 until a later card', known500.map((x) => `${x} → ${KNOWN_RPC_500[x.split('(')[0]]}`).join(', '));
  }
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

  // F2 (T-11, T-12) while the race clocks run.
  const econ = await economyScenario(serverKey, env);

  if (f1) await matchmakerScenario(f1.m);
  if (race) await finishPrivateRace(fresh, race);
  else record('1-player private race closes', null, '--skip-race');
  const f1Retry = f1?.three ? await finishF1Races(f1.p, f1.three, f1.h, f1.claimRace, bin) : null;

  if (bin) {
    const registered = checkLogs(bin);
    record('logs: RPC registrations since boot', registered === ids.length, `${registered}/${ids.length}`);
  }

  // Restart last: the log checks above cover the run before it.
  if (bin && econ && !SKIP_RESTART) {
    const up = await restartNakama(bin);
    record('Nakama restarted (same compose files) and answering', up, '');
    if (up) {
      await afterRestartChecks(econ, f1Retry);
      const { started, lines } = nakamaLogsSinceBoot(bin);
      recordErrors('logs: no error-level lines since the restart', classifyErrors(parseLogLines(lines)), started);
    }
  } else if (!SKIP_RESTART) {
    record('T-11 after a restart: no second charge, no second delivery', null, bin ? 'F2 checks did not run' : 'docker checks skipped');
  }
}

function printTable() {
  const w = Math.max(...rows.map((r) => r.check.length), 10);
  console.log('');
  for (const r of rows) {
    console.log(`${r.status.padEnd(5)}  ${r.check.padEnd(w)}  ${r.detail}`);
  }
  const fails = rows.filter((r) => r.status === 'FAIL').length;
  const knownCount = rows.filter((r) => r.status === 'KNOWN').length;
  console.log(`\n${rows.length - fails}/${rows.length} checks without FAIL${fails ? ` — ${fails} FAIL` : ''}`
    + `${knownCount ? ` (${knownCount} KNOWN: expected until a later plan card)` : ''}`);
  return fails;
}

main()
  .catch((e) => record('smoke run', false, e instanceof Error ? e.message : String(e)))
  .finally(() => {
    process.exitCode = printTable() > 0 ? 1 : 0;
  });
