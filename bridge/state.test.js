'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publicState, modelActivity, modelLimits, tankProvider } = require('./state');
const { applyLiveAgents } = require('./state');

const NOW = Date.parse('2026-11-03T12:00:00Z');
const MIN = 60_000;

function statsWithModels({ minimax = 93, kimi = 40, muse = 12 } = {}) {
  const sessions = {
    codexA: { client: 'openclaw', providers: { openai: 8000 }, totalTokens: 8000, outputTokens: 400, cacheReadTokens: 500000, lastUsedAt: new Date(NOW - 30_000).toISOString() },
    codexB: { client: 'openclaw', providers: { openai: 6000 }, totalTokens: 6000, outputTokens: 300, cacheReadTokens: 250000, lastUsedAt: new Date(NOW - 3 * MIN).toISOString() },
    a: { client: 'openclaw', providers: { minimax: 5000 }, totalTokens: 5000, outputTokens: 120, cacheReadTokens: 430000, lastUsedAt: new Date(NOW - 60_000).toISOString() },
    b: { client: 'openclaw', providers: { minimax: 100 }, totalTokens: 100, outputTokens: 40, cacheReadTokens: 0, lastUsedAt: new Date(NOW - 5 * MIN).toISOString() },
    c: { client: 'openclaw', providers: { kimi: 7000 }, totalTokens: 7000, outputTokens: 200, cacheReadTokens: 0, lastUsedAt: new Date(NOW - 2 * MIN).toISOString() },
    d: { client: 'muse', providers: { 'muse-bridge': 300 }, totalTokens: 300, outputTokens: 90, cacheReadTokens: 0, lastUsedAt: new Date(NOW - 90 * MIN).toISOString() },
    e: { client: 'muse', providers: { 'muse-bridge': 200 }, totalTokens: 200, outputTokens: 60, cacheReadTokens: 0, lastUsedAt: new Date(NOW - 120 * MIN).toISOString() },
    f: { client: 'muse', providers: { meta: 900 }, totalTokens: 900, outputTokens: 150, cacheReadTokens: 0, lastUsedAt: new Date(NOW - 30 * MIN).toISOString() }
  };
  return {
    periods: {
      // The month period carries the full session set; today resets at
      // midnight and would drop long-running agents from the count.
      month: { clients: { openclaw: 100 }, sessions },
      today: { clients: { openclaw: 100 }, sessions: { a: sessions.a } }
    },
    limits: { providers: [
      { provider: 'minimax', status: 'ok', updatedAt: new Date(NOW).toISOString(), windows: [
        { kind: 'session', remainingPercent: minimax, resetsAt: new Date(NOW + 3600_000).toISOString() },
        { kind: 'weekly', remainingPercent: 16, resetsAt: new Date(NOW + 4 * 86400_000).toISOString() },
        { kind: 'monthly', remainingPercent: 0, resetsAt: new Date(NOW + 20 * 86400_000).toISOString() }
      ] },
      { provider: 'kimi', status: 'ok', updatedAt: new Date(NOW).toISOString(), windows: [
        { kind: 'session', remainingPercent: kimi, resetsAt: new Date(NOW + 3600_000).toISOString() }
      ] },
      { provider: 'muse-bridge', status: 'ok', updatedAt: new Date(NOW).toISOString(), windows: [
        { kind: 'session', remainingPercent: muse, resetsAt: new Date(NOW + 3600_000).toISOString() }
      ] },
      { provider: 'meta', status: 'notConfigured', updatedAt: new Date(NOW).toISOString(), windows: [] },
      { provider: 'codex', status: 'ok', updatedAt: new Date(NOW).toISOString(), windows: [
        { kind: 'session', remainingPercent: 100, resetsAt: new Date(NOW + 3600_000).toISOString() },
        { kind: 'weekly', remainingPercent: 0, resetsAt: new Date(NOW + 86400_000).toISOString() }
      ] }
    ] }
  };
}

test('modelLimits reports only providers with status ok', () => {
  const limits = modelLimits(statsWithModels());
  assert.deepEqual(Object.keys(limits).sort(), ['codex', 'kimi', 'minimax', 'muse-bridge']);
  assert.equal(limits.minimax.session.remaining, 93);
  assert.equal(limits.minimax.weekly.remaining, 16);
  assert.equal(limits.minimax.monthly.remaining, 0);
});

test('OpenAI session usage maps to the Codex tank resident', () => {
  assert.equal(tankProvider('openai'), 'codex');
  const { activity } = modelActivity(statsWithModels(), {}, NOW);
  assert.equal(activity.codex.agentCount, 2);
  assert.equal(activity.openai, undefined);
});

test('the OpenCode Go quota row maps onto the opencode-go tank resident', () => {
  // Token Monitor publishes the Go quota under the provider id `opencode`,
  // while OpenClaw reports the same provider as `opencode-go`. Dropping the
  // row would leave the creature with no quota at all.
  const stats = {
    limits: { providers: [
      { provider: 'opencode', status: 'ok', updatedAt: new Date(NOW).toISOString(), windows: [
        { kind: 'session', remainingPercent: 80, resetsAt: new Date(NOW + 3600_000).toISOString() },
        { kind: 'weekly', remainingPercent: 45, resetsAt: new Date(NOW + 4 * 86400_000).toISOString() },
        { kind: 'monthly', remainingPercent: 0, resetsAt: new Date(NOW + 20 * 86400_000).toISOString() }
      ] }
    ] }
  };
  const limits = modelLimits(stats);
  assert.equal(limits['opencode-go'].session.remaining, 80);
  assert.equal(limits['opencode-go'].weekly.remaining, 45);
  assert.equal(limits['opencode-go'].monthly.remaining, 0);
  assert.equal(limits.opencode, undefined);
});

test('a monthly window reported as billing is still the monthly window', () => {
  // Token Monitor normalizes the monthly window to the kind `billing`.
  const stats = {
    limits: { providers: [
      { provider: 'opencode', status: 'ok', updatedAt: new Date(NOW).toISOString(), windows: [
        { kind: 'session', remainingPercent: 100, resetsAt: new Date(NOW + 3600_000).toISOString() },
        { kind: 'weekly', remainingPercent: 64, resetsAt: new Date(NOW + 4 * 86400_000).toISOString() },
        { kind: 'billing', remainingPercent: 74, resetsAt: new Date(NOW + 20 * 86400_000).toISOString() }
      ] }
    ] }
  };
  const limits = modelLimits(stats);
  assert.equal(limits['opencode-go'].monthly.remaining, 74);
});

test('a prepaid credit window is not mistaken for the monthly window', () => {
  const stats = {
    limits: { providers: [
      { provider: 'opencode', status: 'ok', updatedAt: new Date(NOW).toISOString(), windows: [
        { kind: 'session', remainingPercent: 100, resetsAt: new Date(NOW + 3600_000).toISOString() },
        { kind: 'billing', metric: 'credits', remainingPercent: 12, resetsAt: new Date(NOW + 20 * 86400_000).toISOString() }
      ] }
    ] }
  };
  const limits = modelLimits(stats);
  assert.equal(limits['opencode-go'].monthly, null);
});

test('modelActivity counts only recently used sessions as live agents', () => {
  const { activity } = modelActivity(statsWithModels(), {}, NOW);
  // minimax: one session 1 min old, one 5 min old -> both live
  assert.equal(activity.minimax.agentCount, 2);
  // kimi: one session 2 min old -> live
  assert.equal(activity.kimi.agentCount, 1);
  // muse-bridge: 90 and 120 min old -> both stale
  assert.equal(activity['muse-bridge'].agentCount, 0);
  // meta: 30 min old -> live
  assert.equal(activity.meta.agentCount, 1);
});

test('modelActivity derives an OUTPUT token rate, not a total-token rate', () => {
  const first = modelActivity(statsWithModels(), {}, NOW - 10_000);
  assert.equal(first.activity.minimax.tokensPerSecond, 0);
  const baseline = first.totals.minimax;
  assert.ok(baseline < 10_000, `baseline should be output-only, got ${baseline}`);

  // second poll: the session's outputTokens grew by 1000 in 10s -> 100 out/s.
  // The cacheRead figure is deliberately huge and must NOT contribute --
  // counting it produced a bogus ~37,500 tokens/sec.
  const grew = statsWithModels();
  grew.periods.month.sessions.a.outputTokens += 1000;
  grew.periods.month.sessions.a.totalTokens += 1000;
  grew.periods.month.sessions.a.cacheReadTokens = 430000;
  const second = modelActivity(grew, { providerTotals: first.totals, sampledAt: NOW - 10_000 }, NOW);
  assert.equal(Math.round(second.activity.minimax.tokensPerSecond), 100);
  // the cached tokens must not show up in the reported total either
  assert.ok(second.activity.minimax.totalTokens < 10_000,
    `totalTokens should be output-only, got ${second.activity.minimax.totalTokens}`);
});

test('modelActivity publishes a distinct output rate for each live agent', () => {
  const first = modelActivity(statsWithModels(), {}, NOW - 10_000);
  const grew = statsWithModels();
  grew.periods.month.sessions.a.outputTokens += 600;
  grew.periods.month.sessions.b.outputTokens += 100;
  const second = modelActivity(grew, {
    providerTotals: first.totals,
    sessionOutputTokens: first.sessionOutputTokens,
    sampledAt: NOW - 10_000
  }, NOW);
  assert.deepEqual(second.activity.minimax.agentRates.map(Math.round), [60, 10]);
});

test('agent counts come from the month period, not today', () => {
  // today only has session 'a' (minimax); the month period has all of
  // them. The count must reflect the month set, or agents vanish at
  // midnight.
  const { activity } = modelActivity(statsWithModels(), {}, NOW);
  assert.equal(activity.kimi.agentCount, 1);
  assert.equal(activity.meta.agentCount, 1);
});

test('a session with growing output counts as live even when lastUsedAt is stale', () => {
  // The hub's lastUsedAt can lag far behind reality: a session that is
  // streaming tokens every second may still show a lastUsedAt from half
  // an hour ago. Output growth between polls is the real signal.
  const stats = {
    periods: {
      month: {
        sessions: {
          s1: {
            sessionId: 's1',
            client: 'openclaw',
            providers: { openai: 100 },
            outputTokens: 5000,
            lastUsedAt: new Date(Date.now() - 3600_000).toISOString()
          }
        }
      }
    }
  };
  const memory = { sessionOutputTokens: { s1: 4000 } };
  const { activity } = modelActivity(stats, memory, Date.now());
  assert.equal(activity.codex.agentCount, 1);
});

test('a session whose output did not move and is stale counts as idle', () => {
  const stats = {
    periods: {
      month: {
        sessions: {
          s1: {
            sessionId: 's1',
            client: 'openclaw',
            providers: { openai: 100 },
            outputTokens: 5000,
            lastUsedAt: new Date(Date.now() - 3600_000).toISOString()
          }
        }
      }
    }
  };
  const memory = { sessionOutputTokens: { s1: 5000 } };
  const { activity } = modelActivity(stats, memory, Date.now());
  assert.equal(activity.codex.agentCount, 0);
});

test('publicState publishes the per-agent token rate', () => {
  const stats = {
    periods: { today: { sessions: {} }, month: { sessions: {} } },
    limits: {
      providers: [
        {
          provider: 'codex',
          status: 'ok',
          windows: [
            { kind: 'session', remainingPercent: 80, resetsAt: '2026-11-10T00:00:00.000Z' },
            { kind: 'weekly', remainingPercent: 40, resetsAt: '2026-11-17T00:00:00.000Z' }
          ]
        }
      ]
    }
  };
  const memory = { sessionOutputTokens: {} };
  const { state } = publicState(stats, memory, Date.now());
  assert.equal(typeof state.models.codex.tokensPerSecondPerAgent, 'number');
  assert.ok(state.models.codex.tokensPerSecondPerAgent >= 0);
});

test('publicState publishes per-model quota, rate and agent count', () => {
  const { state } = publicState(statsWithModels(), {}, NOW);
  assert.equal(state.version, 2);
  assert.equal(state.models.minimax.sessionRemaining, 93);
  assert.equal(state.models.minimax.weeklyRemaining, 16);
  assert.equal(state.models.minimax.monthlyRemaining, 0);
  assert.equal(state.models.minimax.agentCount, 2);
  assert.equal(state.models.codex.agentCount, 2);
  assert.equal(state.models.codex.sessionRemaining, 100);
  assert.equal(state.models.kimi.agentCount, 1);
  // meta has no ok limits row but HAS a live agent -> still listed, with
  // unknown quota (-1) rather than an invented number
  assert.equal(state.models.meta.sessionRemaining, -1);
  assert.equal(state.models.meta.agentCount, 1);
  assert.equal(state.models['muse-bridge'].agentCount, 0);
});

test('a model with neither quota nor activity is omitted entirely', () => {
  // Give meta no activity and no limits row: it must not be published at
  // all, rather than published with empty fields the client would render
  // as a "--" row of clutter.
  const bare = statsWithModels();
  delete bare.periods.month.sessions.f;
  bare.limits.providers = bare.limits.providers.filter((r) => r.provider !== 'meta');
  const { state: out } = publicState(bare, {}, NOW);
  assert.equal(out.models.meta, undefined,
    'a model with no quota, no tokens and no agents must be omitted');
});

test('a model with an EXHAUSTED quota is still published', () => {
  // An exhausted quota is a real, known state: the creature must be able
  // to sleep on the sand rather than vanish, so it counts as measurable.
  const spent = statsWithModels({ minimax: 0 });
  const { state: out } = publicState(spent, {}, NOW);
  assert.equal(out.models.minimax.sessionRemaining, 0);
  assert.equal(out.models.minimax.agentCount, 2);
});

test('the live source overrides the hub agent count, including zero', () => {
  const state = { models: { codex: { agentCount: 0, tokensPerSecond: 99, agentRates: [] } } };
  const live = { counts: { codex: 0 }, rates: {} };
  const { state: out } = applyLiveAgents(state, live, {}, NOW);
  assert.equal(out.models.codex.agentCount, 0);
});

test('a live OpenCode-GO agent is preserved without a quota row', () => {
  const state = { models: {} };
  const live = {
    counts: { 'opencode-go': 1 },
    rates: { 'opencode-go': [{ sessionId: 'session-opencode', outputTokens: 42 }] }
  };
  const { state: out } = applyLiveAgents(state, live, {}, NOW);
  assert.equal(out.models['opencode-go'].agentCount, 1);
  assert.equal(out.models['opencode-go'].sessionRemaining, -1);
  assert.equal(out.models['opencode-go'].weeklyRemaining, -1);
  assert.equal(out.models['opencode-go'].monthlyRemaining, -1);
});

test('a live Muse runtime is preserved without a fresh session row', () => {
  const state = { models: {} };
  const live = { counts: { 'muse-bridge': 1 }, rates: {} };
  const { state: out } = applyLiveAgents(state, live, {}, NOW);
  assert.equal(out.models['muse-bridge'].agentCount, 1);
  assert.equal(out.models['muse-bridge'].sessionRemaining, -1);
});

test('each live agent gets its OWN measured output rate', () => {
  const state = { models: { minimax: { agentCount: 0, tokensPerSecond: 0, agentRates: [] } } };
  const live = {
    counts: { minimax: 2 },
    rates: {
      minimax: [
        { sessionId: 'b', outputTokens: 1000 },
        { sessionId: 'a', outputTokens: 700 }
      ]
    }
  };
  // 10 seconds between polls: 'a' gained 600 tokens -> 60/s, 'b' gained 0.
  const memory = {
    sampledAt: NOW - 10_000,
    liveOutputTokens: { a: 100, b: 1000 }
  };
  const { state: out } = applyLiveAgents(state, live, memory, NOW);
  assert.deepEqual(out.models.minimax.agentRates, [60, 0]);
  assert.equal(out.models.minimax.tokensPerSecond, 60);
});

test('an agent rate is HELD between turns instead of dropping to zero', () => {
  const state = { models: { minimax: { agentCount: 1, tokensPerSecond: 0, agentRates: [] } } };
  const live = {
    counts: { minimax: 1 },
    rates: { minimax: [{ sessionId: 'a', outputTokens: 1000 }] }
  };
  // The session's output total did not move this poll, but its last
  // measured rate is still that agent's own speed.
  const memory = {
    sampledAt: NOW - 10_000,
    liveOutputTokens: { a: 1000 },
    liveAgentRates: { a: 42 }
  };
  const { state: out } = applyLiveAgents(state, live, memory, NOW);
  assert.deepEqual(out.models.minimax.agentRates, [42]);
});
