'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ACTIVITY_HOLD_MS = 120_000;

/**
 * How long a session may go without using tokens before it stops counting
 * as a live agent.
 */
const AGENT_ACTIVE_MS = 30 * 60_000;
const MODEL_DISPLAY_HOLD_MS = 6 * 60 * 60_000;

const OPENCLAW_AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR
  || path.join(os.homedir(), '.openclaw', 'agents');
const REMOTE_OPENCLAW_HOST = process.env.PSP_BUDDY_REMOTE_OPENCLAW_HOST || '';
const REMOTE_OPENCLAW_PROBE = process.env.PSP_BUDDY_REMOTE_OPENCLAW_PROBE
  || '/home/beast/Development/psp-buddy/bridge/live-agent-probe.js';

// Lazy because Bun runs the shared source tests but does not expose
// Node's built-in sqlite module. The production bridge is Node 25.
function openReadonlyDatabase(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Token Monitor provider keys that map to a tank creature.
 *
 * `muse` is the Muse bridge and `meta` is the upstream model the bridge
 * calls -- Token Monitor reports them as separate providers, so they are
 * separate creatures here.
 */
const TANK_PROVIDERS = ['codex', 'minimax', 'kimi', 'muse-bridge', 'meta', 'opencode-go'];

/** Token Monitor calls OpenAI-backed session usage `openai`, but calls the
 * matching quota provider `codex`. They are one tank resident. */
function tankProvider(provider) {
  if (provider === 'openai') return 'codex';
  return TANK_PROVIDERS.includes(provider) ? provider : null;
}

/** Token Monitor publishes the OpenCode Go quota under the provider id
 * `opencode`, while the OpenClaw side of that same provider is `opencode-go`.
 * They are one tank resident, so the quota row has to be renamed on the way
 * in or it is dropped for not matching a tank provider. */
const LIMIT_PROVIDER_ALIAS = { opencode: 'opencode-go' };

function limitProvider(provider) {
  const alias = LIMIT_PROVIDER_ALIAS[provider];
  if (alias) return alias;
  return TANK_PROVIDERS.includes(provider) ? provider : null;
}

function relevantSession(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.client === 'codex') return true;
  return session.client === 'openclaw' && finite(session.providers?.openai, 0) > 0;
}

function usageSnapshot(stats) {
  const period = stats?.periods?.today || {};
  const sessions = Object.values(period.sessions || {}).filter(relevantSession);
  const sessionTokens = sessions.reduce((sum, session) => sum + finite(session.totalTokens, 0), 0);
  const clientTokens = finite(period.clients?.codex, 0) + finite(period.clients?.openclaw, 0);
  return {
    tokens: sessions.length > 0 ? sessionTokens : clientTokens,
    lastUsedAt: sessions.reduce((latest, session) => Math.max(latest, timestamp(session.lastUsedAt)), 0)
  };
}

function codexLimits(stats) {
  const rows = (stats?.limits?.providers || [])
    .filter((row) => row?.provider === 'codex' && row.status === 'ok' && row.stale !== true)
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
  const row = rows[0];
  if (!row) return { available: false, session: null, weekly: null };
  const window = (kind) => {
    const value = (row.windows || []).find((item) => item?.kind === kind && item.additional !== true);
    if (!value) return null;
    return {
      remaining: finite(value.remainingPercent),
      resetsAt: timestamp(value.resetsAt)
    };
  };
  return { available: true, session: window('session'), weekly: window('weekly') };
}

/**
 * Per-model limits straight from Token Monitor.
 *
 * Returns one entry per provider that actually reports status 'ok', with
 * its session and weekly windows. Providers that are 'notConfigured' (no
 * API key) or 'unauthorized' are simply absent -- the tank shows them as
 * "no signal" rather than inventing a quota.
 */
function modelLimits(stats) {
  const out = {};
  for (const row of stats?.limits?.providers || []) {
    const provider = limitProvider(row?.provider);
    if (!provider) continue;
    if (row.status !== 'ok' || row.stale === true) continue;
    const window = (kind) => {
      const value = (row.windows || []).find((item) => item?.kind === kind && item.additional !== true);
      if (!value) return null;
      return {
        remaining: finite(value.remainingPercent),
        resetsAt: timestamp(value.resetsAt)
      };
    };
    // Token Monitor normalizes the monthly window to the kind `billing`, so
    // asking for `monthly` alone would never match and the longer window
    // would silently read as unknown. `billing` is the monthly pool, except
    // when the window is a prepaid-credit row, which is a different thing.
    const billing = (row.windows || []).find((item) => item?.kind === 'billing'
      && item.metric !== 'credits' && item.additional !== true);
    out[provider] = {
      session: window('session'),
      weekly: window('weekly'),
      monthly: window('monthly') || window('month') || (billing ? {
        remaining: finite(billing.remainingPercent),
        resetsAt: timestamp(billing.resetsAt)
      } : null),
      updatedAt: timestamp(row.updatedAt)
    };
  }
  return out;
}

/**
 * Live agent counts and token rate per model.
 *
 * Token Monitor's session list gives every session that ran in a period, the
 * model provider it used, its token counts and when it was last used. From
 * that we can count the AGENTS currently active on each model (sessions used
 * within AGENT_ACTIVE_MS) and derive a token rate.
 *
 * THE RATE IS OUTPUT TOKENS, NOT TOTAL TOKENS.
 *
 * A session's `totalTokens` includes `cacheReadTokens`, and on a long
 * OpenClaw session the cache dominates completely -- a single turn here
 * reports ~430k cached tokens against ~180 output tokens. Dividing that
 * total by elapsed time produced a "rate" of ~37,500 tokens/sec, which is
 * an accounting artefact, not throughput: it says how fast the prompt was
 * re-read from cache, not how fast the model generated.
 *
 * `outputTokens` is the real generation volume. Token Monitor's own
 * `modelThroughput` confirms the split for the models that report it:
 *
 *   muse-wonder-1.0:  timedTokens/duration = 32,251/s   <- the artefact
 *                     timedOutputTokens/dur =     79/s   <- the truth
 *
 * So the rate here is the delta of OUTPUT tokens over the poll interval.
 *
 * The MONTH period is the source for the agent count, not TODAY: "today"
 * resets at midnight, so a long-running agent would vanish from the count
 * overnight even though it is still running. The month period keeps the
 * full set of sessions, and the recency filter picks the live ones out of
 * it.
 *
 * `memory` carries the previous per-provider output totals so the rate can
 * be computed between polls.
 */
function modelActivity(stats, memory = {}, now = Date.now()) {
  const periods = stats?.periods || {};
  const period = periods.month || periods.today || {};
  const sessions = Object.entries(period.sessions || {});
  const perProvider = {};

  // Per-SESSION output totals from the previous poll. A session whose
  // output grew since then is WORKING RIGHT NOW, even if its
  // `lastUsedAt` is stale.
  //
  // WHY THIS IS NEEDED: Token Monitor only advances a session's
  // `lastUsedAt` when its own scan runs, which can be tens of minutes
  // behind the truth. A session that is actively streaming tokens then
  // looks idle, the agent count drops to zero, and the tank empties
  // while the agent is demonstrably running. Comparing output totals
  // between polls measures the real thing.
  const previousSessions = memory.sessionOutputTokens || {};
  const sessionOutputTokens = {};
  const elapsedSec = Math.max(1, (now - (memory.sampledAt || now - 10000)) / 1000);

  for (const [sessionKey, session] of sessions) {
    const providers = session?.providers;
    if (!providers || typeof providers !== 'object') continue;
    const lastUsedAt = timestamp(session.lastUsedAt);
    const normalizedTotals = {};
    for (const [source, tokens] of Object.entries(providers)) {
      const provider = tankProvider(source);
      if (!provider) continue;
      normalizedTotals[provider] = (normalizedTotals[provider] || 0) + finite(tokens, 0);
    }
    const providerKeys = Object.keys(normalizedTotals);
    if (providerKeys.length === 0) continue;

    // Output tokens are per SESSION, not per provider. When a session spans
    // several providers, attribute its output to the one that dominated its
    // tokens -- splitting it evenly would understate the busiest provider.
    const dominant = providerKeys.reduce((best, p) => (
      normalizedTotals[p] > normalizedTotals[best] ? p : best
    ));
    const outputTokens = finite(session.outputTokens, 0);
    const sessionId = String(session.sessionId || sessionKey);
    sessionOutputTokens[sessionId] = outputTokens;

    // A session counts as live if the hub says it was used recently, OR
    // if its output grew since the previous poll.
    const grew = previousSessions[sessionId] !== undefined
      && outputTokens > previousSessions[sessionId];
    const live = grew || (lastUsedAt > 0 && now - lastUsedAt <= AGENT_ACTIVE_MS);

    for (const provider of providerKeys) {
      const entry = perProvider[provider] || (perProvider[provider] = {
        outputTokens: 0, agents: 0, lastUsedAt: 0, agentRates: []
      });
      // Keep the provider's last observed use so the client can show a known
      // subscription while it is idle. This matters for Muse: Token Monitor
      // records Muse usage but exposes no Muse quota provider.
      entry.lastUsedAt = Math.max(entry.lastUsedAt, lastUsedAt);
      if (provider === dominant) {
        entry.outputTokens += outputTokens;
      }
      if (live) {
        entry.agents += 1;
        entry.lastUsedAt = Math.max(entry.lastUsedAt, lastUsedAt);
        if (provider === dominant) {
          const before = finite(previousSessions[sessionId], outputTokens);
          entry.agentRates.push({
            sessionId,
            tokensPerSecond: Math.max(0, outputTokens - before) / elapsedSec
          });
        }
      }
    }
  }

  const previous = memory.providerTotals || {};
  const totals = {};
  const out = {};
  for (const [provider, entry] of Object.entries(perProvider)) {
    totals[provider] = entry.outputTokens;
    const before = finite(previous[provider], entry.outputTokens);
    const delta = Math.max(0, entry.outputTokens - before);
    out[provider] = {
      // OUTPUT tokens per second -- real generation throughput.
      tokensPerSecond: delta / elapsedSec,
      // Stable session-id order keeps each creature attached to the same
      // measured agent instead of reshuffling their speeds every poll.
      agentRates: entry.agentRates
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map((item) => item.tokensPerSecond),
      agentCount: entry.agents,
      totalTokens: entry.outputTokens,
      lastUsedAt: entry.lastUsedAt
    };
  }

  return { activity: out, totals, sampledAt: now, sessionOutputTokens };
}

function publicState(stats, memory = {}, now = Date.now()) {
  const usage = usageSnapshot(stats);
  const limits = codexLimits(stats);
  const models = modelLimits(stats);
  const { activity, totals, sampledAt, sessionOutputTokens } = modelActivity(stats, memory, now);

  const previousTokens = finite(memory.previousTokens, usage.tokens);
  const increased = usage.tokens > previousTokens;
  const lastActiveAt = increased ? now : Math.max(finite(memory.lastActiveAt, 0), usage.lastUsedAt);
  const recentlyActive = lastActiveAt > 0 && now - lastActiveAt <= ACTIVITY_HOLD_MS;

  let mode = 'waiting';
  let message = 'READY WHEN YOU ARE';
  let wakesAt = 0;

  if (!limits.available) {
    mode = 'offline';
    message = 'CHECKING THE SIGNAL';
  } else if (limits.weekly?.remaining !== null && limits.weekly.remaining <= 0) {
    mode = 'hibernating';
    message = 'HIBERNATING IN THE CAVE';
    wakesAt = limits.weekly.resetsAt;
  } else if (limits.session?.remaining !== null && limits.session.remaining <= 0) {
    mode = 'napping';
    message = 'QUOTA NAP';
    wakesAt = limits.session.resetsAt;
  } else if (recentlyActive) {
    mode = 'thriving';
    message = 'TOKENS! TOKENS! TOKENS!';
  }

  return {
    state: {
      version: 2,
      mode,
      message,
      sessionRemaining: limits.session?.remaining ?? -1,
      sessionResetsAt: limits.session?.resetsAt > 0 ? Math.floor(limits.session.resetsAt / 1000) : 0,
      weeklyRemaining: limits.weekly?.remaining ?? -1,
      wakesAt: wakesAt > 0 ? Math.floor(wakesAt / 1000) : 0,
      sampledAt: Math.floor(now / 1000),
      // Per-model telemetry: quota windows, token rate, live agent count.
      //
      // A model is included only if we have MEASURABLE data for it: a
      // published quota (even an exhausted one -- that is a real state the
      // creature must be able to express by sleeping), or tokens flowing,
      // or agents running right now.
      //
      // A model we have never heard from is omitted entirely rather than
      // published with empty fields: the client would otherwise have to
      // render a "--" row for a provider that is not reporting anything,
      // which is clutter and implies knowledge we do not have.
      models: Object.fromEntries([...new Set([
        ...Object.keys(models),
        ...Object.keys(activity)
      ])].map((provider) => {
        const limitsRow = models[provider];
        const act = activity[provider];
        const sessionRemaining = limitsRow?.session?.remaining ?? -1;
        const tokensPerSecond = Math.round(act?.tokensPerSecond || 0);
        const agentCount = act?.agentCount || 0;
        // Each creature moves at ITS OWN share of the model's throughput,
        // so the per-agent rate is published rather than left for every
        // client to recompute.
        const agentRates = (act?.agentRates || []).map((rate) => Math.round(rate));
        const tokensPerSecondPerAgent = agentCount > 0
          ? Math.round(tokensPerSecond / agentCount)
          : tokensPerSecond;
        const recentlyKnown = act?.lastUsedAt > 0
          && now - act.lastUsedAt <= MODEL_DISPLAY_HOLD_MS;
        const measurable = sessionRemaining >= 0 || tokensPerSecond > 0 || agentCount > 0 || recentlyKnown;
        if (!measurable) return null;
        // Seconds until this model's session quota resets, measured on the
        // server. The PSP has no usable Unix epoch (QuickJS's Date.now()
        // uses gettimeofday), so a DURATION is the only form of this value
        // the device can count down correctly.
        const sessionResetsInSec = limitsRow?.session?.resetsAt > 0
          ? Math.max(0, Math.ceil((limitsRow.session.resetsAt - now) / 1000))
          : -1;
        return [provider, {
          sessionRemaining,
          sessionResetsAt: limitsRow?.session?.resetsAt > 0 ? Math.floor(limitsRow.session.resetsAt / 1000) : 0,
          weeklyRemaining: limitsRow?.weekly?.remaining ?? -1,
          weeklyResetsAt: limitsRow?.weekly?.resetsAt > 0 ? Math.floor(limitsRow.weekly.resetsAt / 1000) : 0,
          monthlyRemaining: limitsRow?.monthly?.remaining ?? -1,
          monthlyResetsAt: limitsRow?.monthly?.resetsAt > 0 ? Math.floor(limitsRow.monthly.resetsAt / 1000) : 0,
          tokensPerSecond,
          tokensPerSecondPerAgent,
          agentRates,
          sessionResetsInSec,
          agentCount,
          totalTokens: act?.totalTokens || 0
        }];
      }).filter(Boolean))
    },
    memory: {
      previousTokens: usage.tokens,
      lastActiveAt,
      providerTotals: totals,
      sessionOutputTokens,
      sampledAt
    }
  };
}

/**
 * Live agents straight from OpenClaw's own session list.
 *
 * WHY THIS EXISTS: Token Monitor's session records only advance when its
 * own scan runs, which can be tens of minutes behind the truth. A session
 * that is actively streaming tokens then looks idle, the agent count
 * drops to zero, and the tank empties while the agent is demonstrably
 * running. The bridge was reporting "0 agents" for a session that was
 * actively answering messages.
 *
 * OpenClaw's session list is authoritative and live: it reports each
 * session's model provider and how long ago it was last touched. A
 * session touched within AGENT_ACTIVE_MS is a running agent.
 *
 * Returns a map of tank provider -> agent count, or null when the live
 * source is unavailable (the caller then falls back to Token Monitor).
 */
function openClawSessionDatabases() {
  try {
    return fs.readdirSync(OPENCLAW_AGENTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(OPENCLAW_AGENTS_DIR, entry.name, 'agent', 'openclaw-agent.sqlite'))
      .filter((file) => fs.existsSync(file));
  } catch {
    return [];
  }
}

/**
 * Muse can keep its own long-lived runtime process alive without updating the
 * OpenClaw session row until a turn completes. In that case the session DB is
 * stale even though the model is actively available. Count the runtime as a
 * conservative liveness signal; output rates still come only from session
 * data, never from process presence.
 */
function liveMuseProcesses() {
  if (process.platform !== 'linux') return 0;
  let count = 0;
  try {
    for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        const command = fs.readFileSync(`/proc/${entry.name}/cmdline`, 'utf8');
        if (command.includes('muse-bin')) count++;
      } catch {
        // Processes can exit between readdir and readFileSync.
      }
    }
  } catch {
    return 0;
  }
  return count;
}

function remoteLiveAgents() {
  if (!REMOTE_OPENCLAW_HOST) return null;
  const result = spawnSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=3',
    REMOTE_OPENCLAW_HOST,
    'node', REMOTE_OPENCLAW_PROBE
  ], { encoding: 'utf8', timeout: 4_000 });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const value = JSON.parse(result.stdout.trim());
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function liveCodexTurns(now) {
  let count = 0;
  for (const agent of fs.readdirSync(OPENCLAW_AGENTS_DIR, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const file = path.join(
      OPENCLAW_AGENTS_DIR,
      agent.name,
      'agent',
      'codex-home',
      'thread_history_1.sqlite'
    );
    if (!fs.existsSync(file)) continue;
    let db;
    try {
      db = openReadonlyDatabase(file);
      const row = db.prepare(`
        SELECT COUNT(DISTINCT thread_id) AS agents
          FROM thread_turns
         WHERE status = 'inProgress'
           AND started_at >= ?
      `).get(Math.floor((now - AGENT_ACTIVE_MS) / 1000));
      count += Number(row?.agents || 0);
    } finally {
      db?.close();
    }
  }
  return count;
}

function liveAgents(now = Date.now()) {
  const out = {};
  const rates = {};
  let readable = false;
  for (const file of openClawSessionDatabases()) {
    let db;
    try {
      db = openReadonlyDatabase(file);
      const rows = db.prepare(`
        SELECT sw.model_provider AS provider, sw.session_id AS sessionId,
               sn.entry_json AS entryJson
          FROM session_windows sw
          JOIN session_nodes sn ON sn.session_key = sw.session_key
         WHERE sw.session_id = sn.current_session_id
           AND sw.model_provider IS NOT NULL
           AND (
             sw.updated_at >= ?
             OR sn.updated_at >= ?
             OR EXISTS (
               SELECT 1 FROM transcript_events te
                WHERE te.session_id = sw.session_id
                  AND te.created_at >= ?
             )
           )
           AND COALESCE(sn.status, sw.status, '') NOT IN ('failed', 'killed', 'timeout')
      `).all(now - AGENT_ACTIVE_MS, now - AGENT_ACTIVE_MS, now - AGENT_ACTIVE_MS);
      readable = true;
      for (const row of rows) {
        const provider = tankProvider(row.provider);
        if (!provider) continue;
        out[provider] = (out[provider] || 0) + 1;

        // Per-agent OUTPUT token count, live.
        //
        // Token Monitor's session totals only advance on its own slow scan,
        // so its rates read 0 while an agent is demonstrably generating.
        // The session entry carries the real per-session output total, so
        // each creature's speed can be measured rather than guessed.
        let entry;
        try {
          entry = JSON.parse(row.entryJson);
        } catch {
          continue;
        }
        const output = finite(entry?.outputTokens, null);
        const list = rates[provider] || (rates[provider] = []);
        list.push({ sessionId: row.sessionId, outputTokens: output ?? 0 });
      }
    } catch (error) {
      console.error(`[bridge] live session database unavailable (${file}): ${error.message}`);
    } finally {
      db?.close();
    }
  }

  const museProcesses = liveMuseProcesses();
  if (museProcesses > 0) {
    out['muse-bridge'] = Math.max(out['muse-bridge'] || 0, museProcesses);
    readable = true;
  }

  const remote = remoteLiveAgents();
  if (remote) {
    for (const [provider, count] of Object.entries(remote.counts || {})) {
      out[provider] = Math.max(out[provider] || 0, Number(count) || 0);
    }
    for (const [provider, list] of Object.entries(remote.rates || {})) {
      if (Array.isArray(list) && list.length > (rates[provider]?.length || 0)) {
        rates[provider] = list;
      }
    }
    readable = true;
  }

  // Codex records each running turn immediately in its thread-history DB,
  // while the corresponding OpenClaw session row may not commit until the
  // turn ends. Use the larger count so those two views cannot double-count.
  try {
    out.codex = Math.max(out.codex || 0, liveCodexTurns(now));
    readable = true;
  } catch (error) {
    console.error(`[bridge] live Codex process scan unavailable: ${error.message}`);
  }

  if (!readable) return null;
  return { counts: out, rates };
}

/**
 * Apply the live agent view to a published state.
 *
 * The live session databases are authoritative for BOTH the agent count and
 * each agent's own output rate. Token Monitor's view lags its scan, so its
 * counts can read zero while an agent is demonstrably working.
 *
 * `memory` carries the previous per-session output totals:
 *   - `liveOutputTokens`: session id -> output token total at the last poll
 * A session's output total is committed at the END of a turn. A zero delta
 * therefore means the agent is idle for this sample and must be published as
 * zero; holding an old rate makes a finished turn look active indefinitely.
 */
function applyLiveAgents(state, live, memory = {}, now = Date.now()) {
  if (!live) return { state, memory: {} };
  const counts = live.counts || {};
  const rates = live.rates || {};
  const previous = memory.liveOutputTokens || {};
  const elapsedSec = Math.max(1, (now - (memory.sampledAt || now - 10000)) / 1000);

  for (const [provider, row] of Object.entries(state.models)) {
    // Combine the live OpenClaw view with Token Monitor's recent-session
    // view. The latter captures external Codex app sessions and OpenCode CLI
    // sessions that are not OpenClaw rows. Use max rather than sum so an
    // OpenClaw session reported by both sources is not double-counted.
    const upstreamCount = Math.max(0, Number(row.agentCount) || 0);
    row.agentCount = Math.max(counts[provider] || 0, upstreamCount);
    const upstreamRates = Array.isArray(row.agentRates) ? row.agentRates : [];
    const list = (rates[provider] || [])
      .slice()
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const liveRates = list.map((item) => {
      const before = Number(previous[item.sessionId]);
      const delta = Number.isFinite(before) ? Math.max(0, item.outputTokens - before) : 0;
      const rate = Math.round(delta / elapsedSec);
      return rate;
    });
    // When Token Monitor has useful per-session rates for sessions outside
    // OpenClaw, retain those in the remaining slots (Codex desktop / OpenCode
    // CLI). Pad unmeasured agents with 0; never distribute an aggregate rate
    // to every creature.
    const hasLiveRateSource = Object.prototype.hasOwnProperty.call(rates, provider);
    row.agentRates = Array.from({ length: row.agentCount }, (_, index) => (
      liveRates[index] ?? (hasLiveRateSource ? 0 : upstreamRates[index] ?? 0)
    ));
    row.tokensPerSecond = row.agentRates.reduce((sum, rate) => sum + rate, 0);
    row.tokensPerSecondPerAgent = row.agentCount > 0
      ? Math.round(row.tokensPerSecond / row.agentCount)
      : row.tokensPerSecond;
  }

  for (const [provider, count] of Object.entries(counts)) {
    if (!state.models[provider] && count > 0) {
      state.models[provider] = {
        sessionRemaining: -1,
        sessionResetsAt: 0,
        weeklyRemaining: -1,
        weeklyResetsAt: 0,
        monthlyRemaining: -1,
        monthlyResetsAt: 0,
        tokensPerSecond: 0,
        tokensPerSecondPerAgent: 0,
        agentRates: Array(count).fill(0),
        sessionResetsInSec: -1,
        agentCount: count,
        totalTokens: 0
      };
    }
  }

  // A provider with no live agent, no quota, and no flowing output has no
  // measurable state. Drop it instead of adding a dead HUD row.
  for (const [provider, row] of Object.entries(state.models)) {
    if (provider !== 'muse-bridge'
        && row.agentCount === 0
        && row.sessionRemaining < 0
        && row.weeklyRemaining < 0
        && row.tokensPerSecond === 0) {
      delete state.models[provider];
    }
  }

  return {
    state,
    memory: {
      liveOutputTokens: Object.fromEntries(
        Object.entries(rates).flatMap(([, list]) => (
          list.map((item) => [item.sessionId, item.outputTokens])
        ))
      ),
      liveAgentRates: {}
    }
  };
}

module.exports = {
  ACTIVITY_HOLD_MS,
  AGENT_ACTIVE_MS,
  TANK_PROVIDERS,
  tankProvider,
  codexLimits,
  applyLiveAgents,
  liveAgents,
  modelActivity,
  modelLimits,
  publicState,
  usageSnapshot
};
