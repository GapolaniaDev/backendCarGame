#!/usr/bin/env node
// Live smoke test against the local Docker stack (plan card T-05, D-07).
//
//   npm run smoke:live                      # 127.0.0.1:8081, full run
//   npm run smoke:live -- --skip-docker     # HTTP checks only
//   npm run smoke:live -- --skip-restart    # no Nakama restart at the end
//   npm run smoke:live -- --skip-dedicated  # no dedicated race server block (needs RACE_SERVER_SECRET in .env)
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
//   - F3 leaderboards, ranked and profile (plan T-13, T-14), with fresh
//     K1/K2/K3: three quick races and one ranked race make wins_week list
//     K1 (3) before K2 (1) with their usernames (lb_get paged with
//     nextCursor, and the native ListLeaderboardRecords the client uses),
//     the friends view lists K1 and their friend K2 only, and the ranked
//     table ranks the best rating first; another player's profile_get is
//     the public projection and an unknown one is NOT_FOUND without
//     creating anything; profile_get / garage_get / inbox_claim without
//     clientVersion pass the version gate and a lower clientVersion gets
//     UPGRADE_REQUIRED (config_get too, whose minClientVersion is the
//     LiveOps one);
//   - F4 accounts, inbox and LiveOps (plan T-15, T-16, T-17): the old
//     link secret is not in modules/index.js and a token signed with it is
//     rejected; a native custom link earns the bonus once; a link conflict
//     resolves with the owner's session (open) and the keeper's (resolve),
//     deleting that real account; account_delete of K3 (races, a purchase,
//     a friend) leaves 0 objects in every collection of core/collections.ts,
//     no system row keyed by it, no friend mirror edge and no leaderboard
//     record; before the restart, legacy liveops_inbox entries are seeded
//     through the console and the migration marker deleted, and after it a
//     season reward and a tournament notice are in inbox_list, two
//     concurrent claims of the season reward pay once;
//   - F5 storage and progression (plan T-18, T-19, T-20), with fresh
//     accounts and the LiveOps admin key (set for the run when missing,
//     then removed): admin_migrate_permissions runs to the end and leaves
//     no client-writable object; a native WriteStorageObjects on pass,
//     missions_daily, friends_edge, clubs_members, ranked and idem is
//     rejected (403) and on save / public accepted; two concurrent
//     pass_claim pay once; pass_buy_premium without gems changes nothing;
//     admin_pass_season_close of a drill season with 3 accounts pays the
//     3 through the inbox; two concurrent mission_claim pay once;
//     mission_reroll without gems keeps the mission; the 1-player race,
//     finished before the first missions_get / achievements_get, counts;
//   - F6 social, clubs, tournaments and events (plan T-21, T-22, T-23),
//     with fresh accounts (levels raised and wallets set through the
//     console): club_search answers and finds a new club by prefix;
//     club_join puts the joiner in club_members_list and a level-1 player
//     gets MIN_LEVEL; a native JoinGroup and AddGroupUsers answer 403 and
//     add nobody; chat_list shows the account username; a blocked word is
//     CONTENT_REJECTED; a blocked player cannot chat (BLOCKED) or add by
//     code (NOT_FOUND, no edges); 5 club messages page 2 by 2 with the
//     cursor; tournament_join without funds leaves no entry and with funds
//     charges once; a drill tournament that ended a minute before closes
//     once (one close log line, ticks after it) and its prize is a
//     claimable inbox reward; event_list is not empty and the liveops
//     calendar is the events.json one;
//   - F7 IAP and ads (plan T-24, T-25), with fresh accounts: on the .env
//     defaults (IAP_MOCK=false, no store credentials, empty LevelPlay
//     secret) a forged Apple receipt, a forged Google receipt in both
//     client formats (UnityPayload, PurchaseJson) and a mock receipt are
//     rejected and deliver nothing, the client's ad_watched pays nothing and
//     a LevelPlay callback is rejected. The restart is a recreate (same
//     compose files) with IAP_MOCK=true and a random LevelPlay key for that
//     boot only: a mock purchase delivers once, 5 concurrent retries answer
//     idempotent: true, 5 concurrent first submissions deliver once, another
//     account gets CONFLICT, a refunded receipt is rejected; a signed GET
//     callback (http_key, unwrap) pays once with <eventId>:OK, repeats pay
//     nothing, a bad signature pays nothing, a session gets FORBIDDEN. Then
//     Nakama is recreated on the .env values and the defaults are checked
//     again (the delivered purchase stays idempotent, the old key is gone);
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
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
const SKIP_DEDICATED = argv.includes('--skip-dedicated');
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
const KNOWN_RPC_500 = {};
/** http_key of the runtime (.env), for the admin RPCs; never printed. */
let ENV_HTTP_KEY = '';

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
  // T-19: reward items missing from the catalogs, logged once per boot
  // (a content decision of the user, KNOWN until it is made).
  const content = allErrors.filter((m) => CONTENT_LOG.test(String(m.msg)));
  const errors = allErrors.filter((m) => !rollbacks.includes(m) && !rpc500.includes(m) && !content.includes(m));
  return { allErrors, rollbacks, rpc500, content, errors };
}

function recordErrors(check, { errors }, since) {
  record(check, errors.length === 0,
    errors.length ? `${errors.length}: ${[...new Set(errors.map((m) => `${String(m.msg).slice(0, 80)} ${String(m.error ?? '').slice(0, 60)}`))].slice(0, 4).join(' | ')}` : `since ${since}`);
}

function checkLogs(bin) {
  const { started, lines } = nakamaLogsSinceBoot(bin);
  const msgs = parseLogLines(lines);
  const classified = classifyErrors(msgs);
  const { allErrors, rollbacks, rpc500, content } = classified;
  if (content.length > 0) {
    const ids = String(content[0].msg).split(': ').slice(2).join(': ').split(', ');
    known('logs: catalog content check (T-19) — reward items missing from cars.json / cosmetics.json',
      `${ids.length} id(s), content decision: ${ids.slice(0, 3).join(', ')}…`);
  }
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

// ── F3 leaderboards, ranked and profile (plan T-13, T-14) ───────────────────
// Fresh K1/K2/K3 run three 2-player quick races (K1 wins two, K2 one) and
// one ranked race (K1 > K2 > K3), all started together. The quick races
// (3 laps on neon_blvd) finish after the private race; the ranked one
// (5 laps, >= 240 s for class D) after the F1 races. Every human reports,
// so each race closes on its last report (quorum).
const NEON_LAPS = JSON.parse(readFileSync(resolve(ROOT, 'modules', 'src', 'catalogs', 'tracks.json'), 'utf8'))
  .tracks.find((t) => t.id === 'neon_blvd').modes;
const F3_LAP_MS = { first: 48_100, second: 48_500, third: 49_000 };
const f3Report = (uid, place, laps) => {
  const lapTimes = Array.from({ length: laps }, () => F3_LAP_MS[place]);
  return { userId: uid, totalMs: lapTimes.reduce((x, y) => x + y, 0), laps: lapTimes, isBotReport: false };
};

async function startF3Race(label, mode, size, host, guests) {
  const created = await rpc(host.token, 'race_session_create', {
    matchId: `smoke-f3-${label}-${Date.now()}`, mode, trackId: 'neon_blvd', size,
    hostLoadout: { classId: 'D', bodyId: 'starter_viper' },
  });
  const sid = created.envelope?.data?.sessionId;
  if (!sid) return { label, error: `create: ${errCode(created)}` };
  for (const g of guests) {
    const j = await rpc(g.token, 'race_session_join', { sessionId: sid, loadout: { classId: 'D', bodyId: 'starter_viper' } });
    if (j.envelope?.ok !== true) return { label, error: `join: ${errCode(j)}` };
  }
  const started = await rpc(host.token, 'race_session_start', { sessionId: sid });
  if (started.envelope?.ok !== true) return { label, error: `start: ${errCode(started)}` };
  return { label, mode, sid, startedAtMs: Date.now() };
}

async function startF3Races(k) {
  const races = [
    { ...(await startF3Race('quick-1', 'quick', 2, k.K1, [k.K3])), order: [k.K1, k.K3] },
    { ...(await startF3Race('quick-2', 'quick', 2, k.K2, [k.K1])), order: [k.K1, k.K2] },
    { ...(await startF3Race('quick-3', 'quick', 2, k.K3, [k.K2])), order: [k.K2, k.K3] },
    { ...(await startF3Race('ranked', 'ranked', 4, k.K1, [k.K2, k.K3])), order: [k.K1, k.K2, k.K3] },
  ];
  const failed = races.filter((r) => r.error);
  record('F3 quick and ranked races set up (K1/K2/K3)', failed.length === 0,
    failed.map((r) => `${r.label} ${r.error}`).join(', ') || races.map((r) => `${r.label}=${r.sid.slice(0, 8)}…`).join(' '));
  return failed.length === 0 ? { k, races } : null;
}

async function finishF3Races(f3, mode) {
  const races = f3.races.filter((r) => r.mode === mode);
  const laps = NEON_LAPS[mode];
  await waitRaceClock(Math.max(...races.map((r) => r.startedAtMs)), laps * F3_LAP_MS.third);
  const states = [];
  const rejected = [];
  for (const race of races) {
    const places = ['first', 'second', 'third'];
    for (let i = 0; i < race.order.length; i += 1) {
      const sub = await rpc(race.order[i].token, 'race_submit_result', { sessionId: race.sid, report: f3Report(race.order[i].uid, places[i], laps) });
      if (sub.envelope?.ok !== true) {
        rejected.push(`${race.label}#${i + 1} ${errCode(sub)} ${JSON.stringify(sub.envelope?.error?.details ?? sub.envelope?.error?.message ?? '').slice(0, 120)}`);
      }
    }
    const got = await rpc(race.order[0].token, 'race_session_get', { sessionId: race.sid });
    states.push(`${race.label}=${got.envelope?.data?.session?.state ?? errCode(got)}`);
  }
  record(`F3 ${mode} races closed on the last report (${laps} laps)`, states.every((s) => s.endsWith('=closed')),
    `${states.join(' ')}${rejected.length ? ` rejected: ${rejected.join('; ')}` : ''}`);
  // The writers run on the bus after the closing submit.
  await sleep(1_000);
}

async function usernameOf(acct) {
  const r = await http('GET', '/v2/account', { headers: { Authorization: `Bearer ${acct.token}` } });
  return r.json?.user?.username ?? null;
}

/** Walk lb_get pages of `limit` until every id in `want` was seen (max 50 pages). */
async function pageLeaderboard(acct, leaderboardId, limit, want) {
  const rows = [];
  const missing = new Set(want);
  let cursor = null;
  let pages = 0;
  let error = null;
  do {
    const r = await rpc(acct.token, 'lb_get', { leaderboardId, view: 'global', limit, ...(cursor ? { cursor } : {}) });
    if (r.envelope?.ok !== true) {
      error = errCode(r);
      break;
    }
    rows.push(...r.envelope.data.records);
    for (const rec of r.envelope.data.records) missing.delete(rec.ownerId);
    cursor = r.envelope.data.nextCursor;
    pages += 1;
  } while (cursor && missing.size > 0 && pages < 50);
  return { rows, pages, error, missing: [...missing] };
}

const nonIncreasing = (rows) => rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score);
const consecutiveRanks = (rows) => rows.every((r, i) => r.rank === i + 1);

async function leaderboardChecks(f3) {
  const { K1, K2, K3 } = f3.k;
  const names = { K1: await usernameOf(K1), K2: await usernameOf(K2) };

  // wins_week: descending, paged with a cursor, with names (T-13, HT-65).
  const wins = await pageLeaderboard(K1, 'wins_week', 1, [K1.uid, K2.uid]);
  const byId = new Map(wins.rows.map((r) => [r.ownerId, r]));
  const k1 = byId.get(K1.uid);
  const k2 = byId.get(K2.uid);
  record('T-13 wins_week from most to fewest wins (K1 3 > K2 1)',
    !wins.error && nonIncreasing(wins.rows) && consecutiveRanks(wins.rows) && k1?.score === 3 && k2?.score === 1 && k1.rank < k2.rank,
    wins.error ?? `K1 rank ${k1?.rank} score ${k1?.score}, K2 rank ${k2?.rank} score ${k2?.score}, scores ${wins.rows.map((r) => r.score).join(',')}`);
  record('T-13 lb_get pages wins_week with nextCursor (limit 1)',
    !wins.error && wins.pages >= 2 && wins.missing.length === 0, `${wins.pages} pages, ${wins.rows.length} rows, missing ${wins.missing.length}`);
  record('T-13 wins_week records carry the account usernames',
    Boolean(names.K1) && k1?.username === names.K1 && k2?.username === names.K2,
    `K1 ${k1?.username === names.K1 ? 'ok' : `${k1?.username} ≠ ${names.K1}`}, K2 ${k2?.username === names.K2 ? 'ok' : `${k2?.username} ≠ ${names.K2}`}`);
  // The native API the Unity client uses (LeaderboardAsync on wins_week).
  const native = await http('GET', `/v2/leaderboard/wins_week?limit=100&owner_ids=${K1.uid}`, { headers: { Authorization: `Bearer ${K1.token}` } });
  const nativeOwner = (native.json?.owner_records ?? [])[0];
  const nativeScores = (native.json?.records ?? []).map((r) => Number(r.score));
  record('T-13 native ListLeaderboardRecords: wins_week descending with usernames',
    native.status === 200 && nativeScores.every((s, i) => i === 0 || nativeScores[i - 1] >= s) && nativeOwner?.username === names.K1,
    `HTTP ${native.status} scores ${nativeScores.slice(0, 6).join(',')} K1 username ${nativeOwner?.username === names.K1 ? 'ok' : nativeOwner?.username}`);

  // Friends view: K1 and K2 become friends; K3 is not listed.
  const code = await rpc(K2.token, 'friend_code_get', {});
  const add = await rpc(K1.token, 'friend_add_by_code', { code: code.envelope?.data?.code });
  const friends = await rpc(K1.token, 'lb_get', { leaderboardId: 'wins_week', view: 'friends' });
  const fIds = (friends.envelope?.data?.records ?? []).map((r) => r.ownerId);
  record('T-13 friends view lists the caller and their friends only',
    add.envelope?.ok === true && fIds.length === 2 && fIds[0] === K1.uid && fIds[1] === K2.uid && !fIds.includes(K3.uid),
    `add=${errCode(add)} view=${errCode(friends)} ids=${fIds.map((x) => x.slice(0, 8)).join(',')}`);

  // Ranked: the season table is descending, rank 1 = best rating.
  const r1 = await rpc(K1.token, 'ranked_get', {});
  const r2 = await rpc(K1.token, 'ranked_get', { userId: K2.uid });
  const r3 = await rpc(K1.token, 'ranked_get', { userId: K3.uid });
  const rk = [r1, r2, r3].map((r) => r.envelope?.data);
  record('T-13 ranked_get: K1 > K2 > K3 in rating and rank (desc table)',
    rk.every(Boolean) && rk[0].rating > rk[1].rating && rk[1].rating > rk[2].rating && rk[0].rank < rk[1].rank && rk[1].rank < rk[2].rank,
    rk.map((d, i) => `K${i + 1} ${d ? `${d.rating}/#${d.rank}` : errCode([r1, r2, r3][i])}`).join(' '));
  const seasonId = rk[0]?.seasonId;
  const top = seasonId ? await rpc(K1.token, 'lb_get', { leaderboardId: `ranked_${seasonId}`, view: 'global', limit: 100 }) : null;
  const topRows = top?.envelope?.data?.records ?? [];
  record('T-13 ranked table: rank 1 is the best rating',
    topRows.length >= 3 && topRows[0].rank === 1 && topRows[0].score === Math.max(...topRows.map((r) => r.score)) && nonIncreasing(topRows),
    top ? `${errCode(top)} rank1=${topRows[0]?.score} max=${Math.max(...topRows.map((r) => r.score))} rows=${topRows.length}` : 'no seasonId');
}

async function profileAndVersionChecks(f3, a) {
  const { K1, K2 } = f3.k;
  // T-14: another player's profile is the public projection.
  const other = await rpc(K1.token, 'profile_get', { userId: K2.uid });
  const keys = Object.keys(other.envelope?.data?.profile ?? {}).sort().join(',');
  const progression = JSON.stringify(other.envelope?.data?.profile?.progression ?? null);
  record('T-14 profile_get of another player: public fields only',
    keys === 'avatarUrl,displayName,progression,userId' && /^\{"level":\d+\}$/.test(progression), `${errCode(other)} keys=${keys} progression=${progression}`);
  const ghost = crypto.randomUUID();
  const g1 = await rpc(K1.token, 'profile_get', { userId: ghost });
  const g2 = await rpc(K1.token, 'profile_get', { userId: ghost });
  record('T-14 profile_get of an unknown player → NOT_FOUND, nothing created',
    errCode(g1) === 'NOT_FOUND' && errCode(g2) === 'NOT_FOUND', `${errCode(g1)} then ${errCode(g2)}`);

  // T-14 / D-05: without clientVersion every gate passes (the Unity client sends none).
  const noVersion = [];
  for (const [id, body] of [['profile_get', {}], ['garage_get', {}], ['inbox_claim', { messageId: 'smoke-no-such-message' }]]) {
    const r = await rpc(a.token, id, body);
    noVersion.push(`${id}=${errCode(r)}`);
  }
  record('T-14 profile_get / garage_get / inbox_claim without clientVersion pass the gate',
    noVersion[0] === 'profile_get=ok' && noVersion[1] === 'garage_get=ok' && noVersion[2] === 'inbox_claim=NOT_FOUND',
    `${noVersion.join(' ')} (inbox_claim of a missing message: past the gate)`);
  const old = { clientVersion: '0.0.1', platform: 'android' };
  const oldResults = [];
  for (const [id, body] of [['profile_get', old], ['garage_get', old], ['inbox_claim', { ...old, messageId: 'x' }], ['config_get', old]]) {
    const r = await rpc(a.token, id, body);
    oldResults.push(`${id}=${errCode(r)}`);
  }
  record('T-14 clientVersion below the minimum → UPGRADE_REQUIRED (incl. config_get)',
    oldResults.every((x) => x.endsWith('=UPGRADE_REQUIRED')), oldResults.join(' '));
  const cfg = await rpc(a.token, 'config_get', { platform: 'android' });
  const live = await rpc(a.token, 'liveops_config_get', {});
  const wantMin = live.envelope?.data?.minClientVersion?.android;
  record('T-14 config_get.minClientVersion comes from the LiveOps config',
    cfg.envelope?.ok === true && typeof wantMin === 'string' && cfg.envelope.data.minClientVersion === wantMin,
    `config_get=${cfg.envelope?.data?.minClientVersion} liveops.android=${wantMin}`);
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

// ── F4: accounts, inbox and LiveOps (plan T-15, T-16, T-17) ─────────────────
/** The secret the removed `account/token.ts` signed link tokens with (audit 06 f11). */
const LEGACY_LINK_SECRET = ['p5v4', 'account', 'link', 'test', 'secret', 'do', 'not', 'ship'].join('-');
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
/** Collection names of the central registry (core/collections.ts). */
const REGISTRY = [...readFileSync(resolve(ROOT, 'modules', 'src', 'core', 'collections.ts'), 'utf8')
  .matchAll(/(?:name: |userOwned\()'([a-z_]+)'/g)].map((m) => m[1]);

async function consoleGet(ct, path) {
  const res = await fetch(`${CONSOLE_BASE}${path}`, { headers: { Authorization: `Bearer ${ct}` } });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function consoleSend(ct, method, path, body) {
  const res = await fetch(`${CONSOLE_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ct}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

const objectPath = (collection, key, uid) => `/v2/console/storage/${collection}/${encodeURIComponent(key)}/${uid}`;

/** Custom-id authentication; `create: false` is how a client proves it owns an identity. */
async function authCustom(serverKey, id, create) {
  const basic = Buffer.from(`${serverKey}:`).toString('base64');
  const r = await http('POST', `/v2/account/authenticate/custom?create=${create}`, {
    body: { id },
    headers: { Authorization: `Basic ${basic}` },
  });
  return r.status === 200 && r.json?.token ? { token: r.json.token, uid: jwtClaims(r.json.token).uid } : { status: r.status };
}

async function linkCustomNative(acct, id) {
  return (await http('POST', '/v2/account/link/custom', { body: { id }, headers: { Authorization: `Bearer ${acct.token}` } })).status;
}

function legacyLinkToken(provider, customId) {
  const payload = Buffer.from(JSON.stringify({ provider, customId, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  return `v1.${provider}.${payload}.${createHmac('sha256', LEGACY_LINK_SECRET).update(payload).digest('base64url')}`;
}

/** T-15: no token or secret; native links, the bonus once, conflicts with both sessions. */
async function linkingScenario(serverKey, ct) {
  const bundle = readFileSync(resolve(ROOT, 'modules', 'index.js'), 'utf8');
  record('T-15 the old link secret is not in modules/index.js', !bundle.includes(LEGACY_LINK_SECRET) && !bundle.includes('account-link-test-secret'),
    bundle.includes(LEGACY_LINK_SECRET) ? 'FOUND' : 'absent');

  const l = await freshAccounts(serverKey, 'link', ['L1', 'L3']);
  const forged = await rpc(l.L1.token, 'account_link', { provider: 'custom', token: legacyLinkToken('custom', `smoke-forged-${Date.now()}`) });
  const w0 = await walletOf(l.L1);
  record('T-15 a token signed with the old secret is rejected (nothing linked or paid)',
    errCode(forged) === 'BAD_REQUEST' && forged.envelope?.error?.details?.reason === 'NATIVE_LINK_REQUIRED' && w0?.coins === 0,
    `${errCode(forged)} ${forged.envelope?.error?.details?.reason ?? ''} coins=${w0?.coins}`);

  const linked = await linkCustomNative(l.L1, `smoke-${Date.now()}-L1-custom`);
  const first = await rpc(l.L1.token, 'account_link', {});
  const second = await rpc(l.L1.token, 'account_link', { provider: 'custom' });
  const w1 = await walletOf(l.L1);
  record('T-15 native link → account_link pays the 500-coin bonus once',
    linked === 200 && first.envelope?.data?.bonusClaimed === true && second.envelope?.data?.bonusClaimed === false && w1?.coins === 500,
    `link HTTP ${linked}; first ${errCode(first)} bonus=${first.envelope?.data?.bonusClaimed} providers=${JSON.stringify(first.envelope?.data?.providers)}; second bonus=${second.envelope?.data?.bonusClaimed}; coins=${w1?.coins}`);

  // Conflict: L2 owns the identity; L3 wants it.
  const shared = `smoke-${Date.now()}-shared-custom`;
  const l2 = await authCustom(serverKey, shared, true);
  const refused = await linkCustomNative(l.L3, shared);
  const proven = await authCustom(serverKey, shared, false);
  const opened = await rpc(proven.token, 'account_link_resolve_conflict', { step: 'open' });
  const token = opened.envelope?.data?.conflictToken;
  const resolved = await rpc(l.L3.token, 'account_link_resolve_conflict', { step: 'resolve', conflictToken: token, choice: 'link', confirmText: 'TRANSFER' });
  const gone = ct ? (await consoleGet(ct, `/v2/console/account/${l2.uid}`)).status : null;
  const relinked = await linkCustomNative(l.L3, shared);
  const owner = await authCustom(serverKey, shared, false);
  record('T-15 conflict: open with the owner’s session, resolve deletes that real account, the identity re-links natively',
    refused === 409 && proven.uid === l2.uid && opened.envelope?.data?.target?.userId === l2.uid
      && resolved.envelope?.data?.resolved === 'linked' && (gone === null || gone === 404) && relinked === 200 && owner.uid === l.L3.uid,
    `native link HTTP ${refused}; open ${errCode(opened)} target=${opened.envelope?.data?.target?.userId === l2.uid ? 'owner' : '?'}; resolve ${errCode(resolved)}; old account ${gone ?? 'n/a'}; re-link HTTP ${relinked}; identity → ${owner.uid === l.L3.uid ? 'L3' : owner.uid ?? owner.status}`);
}

/** Every leaderboard id (console listing) with a record of `uid`, read with another player's session. */
async function boardsWith(ct, reader, uid) {
  const listed = await consoleGet(ct, '/v2/console/leaderboard');
  const ids = (listed.body?.leaderboards ?? []).map((x) => x.id);
  const found = [];
  for (const id of ids) {
    const r = await http('GET', `/v2/leaderboard/${encodeURIComponent(id)}?owner_ids=${uid}&limit=1`, { headers: { Authorization: `Bearer ${reader.token}` } });
    if ((r.json?.owner_records ?? []).length > 0 || (r.json?.records ?? []).some((x) => x.owner_id === uid)) found.push(id);
  }
  return { ids, found };
}

/** T-16: account_delete of an account with races, a purchase and a friend leaves nothing behind. */
async function deleteScenario(ct, target, friend) {
  if (!ct) {
    record('T-16 account_delete leaves 0 objects in every registry collection', null, 'console login failed');
    return;
  }
  await rpc(target.token, 'garage_get', GATE);
  await fund(ct, target.uid);
  const offer = (await storeOffers(target) ?? []).filter((o) => o.offer.kind === 'cosmetic' && o.finalPrice.coins > 0 && o.finalPrice.gems === 0)
    .sort((x, y) => x.finalPrice.coins - y.finalPrice.coins)[0];
  const bought = offer ? await rpc(target.token, 'store_buy', { offerId: offer.offer.offerId }) : null;
  const code = (await rpc(target.token, 'friend_code_get', {})).envelope?.data?.code;
  const added = code ? await rpc(friend.token, 'friend_add_by_code', { code }) : null;
  const mirror = objectPath('friends_edge', target.uid, friend.uid);
  const before = await consoleGet(ct, `/v2/console/storage?user_id=${target.uid}`);
  const boardsBefore = await boardsWith(ct, friend, target.uid);
  const mirrorBefore = (await consoleGet(ct, mirror)).status;
  record('T-16 the account to delete has races, a purchase and a friend',
    bought?.envelope?.ok === true && added?.envelope?.ok === true && mirrorBefore === 200 && boardsBefore.found.length > 0,
    `boards=${boardsBefore.found.join(',') || 'none'} buy=${bought ? errCode(bought) : 'no offer'} friend=${added ? errCode(added) : 'no code'} objects=${(before.body?.objects ?? []).length}`);

  const del = await rpc(target.token, 'account_delete', { confirmText: 'DELETE' });
  const s = del.envelope?.data?.summary;
  record('T-16 account_delete ok', del.envelope?.ok === true,
    s ? `storage=${s.storageDeleted} refs=${s.referencesRemoved} boards=${s.boardsDeleted} collections=${(s.collectionsAffected ?? []).length}` : errCode(del));

  const leftovers = [];
  for (const collection of REGISTRY) {
    const r = await consoleGet(ct, `/v2/console/storage?collection=${collection}&user_id=${target.uid}`);
    const n = (r.body?.objects ?? []).filter((o) => o.user_id === target.uid).length;
    if (r.status !== 200 || n > 0) leftovers.push(`${collection}=${r.status === 200 ? n : `HTTP ${r.status}`}`);
  }
  const all = await consoleGet(ct, `/v2/console/storage?user_id=${target.uid}`);
  const keyed = [];
  for (const [collection, key] of [['race_active', target.uid], ['anti_cheat_marks', target.uid], ['race_sessions', `last_closed/${target.uid}`]]) {
    if ((await consoleGet(ct, objectPath(collection, key, SYSTEM_USER))).status !== 404) keyed.push(`${collection}/${key}`);
  }
  const mirrorAfter = (await consoleGet(ct, mirror)).status;
  record(`T-16 storageList of each of the ${REGISTRY.length} registry collections → 0 objects of the user`,
    REGISTRY.length >= 60 && leftovers.length === 0 && (all.body?.objects ?? []).length === 0 && keyed.length === 0 && mirrorAfter === 404,
    `${leftovers.join(', ') || 'all 0'}; any collection=${(all.body?.objects ?? []).length}; system rows keyed by the user=${keyed.join(',') || 'none'}; friend's mirror edge HTTP ${mirrorAfter}`);
  const boardsAfter = await boardsWith(ct, friend, target.uid);
  const account = (await consoleGet(ct, `/v2/console/account/${target.uid}`)).status;
  const session = await rpc(target.token, 'wallet_get', GATE);
  record('T-16 the user is in no leaderboard and the account is gone',
    boardsAfter.found.length === 0 && account === 404 && session.status === 401,
    `boards with a record: ${boardsAfter.found.join(',') || 'none'} (of ${boardsAfter.ids.length}); console account HTTP ${account}; old session HTTP ${session.status}`);
}

const LEGACY_SEASON_ID = 'season_2-rank-4';

/** T-17: seed liveops_inbox as the pre-T-17 server wrote it and re-arm the boot migration. */
async function seedLegacyInbox(ct, serverKey) {
  const { I1: acct } = await freshAccounts(serverKey, 'inbox', ['I1']);
  await rpc(acct.token, 'garage_get', GATE);
  const nowMs = Date.now();
  const tournamentId = `tournament:smoke-${nowMs}:prize:${acct.uid}:1`;
  const entries = [
    // The amount is forged on purpose: the migration takes it from the tier of rank 4.
    { rewardId: LEGACY_SEASON_ID, type: 'season_bronze', payload: { coins: 999_999, cosmetics: [], note: 'Season 1 — Bronze tier (rank 4-10)' } },
    { rewardId: tournamentId, type: 'tournament_prize', payload: { coins: 400, note: 'Tournament prize: rank 1' } },
  ];
  const writes = [];
  for (const e of entries) {
    writes.push(await consoleSend(ct, 'PUT', objectPath('liveops_inbox', `${acct.uid}/${e.rewardId}`, acct.uid), {
      value: JSON.stringify({ schemaVersion: 1, userId: acct.uid, createdAt: nowMs, expiresAt: null, claimed: false, ...e }),
      permission_read: 1,
      permission_write: 1,
    }));
  }
  const marker = await consoleSend(ct, 'DELETE', objectPath('migrations', 'inbox_v1', SYSTEM_USER));
  const ok = writes.every((w) => w === 200) && marker === 200;
  record('T-17 legacy liveops_inbox entries seeded and the migration re-armed', ok, `writes ${writes.join(',')} marker DELETE ${marker}`);
  return ok ? { acct, tournamentId } : null;
}

/** After the restart: the legacy rewards are in inbox_list, the season one pays once under concurrency. */
async function inboxChecks(ct, seeded) {
  const { acct, tournamentId } = seeded;
  const legacyLeft = (await consoleGet(ct, `/v2/console/storage?collection=liveops_inbox&user_id=${acct.uid}`)).body?.objects ?? [];
  const marker = (await consoleGet(ct, objectPath('migrations', 'inbox_v1', SYSTEM_USER))).status;
  const list = await rpc(acct.token, 'inbox_list', {});
  const msgs = list.envelope?.data?.messages ?? [];
  const season = msgs.find((m) => m.id === LEGACY_SEASON_ID);
  const notice = msgs.find((m) => m.id === tournamentId);
  record('T-17 boot migration: season reward and tournament notice appear in inbox_list',
    legacyLeft.length === 0 && marker === 200 && season?.kind === 'reward' && season?.reward?.coins === 1000
      && notice?.kind === 'system' && notice?.granted?.coins === 400 && notice?.reward === undefined,
    `legacy left=${legacyLeft.length} marker HTTP ${marker}; season ${season ? `${season.kind} coins=${season.reward?.coins}` : 'missing'}; tournament ${notice ? `${notice.kind} granted=${notice.granted?.coins}` : 'missing'}`);

  const w0 = await walletOf(acct);
  const claims = await Promise.all([1, 2].map(() => rpc(acct.token, 'inbox_claim', { messageId: LEGACY_SEASON_ID })));
  const third = await rpc(acct.token, 'inbox_claim', { messageId: LEGACY_SEASON_ID });
  const w1 = await walletOf(acct);
  const ledger = await ledgerOf(ct, acct.uid);
  const paid = ledger.filter((l) => l.metadata.idempotencyKey === `inbox:${LEGACY_SEASON_ID}`);
  const codes = claims.map(errCode).sort();
  record('T-17 two concurrent inbox_claim of the season reward → one payment',
    codes.join(',') === 'CONFLICT,ok' && errCode(third) === 'CONFLICT' && w0 && w1 && w1.coins - w0.coins === 1000
      && paid.length === 1 && paid[0].changeset.coins === 1000,
    `claims ${codes.join(',')} then ${errCode(third)}; wallet +${w0 && w1 ? w1.coins - w0.coins : '?'}; ledger rows ${paid.length}`);

  const ack = await rpc(acct.token, 'inbox_claim', { messageId: tournamentId });
  const w2 = await walletOf(acct);
  record('T-17 a tournament notice is acknowledged without paying again',
    ack.envelope?.ok === true && ack.envelope.data.newBalance === undefined && w1 && w2 && w2.coins === w1.coins,
    `${errCode(ack)} wallet ${w1?.coins} → ${w2?.coins}`);
}

// ── F5 storage and progression (plan T-18, T-19, T-20) ─────────────────────
/** Collections a modified client must not write (T-18 smoke list). */
const PROTECTED = ['pass', 'missions_daily', 'friends_edge', 'clubs_members', 'ranked', 'idem'];
/** The boot line of the catalog content check (T-19): KNOWN until the content decision. */
const CONTENT_LOG = /^catalog content: /;

/** Run `fn(adminKey)` with the LiveOps admin key; a missing key is set for the call and removed after. */
async function withAdminKey(ct, fn) {
  const path = objectPath('liveops', 'config', SYSTEM_USER);
  const got = await consoleGet(ct, path);
  if (got.status !== 200 || typeof got.body?.value !== 'string') return fn(null);
  const original = JSON.parse(got.body.value);
  if (typeof original.adminRpcKey === 'string' && original.adminRpcKey.length > 0) return fn(original.adminRpcKey);
  const temp = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const put = (value) => consoleSend(ct, 'PUT', path, { value: JSON.stringify(value), permission_read: 0, permission_write: 0 });
  if (await put({ ...original, adminRpcKey: temp }) !== 200) return fn(null);
  try {
    return await fn(temp);
  } finally {
    await put(original);
  }
}

/** Native client storage write (PUT /v2/storage), as a modified client would send it. */
async function nativeWrite(acct, collection, key, value, read = 1, write = 1) {
  const r = await http('PUT', '/v2/storage', {
    body: { objects: [{ collection, key, value: JSON.stringify(value), permission_read: read, permission_write: write }] },
    headers: { Authorization: `Bearer ${acct.token}` },
  });
  return r.status;
}

async function nativeDelete(acct, collection, key) {
  const r = await http('PUT', '/v2/storage/delete', {
    body: { object_ids: [{ collection, key }] },
    headers: { Authorization: `Bearer ${acct.token}` },
  });
  return r.status;
}

/** T-18: migrate the old objects, then a client cannot write server collections; the cloud save still works. */
async function storagePermissionChecks(ct, adminKey, acct) {
  if (adminKey) {
    let next;
    let total = 0;
    let scanned = 0;
    let done = false;
    const by = {};
    for (let i = 0; i < 50 && !done; i++) {
      const r = await rpc(null, 'admin_migrate_permissions', { adminKey, maxObjects: 5000, ...(next ?? {}) }, { httpKey: ENV_HTTP_KEY });
      if (!r.envelope?.ok) break;
      total += r.envelope.data.rewritten;
      scanned += r.envelope.data.scanned;
      for (const [k, v] of Object.entries(r.envelope.data.byCollection)) by[k] = (by[k] ?? 0) + v;
      done = r.envelope.data.done;
      next = r.envelope.data.next;
    }
    record('T-18 admin_migrate_permissions ran to the end', done, `scanned=${scanned} rewritten=${total} ${JSON.stringify(by)}`);
    const writable = [];
    for (const c of [...PROTECTED, 'achievements', 'season_close', 'parties', 'invites', 'blocks', 'clubs_metadata']) {
      const list = await consoleGet(ct, `/v2/console/storage?collection=${c}&limit=100`);
      for (const o of list.body?.objects ?? []) if (Number(o.permission_write ?? 0) !== 0) writable.push(`${c}/${o.key}`);
    }
    const analytics = await consoleGet(ct, '/v2/console/storage?collection=analytics_events&limit=100');
    const readable = (analytics.body?.objects ?? []).filter((o) => Number(o.permission_read ?? 0) !== 0).length;
    record('T-18 after the migration: no client-writable object, analytics not client-readable (first console page per collection)',
      writable.length === 0 && readable === 0, `writable=${writable.slice(0, 3).join(',') || 0} analyticsReadable=${readable}`);
  } else {
    record('T-18 admin_migrate_permissions ran to the end', false, 'no admin key (console or liveops config unavailable)');
  }

  // The account owns a pass, missions and an idem key (a purchase) by now.
  await rpc(acct.token, 'pass_get', {});
  await rpc(acct.token, 'missions_get', {});
  const blocked = [];
  for (const c of PROTECTED) {
    const key = c === 'pass' || c === 'ranked' || c === 'friends_edge' ? acct.uid : `${acct.uid}/smoke`;
    const status = await nativeWrite(acct, c, key, { premiumPurchased: true, rating: 9999, role: 'leader', state: 'applied' });
    blocked.push(`${c}=${status}`);
  }
  record('T-18 native WriteStorageObjects on pass, missions_daily, friends_edge, clubs_members, ranked, idem → rejected',
    blocked.every((b) => b.endsWith('=403')), blocked.join(' '));
  const del = await nativeDelete(acct, 'pass', acct.uid);
  const pass = await rpc(acct.token, 'pass_get', {});
  record('T-18 native DeleteStorageObjects of the own pass → rejected (permission 0)', del >= 400 && pass.envelope?.ok === true,
    `delete HTTP ${del}; pass_get ${errCode(pass)}`);

  const key = `smoke-${Date.now()}`;
  const save = await nativeWrite(acct, 'save', key, { v: 1, b64: 'c21va2U=' }, 1, 1);
  const pub = await nativeWrite(acct, 'public', key, { value: { name: 'smoke' } }, 2, 1);
  const cleanup = [await nativeDelete(acct, 'save', key), await nativeDelete(acct, 'public', key)];
  record('T-18 cloud save: native writes to save and public → accepted (and deletable by the owner)',
    save === 200 && pub === 200 && cleanup.every((s) => s === 200), `save=${save} public=${pub} delete=${cleanup.join(',')}`);
}

/** T-19: concurrent claims, a failed premium payment, and a season close that pays three accounts. */
async function passChecks(ct, adminKey, serverKey) {
  const { P1, P2 } = await freshAccounts(serverKey, 'pass', ['P1', 'P2']);
  await rpc(P1.token, 'pass_get', {});
  const w0 = await walletOf(P1);
  const claims = await Promise.all([1, 2].map(() => rpc(P1.token, 'pass_claim', { level: 1, track: 'free' })));
  const w1 = await walletOf(P1);
  const paid = (await ledgerOf(ct, P1.uid)).filter((l) => String(l.metadata.idempotencyKey ?? '').startsWith(`pass:${P1.uid}:`));
  const codes = claims.map(errCode).sort();
  record('T-19 two concurrent pass_claim of one level → one reward',
    codes.join(',') === 'CONFLICT,ok' && w0 && w1 && w1.coins - w0.coins === 200 && paid.length === 1,
    `claims ${codes.join(',')}; wallet +${w0 && w1 ? w1.coins - w0.coins : '?'}; ledger rows ${paid.length}`);

  await fund(ct, P2.uid, { coins: 0, gems: 10 });
  const buy = await rpc(P2.token, 'pass_buy_premium', {});
  const after = await rpc(P2.token, 'pass_get', {});
  const w2 = await walletOf(P2);
  const rows = (await ledgerOf(ct, P2.uid)).length;
  record('T-19 pass_buy_premium without enough gems → INSUFFICIENT_FUNDS, nothing changes',
    errCode(buy) === 'INSUFFICIENT_FUNDS' && after.envelope?.data?.premiumPurchased === false && w2?.gems === 10 && rows === 0,
    `${errCode(buy)}; premium=${after.envelope?.data?.premiumPurchased}; gems=${w2?.gems}; ledger rows ${rows}`);

  if (!adminKey) {
    record('T-19 season close with 3 accounts pays the 3', false, 'no admin key');
    return;
  }
  // Three records of a drill season (the real one ends in 2027): levels 1-3 reached
  // (free: 200 + 200 + 250 coins); C2 already claimed level 1.
  const season = `smoke_${Date.now()}`;
  const s = await freshAccounts(serverKey, 'close', ['C1', 'C2', 'C3']);
  const expected = { C1: 650, C2: 450, C3: 650 };
  for (const [name, acct] of Object.entries(s)) {
    await rpc(acct.token, 'pass_get', {});
    const value = {
      schemaVersion: 1, userId: acct.uid, seasonId: season, xp: 400,
      claimedFree: name === 'C2' ? [1] : [], claimedPremium: [], premiumPurchased: false, seasonClosed: false,
    };
    await consoleSend(ct, 'PUT', objectPath('pass', acct.uid, acct.uid), { value: JSON.stringify(value), permission_read: 1, permission_write: 0 });
  }
  const run = await rpc(null, 'admin_pass_season_close', { adminKey, seasonId: season }, { httpKey: ENV_HTTP_KEY });
  const details = [];
  let allPaid = run.envelope?.data?.state === 'settled';
  for (const [name, acct] of Object.entries(s)) {
    const list = await rpc(acct.token, 'inbox_list', {});
    const msg = (list.envelope?.data?.messages ?? []).find((m) => m.id === `pass_end:${season}`);
    const before = await walletOf(acct);
    const claim = await rpc(acct.token, 'inbox_claim', { messageId: `pass_end:${season}` });
    const now = await walletOf(acct);
    const gain = before && now ? now.coins - before.coins : null;
    if (msg?.reward?.coins !== expected[name] || errCode(claim) !== 'ok' || gain !== expected[name]) allPaid = false;
    details.push(`${name} msg=${msg?.reward?.coins ?? 'none'} +${gain}`);
  }
  const again = await rpc(null, 'admin_pass_season_close', { adminKey, seasonId: season }, { httpKey: ENV_HTTP_KEY });
  record('T-19 season close with 3 accounts pays the 3 (unclaimed reached levels to the inbox)',
    allPaid && again.envelope?.data?.state === 'settled',
    `${errCode(run)} state=${run.envelope?.data?.state} settled=${run.envelope?.data?.settled}; ${details.join('; ')}`);
}

/** Today's daily row of an account through the console, or null. */
async function dailyRow(ct, uid) {
  const date = new Date().toISOString().slice(0, 10);
  const got = await consoleGet(ct, objectPath('missions_daily', `${uid}/${date}`, uid));
  return got.status === 200 && typeof got.body?.value === 'string' ? { value: JSON.parse(got.body.value), date } : null;
}

/** T-20: concurrent mission claims, and a reroll without gems. */
async function missionChecks(ct, serverKey) {
  const { M1, M2 } = await freshAccounts(serverKey, 'missions', ['M1', 'M2']);
  await rpc(M1.token, 'missions_get', {});
  const row = await dailyRow(ct, M1.uid);
  if (row === null) {
    record('T-20 two concurrent mission_claim → one reward', false, 'no daily row');
  } else {
    // Complete the first mission (as a race would) through the console.
    const first = row.value.missions[0];
    const target = 1000;
    row.value.missions[0] = { ...first, progress: target, completed: true };
    await consoleSend(ct, 'PUT', objectPath('missions_daily', `${M1.uid}/${row.date}`, M1.uid),
      { value: JSON.stringify(row.value), permission_read: 1, permission_write: 0 });
    const w0 = await walletOf(M1);
    const claims = await Promise.all([1, 2].map(() => rpc(M1.token, 'mission_claim', { missionId: first.missionId, kind: 'daily' })));
    const w1 = await walletOf(M1);
    const key = `mission:daily:${row.date}:${first.missionId}:${M1.uid}`;
    const paid = (await ledgerOf(ct, M1.uid)).filter((l) => l.metadata.idempotencyKey === key);
    const reward = claims.find((c) => c.envelope?.ok)?.envelope.data.reward?.coins ?? 0;
    const codes = claims.map(errCode).sort();
    record('T-20 two concurrent mission_claim → one reward (key with the date)',
      codes.join(',') === 'CONFLICT,ok' && w0 && w1 && w1.coins - w0.coins === reward && paid.length === (reward > 0 ? 1 : 0),
      `claims ${codes.join(',')}; wallet +${w0 && w1 ? w1.coins - w0.coins : '?'} (reward ${reward}); ledger rows ${paid.length}`);
  }

  await fund(ct, M2.uid, { coins: 0, gems: 0 });
  const before = await rpc(M2.token, 'missions_get', {});
  const ids = (before.envelope?.data?.daily?.missions ?? []).map((m) => m.missionId);
  const rr = await rpc(M2.token, 'mission_reroll', { missionId: ids[0], useGems: true });
  const after = await rpc(M2.token, 'missions_get', {});
  const ids2 = (after.envelope?.data?.daily?.missions ?? []).map((m) => m.missionId);
  record('T-20 mission_reroll without gems → INSUFFICIENT_FUNDS, the mission does not change',
    errCode(rr) === 'INSUFFICIENT_FUNDS' && ids.length > 0 && ids.join(',') === ids2.join(','),
    `${errCode(rr)}; missions ${ids.join(',')} → ${ids2.join(',')}`);
}

/** T-20: a race finished before the first missions_get / achievements_get counts. */
async function earlyProgressCheck(ct, acct) {
  const achv = await consoleGet(ct, objectPath('achievements', acct.uid, acct.uid));
  const stored = achv.status === 200 ? JSON.parse(achv.body.value) : null;
  const daily = await dailyRow(ct, acct.uid);
  const got = await rpc(acct.token, 'achievements_get', {});
  const card = (got.envelope?.data?.achievements ?? []).find((a) => a.achievementId === 'ach_10_races');
  const missions = await rpc(acct.token, 'missions_get', {});
  const dailyProgress = (missions.envelope?.data?.daily?.missions ?? []).reduce((n, m) => n + m.progress, 0);
  record('T-20 a race before the first missions_get / achievements_get counts',
    stored?.progress?.ach_10_races === 1 && card?.progress === 1 && Number(achv.body?.permission_write ?? 1) === 0,
    `achievements row before *_get: ${stored ? `ach_10_races=${stored.progress?.ach_10_races}` : 'missing'}; achievements_get ${card?.progress}; daily row before *_get ${daily ? 'yes' : 'no'} (progress now ${dailyProgress})`);
}

// ── F6: social, clubs, tournaments and events (plan T-21, T-22, T-23) ──────
const CLUB_LEVEL = 8;

/** Raise a smoke account's profile level through the console (club rules need 8). */
async function setLevel(ct, acct, level) {
  await rpc(acct.token, 'profile_get', GATE); // the after-auth hook created it; make sure
  const path = objectPath('profiles', acct.uid, acct.uid);
  const got = await consoleGet(ct, path);
  if (got.status !== 200 || typeof got.body?.value !== 'string') return false;
  const value = JSON.parse(got.body.value);
  value.progression = { ...(value.progression ?? { xp: 0, lastDailyWinAt: 0 }), level };
  const put = await consoleSend(ct, 'PUT', path, { value: JSON.stringify(value), permission_read: 0, permission_write: 0 });
  return put === 200;
}

async function rosterOf(acct, clubId) {
  const r = await rpc(acct.token, 'club_members_list', { clubId, limit: 50 });
  return r.envelope?.ok ? r.envelope.data.members : null;
}

/** T-21: club_search, club_join visible in the roster, native group writes refused. */
async function clubChecks(ct, serverKey) {
  const g = await freshAccounts(serverKey, 'club', ['G1', 'G2', 'G3', 'G4']);
  const leveled = [];
  for (const n of ['G1', 'G2', 'G3']) leveled.push(await setLevel(ct, g[n], CLUB_LEVEL));
  await fund(ct, g.G1.uid, { coins: 10_000, gems: 0 });
  const name = `Smoke ${Date.now() % 1_000_000}`;
  const created = await rpc(g.G1.token, 'club_create', { name, motto: 'Fast cars', emblemId: 'emblem_default', region: 'us' });
  const clubId = created.envelope?.data?.clubId;
  record('T-21 club_create (level 8, 5000 coins) ok', created.envelope?.ok === true && leveled.every(Boolean),
    `${errCode(created)} paid=${created.envelope?.data?.costPaid} left=${created.envelope?.data?.newBalance?.coins}`);
  if (!clubId) return null;

  const search = await rpc(g.G2.token, 'club_search', { name: 'Smoke', limit: 50 });
  const found = (search.envelope?.data?.clubs ?? []).find((c) => c.clubId === clubId);
  record('T-21 club_search answers (was HTTP 500) and finds the club by prefix', search.envelope?.ok === true && found !== undefined,
    `${errCode(search)} clubs=${search.envelope?.data?.clubs?.length ?? '-'} open=${found?.open}`);

  const joined = await rpc(g.G2.token, 'club_join', { clubId });
  const roster = (await rosterOf(g.G1, clubId)) ?? [];
  const g2 = roster.find((m) => m.userId === g.G2.uid);
  record('T-21 club_join → the joiner is in club_members_list', joined.envelope?.ok === true && g2?.role === 'member' && typeof g2?.username === 'string' && g2.username.length > 0,
    `${errCode(joined)} roster=${roster.map((m) => m.role).join(',')}`);

  const lowLevel = await rpc(g.G4.token, 'club_join', { clubId });
  record('T-21 club_join below level 8 → FORBIDDEN MIN_LEVEL', errCode(lowLevel) === 'FORBIDDEN' && lowLevel.envelope?.error?.details?.reason === 'MIN_LEVEL',
    `${errCode(lowLevel)} ${lowLevel.envelope?.error?.details?.reason ?? ''}`);

  const nativeJoin = await http('POST', `/v2/group/${clubId}/join`, { headers: { Authorization: `Bearer ${g.G3.token}` } });
  const nativeAdd = await http('POST', `/v2/group/${clubId}/add?user_ids=${g.G3.uid}`, { headers: { Authorization: `Bearer ${g.G1.token}` } });
  const after = (await rosterOf(g.G1, clubId)) ?? [];
  const groupUsers = await http('GET', `/v2/group/${clubId}/user?limit=100`, { headers: { Authorization: `Bearer ${g.G1.token}` } });
  const g3Edge = (groupUsers.json?.group_users ?? []).some((u) => u.user?.id === g.G3.uid);
  record('T-21 native JoinGroup / AddGroupUsers do not skip the rules (403, not a member)',
    nativeJoin.status === 403 && nativeAdd.status === 403 && !after.some((m) => m.userId === g.G3.uid) && !g3Edge,
    `join HTTP ${nativeJoin.status}, add HTTP ${nativeAdd.status}, edge=${g3Edge}`);
  return { g, clubId };
}

const sendChat = (acct, channelType, targetId, content) =>
  rpc(acct.token, 'chat_send', { channelType, targetId, language: 'es', content });

/** T-22: blocks in chat and add-by-code, CONTENT_REJECTED, usernames, a paged history. */
async function socialChecks(ct, serverKey, club) {
  const s = await freshAccounts(serverKey, 'social', ['S1', 'S2', 'S3', 'S4']);
  const code2 = (await rpc(s.S2.token, 'friend_code_get', {})).envelope?.data?.code;
  const added = await rpc(s.S1.token, 'friend_add_by_code', { code: code2 });
  const hello = await sendChat(s.S1, 'direct', s.S2.uid, 'hola, que tal');
  const list = await rpc(s.S2.token, 'chat_list', { channelType: 'direct', targetId: s.S1.uid });
  const name1 = await usernameOf(s.S1);
  const sender = list.envelope?.data?.messages?.[0]?.senderName;
  record('T-22 chat messages carry the account username (3.27 .user.username)',
    added.envelope?.ok === true && hello.envelope?.ok === true && sender === name1 && sender !== 'unknown',
    `add=${errCode(added)} send=${errCode(hello)} senderName ${sender === name1 ? '= account username' : `${sender} vs ${name1}`}`);

  await sleep(1_100);
  const word = await sendChat(s.S1, 'direct', s.S2.uid, 'eres un idiota');
  record('T-22 blocked word → CONTENT_REJECTED', errCode(word) === 'CONTENT_REJECTED', errCode(word));

  const block = await rpc(s.S2.token, 'block_add', { targetUserId: s.S1.uid });
  await sleep(1_100);
  const blocked = await sendChat(s.S1, 'direct', s.S2.uid, 'sigues ahi?');
  record('T-22 a blocked player cannot chat (FORBIDDEN BLOCKED)',
    block.envelope?.ok === true && errCode(blocked) === 'FORBIDDEN' && blocked.envelope?.error?.details?.reason === 'BLOCKED',
    `block=${errCode(block)} send=${errCode(blocked)} ${blocked.envelope?.error?.details?.reason ?? ''}`);

  const block4 = await rpc(s.S4.token, 'block_add', { targetUserId: s.S3.uid });
  const code4 = (await rpc(s.S4.token, 'friend_code_get', {})).envelope?.data?.code;
  const byCode = await rpc(s.S3.token, 'friend_add_by_code', { code: code4 });
  const edgeA = await consoleGet(ct, objectPath('friends_edge', s.S4.uid, s.S3.uid));
  const edgeB = await consoleGet(ct, objectPath('friends_edge', s.S3.uid, s.S4.uid));
  record('T-22 a blocked player cannot add by code (NOT_FOUND, no edges)',
    block4.envelope?.ok === true && errCode(byCode) === 'NOT_FOUND' && edgeA.status === 404 && edgeB.status === 404,
    `add=${errCode(byCode)} edges HTTP ${edgeA.status}/${edgeB.status}`);

  if (!club) {
    record('T-22 chat history pages with the cursor', null, 'no club');
    return;
  }
  const { g, clubId } = club;
  const texts = [];
  for (let i = 0; i < 5; i++) {
    const who = i % 2 === 0 ? g.G1 : g.G2;
    const text = `mensaje ${i + 1}`;
    const r = await sendChat(who, 'club', clubId, text);
    if (r.envelope?.ok) texts.push(text);
    await sleep(600);
  }
  const seen = [];
  let cursor = '';
  let pages = 0;
  for (; pages < 10; pages++) {
    const page = await rpc(g.G1.token, 'chat_list', { channelType: 'club', targetId: clubId, limit: 2, ...(cursor ? { cursor } : {}) });
    if (!page.envelope?.ok) break;
    seen.push(...page.envelope.data.messages.map((m) => m.content));
    cursor = page.envelope.data.nextCursor;
    if (!cursor) break;
  }
  const expected = [...texts].reverse();
  const bad = await rpc(g.G1.token, 'chat_list', { channelType: 'club', targetId: clubId, cursor: 'x' });
  record('T-22 chat history pages with the cursor (newest first, every message once)',
    texts.length === 5 && JSON.stringify(seen) === JSON.stringify(expected) && errCode(bad) === 'BAD_REQUEST',
    `sent=${texts.length} pages=${pages + 1} seen=${seen.length} badCursor=${errCode(bad)}`);
}

/** T-23 seeding (at the start): an open paid tournament and one that ended a minute ago with a winner. */
async function seedTournaments(ct, serverKey) {
  const t = await freshAccounts(serverKey, 'tour', ['T1', 'T2', 'W1']);
  const now = Date.now();
  const base = { schemaVersion: 1, kind: 'time_trial', trackId: 'neon_blvd', maxAttempts: 3, minLevel: 1, createdAt: now - 7_200_000 };
  const payId = `smoke_pay_${now}`;
  const closeId = `smoke_close_${now}`;
  const writes = [
    await consoleSend(ct, 'PUT', objectPath('tournament_instances', payId, SYSTEM_USER), {
      value: JSON.stringify({ ...base, id: payId, templateId: payId, startsAt: now - 3_600_000, endsAt: now + 86_400_000, entryFee: 500, prizes: [] }),
      permission_read: 1, permission_write: 0,
    }),
    await consoleSend(ct, 'PUT', objectPath('tournament_instances', closeId, SYSTEM_USER), {
      value: JSON.stringify({ ...base, id: closeId, templateId: closeId, startsAt: now - 7_200_000, endsAt: now - 60_000, entryFee: 0, prizes: [{ rankFrom: 1, rankTo: 1, rewards: { coins: 300 } }] }),
      permission_read: 1, permission_write: 0,
    }),
    await consoleSend(ct, 'PUT', objectPath('tournament_leaderboard', closeId, SYSTEM_USER), {
      value: JSON.stringify({ schemaVersion: 1, tournamentId: closeId, updatedAt: now, entries: [{ userId: t.W1.uid, bestTimeMs: 150_000, recordedAt: now }] }),
      permission_read: 1, permission_write: 0,
    }),
  ];
  const ok = writes.every((w) => w === 200);
  record('T-23 drill tournaments seeded (an open paid one, one that ended with a winner)', ok, `writes ${writes.join(',')}`);
  return ok ? { t, payId, closeId, seededAt: now } : null;
}

/** T-23: a join without funds leaves no entry; one with funds charges once. */
async function tournamentJoinChecks(ct, seeded) {
  const { t, payId } = seeded;
  await fund(ct, t.T1.uid, { coins: 100, gems: 0 });
  const poor = await rpc(t.T1.token, 'tournament_join', { tournamentId: payId });
  const entry = await consoleGet(ct, objectPath('tournament_entries', payId, t.T1.uid));
  const poorWallet = await walletOf(t.T1);
  record('T-23 tournament_join without funds → INSUFFICIENT_FUNDS and no entry',
    errCode(poor) === 'INSUFFICIENT_FUNDS' && entry.status === 404 && poorWallet?.coins === 100,
    `${errCode(poor)} entry HTTP ${entry.status} coins=${poorWallet?.coins}`);

  await fund(ct, t.T2.uid, { coins: 1_000, gems: 0 });
  const paid = await rpc(t.T2.token, 'tournament_join', { tournamentId: payId });
  const again = await rpc(t.T2.token, 'tournament_join', { tournamentId: payId });
  const entry2 = await consoleGet(ct, objectPath('tournament_entries', payId, t.T2.uid));
  const wallet2 = await walletOf(t.T2);
  record('T-23 tournament_join with funds: entry written, charged once',
    paid.envelope?.ok === true && errCode(again) === 'CONFLICT' && entry2.status === 200 && wallet2?.coins === 500,
    `${errCode(paid)} / again ${errCode(again)} entry HTTP ${entry2.status} coins=${wallet2?.coins}`);
  const got = await rpc(t.T2.token, 'tournament_get', { tournamentId: payId });
  record('T-23 tournament_get answers topTimes and myRank', got.envelope?.ok === true && Array.isArray(got.envelope.data.topTimes) && 'myRank' in got.envelope.data,
    `${errCode(got)} topTimes=${got.envelope?.data?.topTimes?.length}`);
}

/** T-23: the ended tournament closed once (closedAt stable across ticks) and its prize is a claimable inbox reward. */
async function tournamentCloseChecks(ct, seeded, bin) {
  const { t, closeId } = seeded;
  const inst = await consoleGet(ct, objectPath('tournament_instances', closeId, SYSTEM_USER));
  const v = inst.status === 200 ? JSON.parse(inst.body.value) : null;
  let closes = null;
  let ticksAfter = null;
  if (bin) {
    const { lines } = nakamaLogsSinceBoot(bin);
    const msgs = parseLogLines(lines);
    const closeLines = msgs.filter((m) => String(m.msg).startsWith(`tournament closed tid=${closeId} `));
    closes = closeLines.length;
    const firstClose = closeLines[0]?.ts;
    ticksAfter = firstClose ? msgs.filter((m) => TICK_LOG.test(String(m.msg)) && m.ts > firstClose).length : 0;
  }
  const closedAtInLog = closes === 1 && v !== null;
  record('T-23 an ended tournament closes once (closedAt stable between ticks)',
    v?.state === 'closed' && typeof v?.closedAt === 'number' && v?.rewardsDistributed === true && (bin ? closes === 1 && ticksAfter >= 1 : true),
    `state=${v?.state} rewardsDistributed=${v?.rewardsDistributed} close lines=${closes ?? '-'} ticks after=${ticksAfter ?? '-'}${closedAtInLog ? '' : ''}`);

  const inbox = await rpc(t.W1.token, 'inbox_list', {});
  const msg = (inbox.envelope?.data?.messages ?? []).find((m) => m.id === `tournament:${closeId}:prize:${t.W1.uid}:1`);
  const before = await walletOf(t.W1);
  const claim = msg ? await rpc(t.W1.token, 'inbox_claim', { messageId: msg.id, ...GATE }) : null;
  const afterW = await walletOf(t.W1);
  record('T-23 the prize is a claimable reward in the single inbox (paid by inbox_claim)',
    msg?.kind === 'reward' && msg?.reward?.coins === 300 && claim?.envelope?.ok === true && afterW?.coins === (before?.coins ?? 0) + 300,
    `kind=${msg?.kind} coins=${msg?.reward?.coins} claim=${claim ? errCode(claim) : '-'} wallet ${before?.coins}→${afterW?.coins}`);
}

/** T-23: one event source — event_list and the liveops calendar. */
async function eventChecks(acct) {
  const ev = await rpc(acct.token, 'event_list', {});
  const events = ev.envelope?.data?.events ?? [];
  record('T-23 event_list is not empty', ev.envelope?.ok === true && events.length > 0, `${errCode(ev)} events=${events.length} active=${events.filter((e) => e.isActive).length}`);
  const cfg = await rpc(acct.token, 'liveops_config_get', {});
  const cal = (cfg.envelope?.data?.calendar ?? []).filter((c) => c.type === 'event').map((c) => c.id).sort();
  const notEnded = events.filter((e) => Date.parse(e.endsAtUtc) >= Date.now()).map((e) => e.id).sort();
  record('T-23 the liveops calendar is the events.json calendar (one source)',
    cfg.envelope?.ok === true && cal.length > 0 && JSON.stringify(cal) === JSON.stringify(notEnded),
    `calendar events=${cal.length} not-ended events=${notEnded.length}`);
}

// ── F7 IAP and ads (T-24, T-25) ─────────────────────────────────────────────
const F7_APPLE_PRODUCT = 'com.cvg.coins100';
const F7_GOOGLE_PRODUCT = 'coins_100';
/** A base64 blob shaped like an App Store receipt: forged, so it must never pass. */
const FORGED_APPLE_PAYLOAD = Buffer.from(`forged app store receipt ${'x'.repeat(48)}`).toString('base64');

const appleUnified = (tx, payload = FORGED_APPLE_PAYLOAD) => JSON.stringify({ Store: 'AppleAppStore', TransactionID: tx, Payload: payload });
const googlePurchaseJson = (tx) => JSON.stringify({
  orderId: `GPA.${tx}`, packageName: 'com.cvg.game', productId: F7_GOOGLE_PRODUCT,
  purchaseTime: Date.now(), purchaseState: 0, purchaseToken: tx,
});
const googleUnityPayload = (tx) => JSON.stringify({
  Store: 'GooglePlay', TransactionID: tx, Payload: JSON.stringify({ json: googlePurchaseJson(tx), signature: 'forged' }),
});
/** The mock verifier's receipt (only accepted with IAP_MOCK=true), wrapped like Unity does. */
const mockUnified = (tx, productId = F7_APPLE_PRODUCT, extra = {}) => appleUnified(tx, JSON.stringify({
  productId, transactionId: tx, originalTransactionId: tx, purchaseDateUtc: Date.now(), ...extra,
}));

async function buyIap(acct, platform, productId, transactionId, receiptData) {
  return rpc(acct.token, 'iap_purchase', { platform, productId, transactionId, receiptData });
}

/** LevelPlay's S2S callback as LevelPlay sends it: a GET with query parameters, http_key, unwrapped body. */
async function levelPlayCallback(userId, eventId, rewards, privateKey) {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const signature = createHash('md5').update(`${timestamp}${eventId}${userId}${rewards}${privateKey}`).digest('hex');
  const qs = new URLSearchParams({
    http_key: ENV_HTTP_KEY, unwrap: '', userId, eventId, rewards: String(rewards), timestamp, signature,
    placementName: 'DefaultRewardedVideo',
  });
  const res = await fetch(`${BASE}/v2/rpc/ads_levelplay_callback?${qs}`);
  const text = await res.text();
  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    envelope = null;
  }
  return { status: res.status, text, envelope, acked: text.includes(`${eventId}:OK`) };
}

/** IAP_MOCK=false (the .env default) and no store credentials: forged receipts and ads by the client pay nothing. */
async function f7DefaultChecks(serverKey, label) {
  const { F } = await freshAccounts(serverKey, `f7${label.replace(/\W/g, '')}`, ['F']);
  const before = await walletOf(F);
  const run = Date.now();
  const cases = [
    ['Apple forged receipt (unified)', 'apple', F7_APPLE_PRODUCT, `f7-apple-${run}`, appleUnified(`f7-apple-${run}`)],
    ['Google forged receipt (UnityPayload)', 'google', F7_GOOGLE_PRODUCT, `f7-gup-${run}`, googleUnityPayload(`f7-gup-${run}`)],
    ['Google forged receipt (PurchaseJson)', 'google', F7_GOOGLE_PRODUCT, `f7-gpj-${run}`, googlePurchaseJson(`f7-gpj-${run}`)],
    ['mock receipt with IAP_MOCK off', 'apple', F7_APPLE_PRODUCT, `f7-mock-${run}`, mockUnified(`f7-mock-${run}`)],
  ];
  for (const [name, platform, productId, tx, receipt] of cases) {
    const r = await buyIap(F, platform, productId, tx, receipt);
    record(`T-24 [${label}] ${name} → rejected`, r.envelope?.ok === false,
      `${errCode(r)} reason=${r.envelope?.error?.details?.reason ?? '-'}`);
  }
  const afterIap = await walletOf(F);
  record(`T-24 [${label}] rejected receipts deliver nothing`, afterIap?.coins === before?.coins, `coins ${before?.coins} → ${afterIap?.coins}`);
  const ad = await rpc(F.token, 'ad_watched', {
    tier: 'xlarge', provider: 'levelplay', adUnitId: 'smoke', impressionId: `f7-imp-${run}`, watchedAtUtc: Date.now(),
  });
  const afterAd = await walletOf(F);
  record(`T-25 [${label}] client ad_watched pays nothing`,
    ad.envelope?.ok === true && ad.envelope.data.coinsGranted === 0 && ad.envelope.data.granted === false && afterAd?.coins === afterIap?.coins,
    `${errCode(ad)} coinsGranted=${ad.envelope?.data?.coinsGranted} coins ${afterIap?.coins} → ${afterAd?.coins}`);
  if (!ENV_HTTP_KEY) {
    record(`T-25 [${label}] callback with an empty secret is rejected`, null, 'NAKAMA_RUNTIME_HTTP_KEY not in .env');
    return F;
  }
  // This server's secret is empty: no signature (not even one made with an empty key) is accepted.
  const cb = await levelPlayCallback(F.uid, `f7nokey${run}`, 60, '');
  const afterCb = await walletOf(F);
  record(`T-25 [${label}] LevelPlay callback with an empty secret → rejected, nothing paid`,
    cb.envelope?.ok === false && !cb.acked && afterCb?.coins === afterAd?.coins,
    `HTTP ${cb.status} ${cb.envelope?.error?.code ?? '-'} reason=${cb.envelope?.error?.details?.reason ?? '-'} acked=${cb.acked}`);
  return F;
}

/** With IAP_MOCK=true and a local test signing key (set only for this boot). */
async function f7MockChecks(serverKey, testKey) {
  const { M, N } = await freshAccounts(serverKey, 'f7mock', ['M', 'N']);
  const run = Date.now();
  const tx = `f7-buy-${run}`;
  const w0 = await walletOf(M);
  const first = await buyIap(M, 'apple', F7_APPLE_PRODUCT, tx, mockUnified(tx));
  const w1 = await walletOf(M);
  const credited = (w1?.coins ?? 0) - (w0?.coins ?? 0);
  record('T-24 [IAP_MOCK=true] a mock purchase is delivered (idempotent: false)',
    first.envelope?.ok === true && first.envelope.data.idempotent === false && credited > 0,
    `${errCode(first)} +${credited} coins`);
  const retries = await Promise.all([0, 1, 2, 3, 4].map(() => buyIap(M, 'apple', F7_APPLE_PRODUCT, tx, mockUnified(tx))));
  const w2 = await walletOf(M);
  record('T-24 [IAP_MOCK=true] 5 concurrent retries → idempotent: true, no second delivery',
    retries.every((r) => r.envelope?.ok === true && r.envelope.data.idempotent === true) && w2?.coins === w1?.coins,
    `${retries.map((r) => (r.envelope?.ok ? `idem=${r.envelope.data.idempotent}` : errCode(r))).join(' ')}; coins ${w1?.coins} → ${w2?.coins}`);
  const race = `f7-race-${run}`;
  const wr0 = await walletOf(M);
  const racing = await Promise.all([0, 1, 2, 3, 4].map(() => buyIap(M, 'apple', F7_APPLE_PRODUCT, race, mockUnified(race))));
  const wr1 = await walletOf(M);
  const fresh = racing.filter((r) => r.envelope?.ok === true && r.envelope.data.idempotent === false).length;
  const base = credited - (first.envelope?.data?.content?.firstTimeBonus ?? 0);
  record('T-24 [IAP_MOCK=true] 5 concurrent first submissions of one transaction deliver once',
    fresh === 1 && (wr1?.coins ?? 0) - (wr0?.coins ?? 0) === base,
    `${fresh} delivered, others ${[...new Set(racing.filter((r) => !(r.envelope?.ok && !r.envelope.data.idempotent)).map((r) => (r.envelope?.ok ? 'idempotent' : errCode(r))))].join(',') || '-'}; +${(wr1?.coins ?? 0) - (wr0?.coins ?? 0)} coins (pack ${base})`);
  const stolen = await buyIap(N, 'apple', F7_APPLE_PRODUCT, tx, mockUnified(tx));
  record('T-24 [IAP_MOCK=true] the same transaction on another account → CONFLICT',
    errCode(stolen) === 'CONFLICT', `${errCode(stolen)} reason=${stolen.envelope?.error?.details?.reason ?? '-'}`);
  const refundTx = `f7-refund-${run}`;
  const refunded = await buyIap(M, 'apple', F7_APPLE_PRODUCT, refundTx, mockUnified(refundTx, F7_APPLE_PRODUCT, { RefundTime: Date.now() }));
  record('T-24 [IAP_MOCK=true] a refunded purchase (RefundTime) → rejected',
    refunded.envelope?.ok === false && refunded.envelope.error?.details?.reason === 'REFUNDED',
    `${errCode(refunded)} reason=${refunded.envelope?.error?.details?.reason ?? '-'}`);

  let adEvent = null;
  if (ENV_HTTP_KEY) {
    const a0 = await walletOf(M);
    adEvent = `f7evt${run}`;
    const ok1 = await levelPlayCallback(M.uid, adEvent, 15, testKey);
    const a1 = await walletOf(M);
    record('T-25 [test key] a signed LevelPlay callback pays once and answers <eventId>:OK',
      ok1.status === 200 && ok1.acked && ok1.envelope?.data?.status === 'granted' && (a1?.coins ?? 0) - (a0?.coins ?? 0) === 15,
      `HTTP ${ok1.status} status=${ok1.envelope?.data?.status ?? errCode({ envelope: ok1.envelope, status: ok1.status })} +${(a1?.coins ?? 0) - (a0?.coins ?? 0)} coins`);
    const again = await Promise.all([0, 1, 2].map(() => levelPlayCallback(M.uid, adEvent, 15, testKey)));
    const a2 = await walletOf(M);
    record('T-25 [test key] the repeated callback answers OK again and pays nothing',
      again.every((r) => r.acked && r.envelope?.data?.idempotent === true) && a2?.coins === a1?.coins,
      `${again.map((r) => `acked=${r.acked}`).join(' ')}; coins ${a1?.coins} → ${a2?.coins}`);
    const bad = await levelPlayCallback(M.uid, `f7bad${run}`, 60, `${testKey}-wrong`);
    const a3 = await walletOf(M);
    record('T-25 [test key] a callback with an invalid signature pays nothing',
      bad.envelope?.ok === false && !bad.acked && a3?.coins === a2?.coins,
      `HTTP ${bad.status} ${bad.envelope?.error?.code ?? '-'} reason=${bad.envelope?.error?.details?.reason ?? '-'}`);
    const viaSession = await rpc(M.token, 'ads_levelplay_callback', {});
    record('T-25 a player session cannot call the callback → FORBIDDEN', errCode(viaSession) === 'FORBIDDEN', errCode(viaSession));
    const status = await rpc(M.token, 'ad_reward_status', {});
    const listed = (status.envelope?.data?.rewards ?? []).filter((r) => r.eventId === adEvent);
    record('T-25 ad_reward_status lists the paid event once', status.envelope?.ok === true && listed.length === 1 && listed[0].coins === 15,
      `${errCode(status)} listed=${listed.length} dailyCount=${status.envelope?.data?.dailyCount}`);
  } else {
    record('T-25 signed LevelPlay callback', null, 'NAKAMA_RUNTIME_HTTP_KEY not in .env');
  }
  return { M, tx, coins: (await walletOf(M))?.coins, adEvent };
}

/** Back on the .env defaults: what the mock boot delivered stays delivered once, the test key is gone. */
async function f7AfterDefaultsChecks(mock, testKey) {
  const retry = await buyIap(mock.M, 'apple', F7_APPLE_PRODUCT, mock.tx, mockUnified(mock.tx));
  const w = await walletOf(mock.M);
  record('T-24 [IAP_MOCK=false again] the retry of the delivered purchase → idempotent: true, nothing more',
    retry.envelope?.ok === true && retry.envelope.data.idempotent === true && w?.coins === mock.coins,
    `${errCode(retry)} idem=${retry.envelope?.data?.idempotent}; coins ${mock.coins} → ${w?.coins}`);
  if (mock.adEvent && ENV_HTTP_KEY) {
    const old = await levelPlayCallback(mock.M.uid, `${mock.adEvent}b`, 15, testKey);
    const w2 = await walletOf(mock.M);
    record('T-25 [empty secret again] a callback signed with the old test key → rejected, nothing paid',
      old.envelope?.ok === false && !old.acked && w2?.coins === w?.coins,
      `HTTP ${old.status} ${old.envelope?.error?.code ?? '-'} reason=${old.envelope?.error?.details?.reason ?? '-'}`);
  }
}

/** Recreate Nakama with the local override; `overrides` apply to this boot only (never written to .env). */
async function recreateNakama(bin, overrides) {
  const childEnv = { ...process.env };
  delete childEnv.IAP_MOCK;
  delete childEnv.LEVELPLAY_S2S_PRIVATE_KEY;
  Object.assign(childEnv, overrides);
  execFileSync(bin, [...COMPOSE_ARGS, 'up', '-d', '--force-recreate', 'nakama'], { cwd: ROOT, env: childEnv, stdio: 'ignore' });
  return waitHealthy();
}

async function waitHealthy() {
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

// ── Dedicated race server (plan fishnet-nakama-server, T-07) ────────────────
/** Lap time of the fake server's results: above the class-D floor (>= 48 000 ms/lap). */
const DEDICATED_LAP_MS = 48_100;
const DEDICATED_HEARTBEAT_MS = 3_000;
const DEDICATED_MATCH_TIMEOUT_MS = 90_000;
const DEDICATED_CHECK = 'dedicated server flow';

/** A server-to-server call: runtime http_key in the URL, serverKey in the body, no player session. */
const rsCall = (id, serverKey, payload) => rpc(null, id, { serverKey, ...payload }, { httpKey: ENV_HTTP_KEY });

/** The matchmaker ticket of a dedicated race: the client's ticket with the 2..4 group from `output`. */
function dedicatedTicket(params) {
  const t = clientTicket(params);
  t.min_count = params.output.minCount;
  t.max_count = params.output.maxCount;
  return t;
}

/**
 * Simulates the headless server: heartbeat, two players matched with hosting=dedicated,
 * join validation, start, official results, wallets paid and the server freed.
 * Uses 127.0.0.1 as the server host (no port is ever opened).
 */
async function dedicatedScenario(serverKey, env, ct) {
  const secret = env.RACE_SERVER_SECRET;
  if (!secret) {
    record(DEDICATED_CHECK, false,
      'RACE_SERVER_SECRET is empty in .env: set it and recreate Nakama with the local override (human step, plan fishnet-nakama-server T-14); use --skip-dedicated to skip this block');
    return;
  }
  if (!ENV_HTTP_KEY) {
    record(DEDICATED_CHECK, false, 'NAKAMA_RUNTIME_HTTP_KEY not in .env');
    return;
  }
  const serverId = `smoke-ds-${Date.now()}`;
  const hb = (sessionId) => rsCall('rs_heartbeat', secret, {
    serverId, host: '127.0.0.1', port: 7770, capacity: 1, activeSessionId: sessionId, buildVersion: 'smoke',
  });
  const sockets = [];
  let timer = null;
  let activeSessionId = null;
  let assignment = null;
  try {
    const wrong = await rsCall('rs_heartbeat', `${secret}-wrong`, {
      serverId, host: '127.0.0.1', port: 7770, capacity: 1, activeSessionId: null, buildVersion: 'smoke',
    });
    record('dedicated: heartbeat with a wrong serverKey → FORBIDDEN', errCode(wrong) === 'FORBIDDEN',
      `${errCode(wrong)} reason=${wrong.envelope?.error?.details?.reason ?? '-'}`);
    const first = await hb(null);
    record('dedicated: the fake server registers with a heartbeat (no assignment yet)',
      first.envelope?.ok === true && first.envelope.data?.assignment === null,
      first.envelope?.ok ? 'assignment=null' : `${errCode(first)} reason=${first.envelope?.error?.details?.reason ?? '-'}`);
    if (first.envelope?.ok !== true) return;
    // Keep the server alive (alive = heartbeat within 10 s) and capture its assignment.
    timer = setInterval(() => {
      hb(activeSessionId).then((r) => {
        if (r.envelope?.data?.assignment) assignment = r.envelope.data.assignment;
      }).catch(() => {});
    }, DEDICATED_HEARTBEAT_MS);

    const players = await freshAccounts(serverKey, 'ds', ['D1', 'D2']);
    const names = ['D1', 'D2'];
    const before = {};
    for (const n of names) before[n] = await walletOf(players[n]);

    for (const n of names) {
      const params = await rpc(players[n].token, 'mm_ticket_params', { mode: 'quick', size: 2, hosting: 'dedicated' });
      const o = params.envelope?.data?.output;
      if (n === 'D1') {
        record('dedicated: mm_ticket_params(hosting=dedicated) → minCount 2, maxCount 4, size 4',
          params.envelope?.ok === true && o?.hosting === 'dedicated' && o.minCount === 2 && o.maxCount === 4 && o.size === 4,
          params.envelope?.ok ? JSON.stringify({ hosting: o?.hosting, min: o?.minCount, max: o?.maxCount, size: o?.size }) : errCode(params));
      }
      if (params.envelope?.ok !== true) return;
      const sock = await openSocket(players[n].token);
      sockets.push(sock);
      sock.send({ matchmaker_add: dedicatedTicket(params.envelope.data) });
    }
    const matched = await Promise.all(sockets.map((s) => s.waitFor('matchmaker_matched', DEDICATED_MATCH_TIMEOUT_MS)));
    if (matched.some((x) => x === null)) {
      record('dedicated: both players are matched (2..4 group)', false, `no matchmaker_matched within ${DEDICATED_MATCH_TIMEOUT_MS / 1000} s`);
      return;
    }

    const got = {};
    for (const n of names) got[n] = await rpc(players[n].token, 'race_session_get', {});
    const s1 = got.D1.envelope?.data;
    const s2 = got.D2.envelope?.data;
    const t1 = s1?.myJoinTicket;
    const t2 = s2?.myJoinTicket;
    const sessionId = s1?.session?.id;
    record('dedicated: both read server{host,port} and their own myJoinTicket',
      typeof sessionId === 'string' && sessionId === s2?.session?.id
        && s1?.session?.serverHosted === true && s1?.server?.host === '127.0.0.1' && s1?.server?.port === 7770
        && s2?.server?.port === 7770
        && typeof t1 === 'string' && typeof t2 === 'string' && t1 !== t2
        && !JSON.stringify(s1).includes(t2) && !JSON.stringify(s2).includes(t1),
      `${errCode(got.D1)}/${errCode(got.D2)} sid=${String(sessionId).slice(0, 8)} server=${JSON.stringify(s1?.server)} laps=${s1?.session?.laps} ticketsDistinct=${t1 !== t2}`);
    if (typeof sessionId !== 'string' || typeof t1 !== 'string' || typeof t2 !== 'string') return;

    // The next heartbeat carries the assignment.
    for (let i = 0; i < 6 && !assignment; i++) await sleep(DEDICATED_HEARTBEAT_MS);
    const expected = assignment?.expectedUserIds ?? [];
    record('dedicated: the heartbeat receives the assignment (session, laps, both humans, deadline)',
      assignment?.sessionId === sessionId && Number.isInteger(assignment.laps) && assignment.laps > 0
        && expected.length === 2 && expected.includes(players.D1.uid) && expected.includes(players.D2.uid)
        && assignment.joinDeadlineMs > Date.now() - 60_000,
      assignment ? `laps=${assignment.laps} mode=${assignment.mode} track=${assignment.trackId} expected=${expected.length}` : 'no assignment within 18 s');
    if (!assignment || assignment.sessionId !== sessionId) return;
    activeSessionId = sessionId;

    const base = { serverId, sessionId };
    const v1 = await rsCall('rs_join_validate', secret, { ...base, joinTicket: t1 });
    const v2 = await rsCall('rs_join_validate', secret, { ...base, joinTicket: t2 });
    const bad = await rsCall('rs_join_validate', secret, { ...base, joinTicket: 'f'.repeat(32) });
    record('dedicated: rs_join_validate maps each ticket to its player; a forged one → FORBIDDEN/BAD_TICKET',
      v1.envelope?.data?.userId === players.D1.uid && v2.envelope?.data?.userId === players.D2.uid
        && errCode(bad) === 'FORBIDDEN' && bad.envelope?.error?.details?.reason === 'BAD_TICKET',
      `${errCode(v1)}/${errCode(v2)} forged=${errCode(bad)} reason=${bad.envelope?.error?.details?.reason ?? '-'}`);

    const started = await rsCall('rs_session_start', secret, base);
    record('dedicated: rs_session_start → startedAt', started.envelope?.ok === true && typeof started.envelope.data?.startedAt === 'number',
      started.envelope?.ok ? `startedAt=${started.envelope.data.startedAt}` : errCode(started));

    const laps = (extraMs) => Array.from({ length: assignment.laps }, () => DEDICATED_LAP_MS + extraMs);
    const total = (l) => l.reduce((x, y) => x + y, 0);
    const lapsD1 = laps(0);
    const lapsD2 = laps(500);
    const payload = {
      ...base,
      requestId: `smoke-rs-${Date.now()}`,
      results: [
        { userId: players.D1.uid, isBot: false, displayName: 'smoke D1', totalMs: total(lapsD1), laps: lapsD1, dnf: false },
        { userId: players.D2.uid, isBot: false, displayName: 'smoke D2', totalMs: total(lapsD2), laps: lapsD2, dnf: false },
      ],
    };
    const sub = await rsCall('rs_submit_results', secret, payload);
    const official = sub.envelope?.data?.officialResults ?? [];
    const rewards = sub.envelope?.data?.rewards ?? {};
    record('dedicated: rs_submit_results → official ranks 1..2 and rewards for both',
      sub.envelope?.ok === true && official.length === 2 && official[0].userId === players.D1.uid && official[0].rank === 1
        && official[1].userId === players.D2.uid && official[1].rank === 2
        && rewards[players.D1.uid]?.coins > 0 && rewards[players.D2.uid]?.coins > 0,
      sub.envelope?.ok
        ? `ranks=${official.map((r) => `${r.rank}:${String(r.userId).slice(0, 4)}`).join(',')} coins=${names.map((n) => rewards[players[n].uid]?.coins).join('/')}`
        : `${errCode(sub)} reason=${sub.envelope?.error?.details?.reason ?? '-'}`);
    activeSessionId = null;

    const after = {};
    for (const n of names) after[n] = await walletOf(players[n]);
    const delta = names.map((n) => (after[n]?.coins ?? 0) - (before[n]?.coins ?? 0));
    record('dedicated: both wallets received the coins of the results',
      names.every((n, i) => delta[i] > 0 && delta[i] >= (rewards[players[n].uid]?.coins ?? Infinity)),
      `delta=${delta.join('/')} rewards=${names.map((n) => rewards[players[n].uid]?.coins).join('/')}`);

    const retry = await rsCall('rs_submit_results', secret, payload);
    const afterRetry = await walletOf(players.D1);
    record('dedicated: retrying the same requestId replays the answer and pays nothing more',
      retry.envelope?.ok === true && JSON.stringify(retry.envelope.data) === JSON.stringify(sub.envelope?.data)
        && afterRetry?.coins === after.D1?.coins,
      `${errCode(retry)} equal=${JSON.stringify(retry.envelope?.data) === JSON.stringify(sub.envelope?.data)} coins ${after.D1?.coins} → ${afterRetry?.coins}`);

    const closed = await rpc(players.D1.token, 'race_session_get', { sessionId });
    const freeBeat = await hb(null);
    let registry = 'console unavailable';
    let freed = freeBeat.envelope?.ok === true && freeBeat.envelope.data?.assignment === null;
    if (ct) {
      const row = await consoleGet(ct, objectPath('race_servers', serverId, SYSTEM_USER));
      let value = null;
      try { value = JSON.parse(row.body?.value ?? 'null'); } catch { value = null; }
      registry = `race_servers.sessionId=${value ? (value.sessionId ?? 'null') : `HTTP ${row.status}`}`;
      freed = freed && value !== null && value.sessionId === null;
    }
    record('dedicated: the session is closed and the server is free again',
      closed.envelope?.data?.session?.state === 'closed' && freed,
      `state=${closed.envelope?.data?.session?.state} heartbeat=${freeBeat.envelope?.data?.assignment === null ? 'no assignment' : errCode(freeBeat)} ${registry}`);
  } catch (e) {
    record(DEDICATED_CHECK, false, e instanceof Error ? e.message : String(e));
  } finally {
    if (timer) clearInterval(timer);
    for (const s of sockets) s.close();
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`smoke-live → ${BASE}${SKIP_DOCKER ? ' (docker checks skipped)' : ''}`);
  const env = readEnv();
  const serverKey = env.NAKAMA_SERVER_KEY;
  const httpKey = env.NAKAMA_RUNTIME_HTTP_KEY;
  ENV_HTTP_KEY = httpKey ?? '';
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
  // F3 (T-13, T-14): fresh K1/K2/K3; their races share the same wait.
  const f3k = await freshAccounts(serverKey, 'f3', ['K1', 'K2', 'K3']);
  const f3 = SKIP_RACE ? null : await startF3Races(f3k);

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

  // F4 (T-15): native linking, no token or secret in the bundle.
  const ct4 = await consoleToken(env);
  // F6 (T-23): seed the drill tournaments early, so the service ticker
  // closes the ended one and ticks again before the end of the run.
  const seededT = ct4 ? await seedTournaments(ct4, serverKey) : null;
  await linkingScenario(serverKey, ct4);

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

  // F3 profile and version gate (T-14) while the race clocks run.
  await profileAndVersionChecks({ k: f3k }, a);

  // F5 (T-18, T-19, T-20) while the race clocks run.
  if (ct4 && httpKey) {
    await withAdminKey(ct4, async (adminKey) => {
      await storagePermissionChecks(ct4, adminKey, a);
      await passChecks(ct4, adminKey, serverKey);
    });
    await missionChecks(ct4, serverKey);
  } else {
    record('F5 storage and progression checks', null, 'console credentials or NAKAMA_RUNTIME_HTTP_KEY not in .env');
  }

  // F6 (T-21, T-22, T-23) while the race clocks run.
  if (ct4) {
    const club = await clubChecks(ct4, serverKey);
    await socialChecks(ct4, serverKey, club);
    if (seededT) await tournamentJoinChecks(ct4, seededT);
  } else {
    record('F6 social, clubs and tournaments checks', null, 'console credentials not in .env');
  }
  await eventChecks(a);

  // F7 (T-24, T-25) on the .env defaults (IAP_MOCK=false, empty LevelPlay secret).
  await f7DefaultChecks(serverKey, 'defaults');

  if (f1) await matchmakerScenario(f1.m);
  // Dedicated race server (T-07): a fake server drives the rs_* RPCs; a failure here does not stop the rest.
  if (SKIP_DEDICATED) record(DEDICATED_CHECK, null, '--skip-dedicated');
  else await dedicatedScenario(serverKey, env, ct4);
  if (race) await finishPrivateRace(fresh, race);
  else record('1-player private race closes', null, '--skip-race');
  // T-20: that race came before any missions_get / achievements_get of `fresh`.
  if (race && ct4) await earlyProgressCheck(ct4, fresh);
  if (f3) await finishF3Races(f3, 'quick');
  else record('T-13 wins_week / ranked order (needs races)', null, '--skip-race');
  const f1Retry = f1?.three ? await finishF1Races(f1.p, f1.three, f1.h, f1.claimRace, bin) : null;
  if (f3) {
    await finishF3Races(f3, 'ranked');
    await leaderboardChecks(f3);
    // F4 (T-16): K3 has raced (quick + ranked); delete it last.
    await deleteScenario(ct4, f3k.K3, c);
  } else {
    record('T-16 account_delete of an account with a race', null, '--skip-race');
  }

  // F6 (T-23): by now the ticker closed the ended drill tournament and ticked again.
  if (seededT) await tournamentCloseChecks(ct4, seededT, bin);

  if (bin) {
    const registered = checkLogs(bin);
    record('logs: RPC registrations since boot', registered === ids.length, `${registered}/${ids.length}`);
  }

  // Restart last: the log checks above cover the run before it.
  if (bin && econ && !SKIP_RESTART) {
    // F4 (T-17): legacy inbox entries, migrated by the next boot.
    const seeded = ct4 ? await seedLegacyInbox(ct4, serverKey) : null;
    // F7: the restart is a recreate with IAP_MOCK=true and a random local
    // LevelPlay signing key for this boot only (never written to .env).
    const testKey = randomBytes(16).toString('hex');
    const up = await recreateNakama(bin, { IAP_MOCK: 'true', LEVELPLAY_S2S_PRIVATE_KEY: testKey });
    record('Nakama recreated (override, IAP_MOCK=true + test LevelPlay key) and answering', up, '');
    if (up) {
      await afterRestartChecks(econ, f1Retry);
      if (seeded) await inboxChecks(ct4, seeded);
      const mock = await f7MockChecks(serverKey, testKey);
      const { started, lines } = nakamaLogsSinceBoot(bin);
      recordErrors('logs: no error-level lines since the restart', classifyErrors(parseLogLines(lines)), started);
      // Back to the .env values (IAP_MOCK=false, empty secret) and check again.
      const back = await recreateNakama(bin, {});
      record('Nakama recreated on the .env defaults (IAP_MOCK=false) and answering', back, '');
      if (back) {
        await f7DefaultChecks(serverKey, 'defaults again');
        await f7AfterDefaultsChecks(mock, testKey);
        const again = nakamaLogsSinceBoot(bin);
        recordErrors('logs: no error-level lines since the last recreate', classifyErrors(parseLogLines(again.lines)), again.started);
      }
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
