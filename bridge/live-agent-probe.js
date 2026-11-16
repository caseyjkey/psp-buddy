'use strict';

// Read-only probe run on the OpenClaw host by the aquarium bridge. It emits
// only provider counts and output totals; no prompts, messages, or credentials
// leave the host.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ACTIVE_MS = 30 * 60_000;
const root = process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), '.openclaw', 'agents');
const providers = new Set(['codex', 'minimax', 'kimi', 'muse-bridge', 'meta', 'opencode-go']);

function tankProvider(provider) {
  if (provider === 'openai') return 'codex';
  if (provider === 'opencode') return 'opencode-go';
  return providers.has(provider) ? provider : null;
}

function files() {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, 'agent', 'openclaw-agent.sqlite'))
      .filter((file) => fs.existsSync(file));
  } catch {
    return [];
  }
}

const now = Date.now();
const cutoff = now - ACTIVE_MS;
const counts = {};
const rates = {};
for (const file of files()) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(`
      SELECT sw.model_provider AS provider, sw.session_id AS sessionId,
             sn.entry_json AS entryJson
        FROM session_windows sw
        JOIN session_nodes sn ON sn.session_key = sw.session_key
       WHERE sw.session_id = sn.current_session_id
         AND sw.model_provider IS NOT NULL
         AND (sw.updated_at >= ? OR sn.updated_at >= ?)
         AND COALESCE(sn.status, sw.status, '') NOT IN ('failed', 'killed', 'timeout')
    `).all(cutoff, cutoff);
    for (const row of rows) {
      const provider = tankProvider(row.provider);
      if (!provider) continue;
      counts[provider] = (counts[provider] || 0) + 1;
      let entry;
      try { entry = JSON.parse(row.entryJson); } catch { entry = {}; }
      (rates[provider] || (rates[provider] = [])).push({
        sessionId: String(row.sessionId),
        outputTokens: Number(entry.outputTokens) || 0
      });
    }
  } catch {
    // One unavailable agent DB must not hide the other agent DBs.
  } finally {
    db?.close();
  }
}

process.stdout.write(JSON.stringify({ counts, rates }));
