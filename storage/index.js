import fs from 'fs';
import path from 'path';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeArtifactSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    session_id: raw.session_id,
    saved_at: raw.saved_at,
    started_at: raw.started_at,
    finished_at: raw.finished_at,
    seller_username: raw.seller_username,
    persona: raw.persona,
    signal_card: raw.signal_card,
    dialogue_type: raw.dialogue_type,
    verdict: raw.assessment?.verdict || null,
  };
}

function normalizeSdrHintTuning(raw) {
  const safeObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const safeList = (value) => (Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []);
  const normalizeListMap = (value) => Object.fromEntries(
    Object.entries(safeObject(value))
      .map(([key, list]) => [String(key), safeList(list)])
      .filter(([, list]) => list.length > 0)
  );
  const normalizeNestedListMap = (value) => Object.fromEntries(
    Object.entries(safeObject(value)).map(([key, nested]) => [String(key), normalizeListMap(nested)])
      .filter(([, nested]) => Object.keys(nested).length > 0)
  );

  return {
    openers: normalizeListMap(raw?.openers),
    concerns: normalizeNestedListMap(raw?.concerns),
    next_steps: normalizeListMap(raw?.next_steps),
  };
}

function summarizePromptMemoryRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    run_id: raw.runId || null,
    generated_at: raw.generatedAt || null,
    persona_id: raw.personaId || null,
    cycle_count: Number.isFinite(Number(raw.cycleCount)) ? Number(raw.cycleCount) : 0,
    memory_record_count: Number.isFinite(Number(raw.memoryRecordCount)) ? Number(raw.memoryRecordCount) : 0,
  };
}

function summarizeEvaluationRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
  return {
    run_id: raw.run_id || raw.runId || null,
    status: String(raw.status || 'pending'),
    created_at: raw.created_at || raw.createdAt || null,
    updated_at: raw.updated_at || raw.updatedAt || null,
    started_at: raw.started_at || raw.startedAt || null,
    finished_at: raw.finished_at || raw.finishedAt || null,
    total_simulations: Number(progress.total_simulations || 0),
    completed_simulations: Number(progress.completed_simulations || 0),
    failed_simulations: Number(progress.failed_simulations || 0),
    total_personas: Number(progress.total_personas || 0),
    completed_personas: Number(progress.completed_personas || 0),
  };
}

function createFileStorage({ dataDir, sessionsDir, personasFile, doctrinesFile, logsDir, hintMemoryFile, hintRecencyFile, sdrHintTuningFile, artifactsDir, promptMemoryRunsDir, evaluationRunsDir }) {
  return {
    driver: 'file',
    async init() {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(artifactsDir, { recursive: true });
      fs.mkdirSync(promptMemoryRunsDir, { recursive: true });
      fs.mkdirSync(evaluationRunsDir, { recursive: true });
    },
    async loadPersonas({ seedFactory }) {
      const parsed = readJson(personasFile);
      if (parsed && typeof parsed === 'object') return parsed;
      const seeded = seedFactory();
      writeJson(personasFile, seeded);
      return seeded;
    },
    async savePersonas(personas) {
      writeJson(personasFile, personas);
      return personas;
    },
    async loadDoctrineConfig({ seedFactory }) {
      const parsed = readJson(doctrinesFile);
      if (parsed && typeof parsed === 'object') return parsed;
      const seeded = seedFactory();
      writeJson(doctrinesFile, seeded);
      return seeded;
    },
    async saveDoctrineConfig(config) {
      writeJson(doctrinesFile, config);
      return config;
    },
    async loadSession(sessionId) {
      return readJson(path.join(sessionsDir, `${sessionId}.json`));
    },
    async saveSession(session) {
      writeJson(path.join(sessionsDir, `${session.session_id}.json`), session);
      return session;
    },
    async listSessions() {
      if (!fs.existsSync(sessionsDir)) return [];
      return fs.readdirSync(sessionsDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(sessionsDir, name)))
        .filter(Boolean);
    },
    async findActiveSessionByChat(personaId, chatId) {
      const sessions = await this.listSessions();
      return sessions.find((session) => {
        if (!session || session.status !== 'in_progress') return false;
        const sessionPersonaId = session.bot_id || session.persona_id;
        return sessionPersonaId === personaId && String(session.telegram_chat_id) === String(chatId);
      }) || null;
    },
    sessionFilePath(sessionId) {
      return path.join(sessionsDir, `${sessionId}.json`);
    },
    async loadHintMemoryStore() {
      const parsed = readJson(hintMemoryFile, { records: [] });
      if (Array.isArray(parsed)) return parsed;
      return Array.isArray(parsed?.records) ? parsed.records : [];
    },
    async saveHintMemoryStore(payload) {
      writeJson(hintMemoryFile, payload);
      return payload.records || [];
    },
    async loadHintRecency() {
      const parsed = readJson(hintRecencyFile, { openers: [] });
      return Array.isArray(parsed?.openers) ? parsed.openers : [];
    },
    async saveHintRecency(openers) {
      writeJson(hintRecencyFile, { openers });
      return openers;
    },
    async loadSdrHintTuning() {
      return normalizeSdrHintTuning(readJson(sdrHintTuningFile, { openers: {}, concerns: {}, next_steps: {} }));
    },
    async saveSdrHintTuning(payload) {
      const normalized = normalizeSdrHintTuning(payload);
      writeJson(sdrHintTuningFile, normalized);
      return normalized;
    },
    async saveFinishedLog(session) {
      const date = String(session.finished_at || new Date().toISOString()).slice(0, 10);
      const dayDir = path.join(logsDir, date);
      fs.mkdirSync(dayDir, { recursive: true });
      writeJson(path.join(dayDir, `${session.session_id}.json`), session);
      return session;
    },
    async saveArtifact({ artifact, markdown, sessionId }) {
      writeJson(path.join(artifactsDir, `artifact_${sessionId}.json`), artifact);
      fs.mkdirSync(artifactsDir, { recursive: true });
      fs.writeFileSync(path.join(artifactsDir, `artifact_${sessionId}.md`), markdown);
      return artifact;
    },
    async loadArtifact(sessionId) {
      return readJson(path.join(artifactsDir, `artifact_${sessionId}.json`));
    },
    async loadArtifactMarkdown(sessionId) {
      try {
        return fs.readFileSync(path.join(artifactsDir, `artifact_${sessionId}.md`), 'utf8');
      } catch {
        return null;
      }
    },
    async listArtifacts() {
      if (!fs.existsSync(artifactsDir)) return [];
      return fs.readdirSync(artifactsDir)
        .filter((f) => f.startsWith('artifact_') && f.endsWith('.json'))
        .map((f) => readJson(path.join(artifactsDir, f)))
        .map(normalizeArtifactSummary)
        .filter(Boolean)
        .sort((a, b) => String(b.saved_at || b.finished_at || '').localeCompare(String(a.saved_at || a.finished_at || '')));
    },
    async listArtifactIds(limit = null) {
      const artifacts = await this.listArtifacts();
      return artifacts.slice(0, limit || undefined).map((item) => item.session_id).filter(Boolean);
    },
    async savePromptMemoryRun({ run, markdown, runId }) {
      writeJson(path.join(promptMemoryRunsDir, `${runId}.json`), run);
      fs.mkdirSync(promptMemoryRunsDir, { recursive: true });
      fs.writeFileSync(path.join(promptMemoryRunsDir, `${runId}.md`), markdown);
      return run;
    },
    async loadPromptMemoryRun(runId) {
      return readJson(path.join(promptMemoryRunsDir, `${runId}.json`));
    },
    async loadPromptMemoryRunMarkdown(runId) {
      try {
        return fs.readFileSync(path.join(promptMemoryRunsDir, `${runId}.md`), 'utf8');
      } catch {
        return null;
      }
    },
    async listPromptMemoryRuns(limit = null) {
      if (!fs.existsSync(promptMemoryRunsDir)) return [];
      const items = fs.readdirSync(promptMemoryRunsDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(promptMemoryRunsDir, name)))
        .map(summarizePromptMemoryRun)
        .filter(Boolean)
        .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')));
      return items.slice(0, limit || undefined);
    },

    async saveEvaluationRun(run) {
      writeJson(path.join(evaluationRunsDir, `${run.run_id}.json`), run);
      return run;
    },

    async loadEvaluationRun(runId) {
      return readJson(path.join(evaluationRunsDir, `${runId}.json`));
    },

    async listEvaluationRuns(limit = null) {
      if (!fs.existsSync(evaluationRunsDir)) return [];
      const items = fs.readdirSync(evaluationRunsDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(evaluationRunsDir, name)))
        .map(summarizeEvaluationRun)
        .filter(Boolean)
        .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
      return items.slice(0, limit || undefined);
    },
  };
}

async function createPostgresStorage(config) {
  const { query } = await import('../db/client.js');
  const fileFallback = createFileStorage(config);

  async function initSchema() {
    await query(`
      CREATE TABLE IF NOT EXISTS personas (
        id text PRIMARY KEY,
        name text NOT NULL,
        role text NOT NULL DEFAULT '',
        archetype text NOT NULL DEFAULT '',
        tone text NOT NULL DEFAULT '',
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS sales_sessions (
        session_id text PRIMARY KEY,
        persona_id text NOT NULL,
        status text NOT NULL,
        started_at timestamptz,
        finished_at timestamptz,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT sales_sessions_persona_fk
          FOREIGN KEY (persona_id) REFERENCES personas (id) ON DELETE RESTRICT
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_sales_sessions_persona_id ON sales_sessions (persona_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sales_sessions_status ON sales_sessions (status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sales_sessions_finished_at ON sales_sessions (finished_at DESC)`);
    await query(`
      CREATE TABLE IF NOT EXISTS storage_kv (
        key text PRIMARY KEY,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS session_artifacts (
        session_id text PRIMARY KEY,
        payload jsonb NOT NULL,
        markdown text NOT NULL DEFAULT '',
        saved_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_session_artifacts_saved_at ON session_artifacts (saved_at DESC)`);
    await query(`
      CREATE TABLE IF NOT EXISTS session_logs (
        session_id text PRIMARY KEY,
        finished_date date,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_session_logs_finished_date ON session_logs (finished_date DESC)`);
    await query(`
      CREATE TABLE IF NOT EXISTS prompt_memory_runs (
        run_id text PRIMARY KEY,
        persona_id text,
        generated_at timestamptz,
        cycle_count integer NOT NULL DEFAULT 0,
        memory_record_count integer NOT NULL DEFAULT 0,
        payload jsonb NOT NULL,
        markdown text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_prompt_memory_runs_generated_at ON prompt_memory_runs (generated_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_prompt_memory_runs_persona_id ON prompt_memory_runs (persona_id)`);
  }

  async function getKv(key, fallback) {
    const result = await query('SELECT payload FROM storage_kv WHERE key = $1', [key]);
    if (result.rows[0]?.payload !== undefined) return result.rows[0].payload;
    return fallback;
  }

  async function putKv(key, payload) {
    await query(
      `INSERT INTO storage_kv (key, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET
         payload = EXCLUDED.payload,
         updated_at = now()`,
      [key, JSON.stringify(payload)]
    );
    return payload;
  }

  async function hydrateKvFromFile(key, loader, isEmpty) {
    const current = await getKv(key, null);
    if (current && !isEmpty(current)) return current;
    const fileValue = await loader();
    if (fileValue && !isEmpty(fileValue)) {
      await putKv(key, fileValue);
      return fileValue;
    }
    return current;
  }

  return {
    driver: 'postgres',

    async init() {
      await initSchema();
    },

    async loadPersonas({ seedFactory }) {
      const result = await query('SELECT payload FROM personas ORDER BY created_at');
      if (result.rows.length === 0) {
        return seedFactory();
      }
      const entries = result.rows.map(({ payload }) => [payload.id, payload]);
      return Object.fromEntries(entries);
    },

    async savePersonas(personas) {
      const entries = Object.values(personas);
      for (const p of entries) {
        await query(
          `INSERT INTO personas (id, name, role, archetype, tone, payload, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             archetype = EXCLUDED.archetype,
             tone = EXCLUDED.tone,
             payload = EXCLUDED.payload,
             updated_at = now()`,
          [p.id, p.name || '', p.role || '', p.archetype || '', p.tone || '', JSON.stringify(p)]
        );
      }
      return personas;
    },

    async loadDoctrineConfig({ seedFactory }) {
      const isEmpty = (value) => !value || typeof value !== 'object' || Object.keys(value).length === 0;
      const current = await getKv('doctrine_config', null);
      if (!isEmpty(current)) return current;
      const seeded = seedFactory();
      await putKv('doctrine_config', seeded);
      return seeded;
    },

    async saveDoctrineConfig(config) {
      await putKv('doctrine_config', config);
      return config;
    },

    async loadSession(sessionId) {
      const result = await query('SELECT payload FROM sales_sessions WHERE session_id = $1', [sessionId]);
      return result.rows[0]?.payload ?? null;
    },

    async saveSession(session) {
      await query(
        `INSERT INTO sales_sessions (session_id, persona_id, status, started_at, finished_at, payload, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
         ON CONFLICT (session_id) DO UPDATE SET
           persona_id = EXCLUDED.persona_id,
           status = EXCLUDED.status,
           started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at,
           payload = EXCLUDED.payload,
           updated_at = now()`,
        [
          session.session_id,
          session.bot_id || session.persona_id || 'unknown',
          session.status || 'in_progress',
          session.started_at || null,
          session.finished_at || null,
          JSON.stringify(session),
        ]
      );
      return session;
    },

    async listSessions() {
      const result = await query('SELECT payload FROM sales_sessions ORDER BY created_at DESC');
      return result.rows.map(({ payload }) => payload);
    },

    async findActiveSessionByChat(personaId, chatId) {
      const result = await query(
        `SELECT payload
           FROM sales_sessions
          WHERE status = 'in_progress'
            AND persona_id = $1
            AND COALESCE(payload->>'telegram_chat_id', '') = $2
          ORDER BY updated_at DESC
          LIMIT 1`,
        [personaId, String(chatId)]
      );
      return result.rows[0]?.payload ?? null;
    },

    sessionFilePath() {
      return null;
    },

    async loadHintMemoryStore() {
      const payload = await hydrateKvFromFile(
        'hint_memory',
        () => fileFallback.loadHintMemoryStore().then((records) => ({ version: 'v2', records })),
        (value) => !Array.isArray(value?.records) || value.records.length === 0
      );
      return Array.isArray(payload?.records) ? payload.records : [];
    },

    async saveHintMemoryStore(payload) {
      await putKv('hint_memory', payload);
      return payload.records || [];
    },

    async loadHintRecency() {
      const payload = await hydrateKvFromFile(
        'hint_recency',
        () => fileFallback.loadHintRecency().then((openers) => ({ openers })),
        (value) => !Array.isArray(value?.openers) || value.openers.length === 0
      );
      return Array.isArray(payload?.openers) ? payload.openers : [];
    },

    async saveHintRecency(openers) {
      await putKv('hint_recency', { openers });
      return openers;
    },

    async loadSdrHintTuning() {
      const payload = await hydrateKvFromFile(
        'sdr_hint_tuning',
        () => fileFallback.loadSdrHintTuning(),
        (value) => {
          const normalized = normalizeSdrHintTuning(value);
          return Object.keys(normalized.openers).length === 0
            && Object.keys(normalized.concerns).length === 0
            && Object.keys(normalized.next_steps).length === 0;
        }
      );
      return normalizeSdrHintTuning(payload);
    },

    async saveSdrHintTuning(payload) {
      const normalized = normalizeSdrHintTuning(payload);
      await putKv('sdr_hint_tuning', normalized);
      return normalized;
    },

    async saveFinishedLog(session) {
      await query(
        `INSERT INTO session_logs (session_id, finished_date, payload, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (session_id) DO UPDATE SET
           finished_date = EXCLUDED.finished_date,
           payload = EXCLUDED.payload,
           updated_at = now()`,
        [session.session_id, String(session.finished_at || new Date().toISOString()).slice(0, 10), JSON.stringify(session)]
      );
      return session;
    },

    async saveArtifact({ artifact, markdown, sessionId }) {
      await query(
        `INSERT INTO session_artifacts (session_id, payload, markdown, saved_at, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, now())
         ON CONFLICT (session_id) DO UPDATE SET
           payload = EXCLUDED.payload,
           markdown = EXCLUDED.markdown,
           saved_at = EXCLUDED.saved_at,
           updated_at = now()`,
        [sessionId, JSON.stringify(artifact), markdown, artifact.saved_at || new Date().toISOString()]
      );
      return artifact;
    },

    async loadArtifact(sessionId) {
      const result = await query('SELECT payload FROM session_artifacts WHERE session_id = $1', [sessionId]);
      if (result.rows[0]?.payload) return result.rows[0].payload;
      const fallback = await fileFallback.loadArtifact(sessionId);
      if (fallback) await this.saveArtifact({ artifact: fallback, markdown: await fileFallback.loadArtifactMarkdown(sessionId) || '', sessionId });
      return fallback;
    },

    async loadArtifactMarkdown(sessionId) {
      const result = await query('SELECT markdown FROM session_artifacts WHERE session_id = $1', [sessionId]);
      if (typeof result.rows[0]?.markdown === 'string' && result.rows[0].markdown.length > 0) return result.rows[0].markdown;
      return fileFallback.loadArtifactMarkdown(sessionId);
    },

    async listArtifacts() {
      const result = await query('SELECT payload FROM session_artifacts ORDER BY saved_at DESC');
      if (result.rows.length === 0) return fileFallback.listArtifacts();
      return result.rows.map(({ payload }) => normalizeArtifactSummary(payload)).filter(Boolean);
    },

    async listArtifactIds(limit = null) {
      const sql = limit
        ? 'SELECT session_id FROM session_artifacts ORDER BY saved_at DESC LIMIT $1'
        : 'SELECT session_id FROM session_artifacts ORDER BY saved_at DESC';
      const result = await query(sql, limit ? [limit] : []);
      if (result.rows.length === 0) return fileFallback.listArtifactIds(limit);
      return result.rows.map((row) => row.session_id).filter(Boolean);
    },

    async savePromptMemoryRun({ run, markdown, runId }) {
      const summary = summarizePromptMemoryRun(run);
      await query(
        `INSERT INTO prompt_memory_runs (run_id, persona_id, generated_at, cycle_count, memory_record_count, payload, markdown, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
         ON CONFLICT (run_id) DO UPDATE SET
           persona_id = EXCLUDED.persona_id,
           generated_at = EXCLUDED.generated_at,
           cycle_count = EXCLUDED.cycle_count,
           memory_record_count = EXCLUDED.memory_record_count,
           payload = EXCLUDED.payload,
           markdown = EXCLUDED.markdown,
           updated_at = now()`,
        [
          runId,
          summary?.persona_id || null,
          summary?.generated_at || new Date().toISOString(),
          summary?.cycle_count || 0,
          summary?.memory_record_count || 0,
          JSON.stringify(run),
          markdown || '',
        ]
      );
      return run;
    },

    async loadPromptMemoryRun(runId) {
      const result = await query('SELECT payload FROM prompt_memory_runs WHERE run_id = $1', [runId]);
      if (result.rows[0]?.payload) return result.rows[0].payload;
      const fallback = await fileFallback.loadPromptMemoryRun(runId);
      if (fallback) await this.savePromptMemoryRun({ run: fallback, markdown: await fileFallback.loadPromptMemoryRunMarkdown(runId) || '', runId });
      return fallback;
    },

    async loadPromptMemoryRunMarkdown(runId) {
      const result = await query('SELECT markdown FROM prompt_memory_runs WHERE run_id = $1', [runId]);
      if (typeof result.rows[0]?.markdown === 'string' && result.rows[0].markdown.length > 0) return result.rows[0].markdown;
      return fileFallback.loadPromptMemoryRunMarkdown(runId);
    },

    async listPromptMemoryRuns(limit = null) {
      const sql = limit
        ? 'SELECT payload FROM prompt_memory_runs ORDER BY generated_at DESC NULLS LAST, created_at DESC LIMIT $1'
        : 'SELECT payload FROM prompt_memory_runs ORDER BY generated_at DESC NULLS LAST, created_at DESC';
      const result = await query(sql, limit ? [limit] : []);
      if (result.rows.length === 0) return fileFallback.listPromptMemoryRuns(limit);
      return result.rows.map(({ payload }) => summarizePromptMemoryRun(payload)).filter(Boolean);
    },

    async saveEvaluationRun(run) {
      const current = await getKv('evaluation_runs', { runs: {} });
      const runs = current && typeof current === 'object' && current.runs && typeof current.runs === 'object'
        ? current.runs
        : {};
      runs[run.run_id] = clone(run);
      await putKv('evaluation_runs', { runs });
      return run;
    },

    async loadEvaluationRun(runId) {
      const current = await getKv('evaluation_runs', { runs: {} });
      const run = current?.runs?.[runId] ?? null;
      if (run) return run;
      const fallback = await fileFallback.loadEvaluationRun(runId);
      if (fallback) await this.saveEvaluationRun(fallback);
      return fallback;
    },

    async listEvaluationRuns(limit = null) {
      const current = await getKv('evaluation_runs', { runs: {} });
      const runs = current && typeof current === 'object' && current.runs && typeof current.runs === 'object'
        ? Object.values(current.runs)
        : [];
      if (runs.length === 0) return fileFallback.listEvaluationRuns(limit);
      const items = runs
        .map((payload) => summarizeEvaluationRun(payload))
        .filter(Boolean)
        .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
      return items.slice(0, limit || undefined);
    },
  };
}

export async function createStorage(config) {
  const driver = String(process.env.STORAGE_DRIVER || 'file').trim().toLowerCase();
  const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (isProduction && driver !== 'postgres') {
    throw new Error(`production deploys must run with STORAGE_DRIVER=postgres (got '${driver}'); refusing to start`);
  }
  if (driver === 'postgres') {
    if (!process.env.DATABASE_URL) {
      throw new Error('STORAGE_DRIVER=postgres requires DATABASE_URL');
    }
    return createPostgresStorage(config);
  }
  return createFileStorage(config);
}
