'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { publicState, liveAgents } = require('./state');
const { applyLiveAgents } = require('./state');

const bindHost = process.env.PSP_BUDDY_BIND || '127.0.0.1';
const port = Number(process.env.PSP_BUDDY_PORT || 17322);
const hubUrl = String(process.env.TOKEN_MONITOR_HUB_URL || 'http://127.0.0.1:17321').replace(/\/$/, '');
const pollMs = Math.max(2_000, Number(process.env.PSP_BUDDY_POLL_MS || 10_000));
const upstreamTimeoutMs = Math.max(5_000, Number(process.env.PSP_BUDDY_UPSTREAM_TIMEOUT_MS || 15_000));
const credentialFile = process.env.TOKEN_MONITOR_CREDENTIAL_FILE
  || path.join(os.homedir(), '.config', 'Token Monitor', 'credentials.json');

let latest = {
  version: 1,
  mode: 'offline',
  message: 'WAITING FOR GILBERT',
  sessionRemaining: -1,
  weeklyRemaining: -1,
  wakesAt: 0,
  sampledAt: Math.floor(Date.now() / 1000)
};
let stateMemory = {};
let upstreamOk = false;

function hubSecret() {
  if (process.env.TOKEN_MONITOR_SECRET) return process.env.TOKEN_MONITOR_SECRET;
  const document = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
  const secret = document?.credentials?.hub?.hostSecret;
  if (typeof secret !== 'string' || !secret) throw new Error('Token Monitor hub secret unavailable');
  return secret;
}

async function refresh() {
  const response = await fetch(`${hubUrl}/api/stats`, {
    headers: { authorization: `Bearer ${hubSecret()}` },
    signal: AbortSignal.timeout(upstreamTimeoutMs)
  });
  if (!response.ok) throw new Error(`Token Monitor hub returned HTTP ${response.status}`);
  const result = publicState(await response.json(), stateMemory);
  // OpenClaw's own session databases are the live view of which agents are
  // actually running. Token Monitor's records lag its scan, so its agent
  // counts can read zero while an agent is mid-answer. Prefer the live
  // counts; fall back to Token Monitor's when the CLI is unavailable.
  const live = liveAgents();
  const applied = applyLiveAgents(result.state, live, stateMemory, Date.now());
  result.state = applied.state;
  Object.assign(result.memory, applied.memory);
  latest = result.state;
  stateMemory = result.memory;
  upstreamOk = true;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, upstream: upstreamOk });
  }
  if (req.method === 'GET' && req.url === '/v1/buddy') return json(res, 200, latest);
  return json(res, 404, { error: 'not_found' });
});

async function poll() {
  try {
    await refresh();
  } catch (error) {
    // Preserve the last successful sample. Marking it as a fresh offline
    // sample made residents disappear during a transient slow hub scan and
    // disguised old model counts as newly sampled data.
    upstreamOk = false;
    console.error(`[bridge] ${error.message}`);
  } finally {
    // Schedule from completion so a slow upstream scan can never overlap the
    // next poll and create a thundering herd of requests.
    setTimeout(() => void poll(), pollMs).unref();
  }
}

server.listen(port, bindHost, () => {
  console.log(`[bridge] listening on http://${bindHost}:${port}`);
  void poll();
});
