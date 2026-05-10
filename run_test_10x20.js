#!/usr/bin/env node
// Test batch: 10 sessions x 20 personas, concurrency=3
// Usage: node run_test_10x20.js

import { writeFileSync } from 'fs';

const BASE = 'http://localhost:3210';
const SESSIONS_PER_PERSONA = 10;
const MAX_AUTO_TURNS = 18;
const CONCURRENCY = 3;

const PERSONAS = [
  'andrey', 'alexey', 'cfo_round', 'eng_manager', 'ops_manager',
  'head_finance', 'internal_legal', 'external_legal',
  'cm_winback', 'rate_floor_cfo', 'panic_churn_ops',
  'fx_trust_shock_finance', 'grey_pain_switcher', 'direct_contract_transition',
  'cfo_price_pressure', 'category_confusion_buyer', 'fx_transparency_finance',
  'sanctions_churn_ops',
];

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} => ${res.status}: ${text}`);
  }
  return res.json();
}

async function runSession(personaId, index) {
  let session;
  try {
    session = await post('/api/sessions', { personaId, language: 'ru' });
  } catch (e) {
    process.stderr.write(`  [${personaId}] session ${index+1}: CREATE FAILED: ${e.message}\n`);
    return { booked: false, askCount: 0, verdict: 'error', turns: 0 };
  }
  const id = session.session_id;
  let meetingBooked = false;
  let turns = 0;

  for (let turn = 0; turn < MAX_AUTO_TURNS; turn++) {
    let result;
    try {
      result = await post(`/api/sessions/${id}/auto-message`, {});
      turns++;
    } catch {
      break;
    }
    if (result.session?.status !== 'in_progress') break;
    if (result.session?.meta?.meeting_booked) {
      meetingBooked = true;
      break;
    }
  }

  let finished;
  try {
    finished = await post(`/api/sessions/${id}/finish`, {});
  } catch {
    finished = session;
  }

  const booked = finished?.meta?.meeting_booked || meetingBooked;
  const askCount = finished?.meta?.meeting_ask_count || 0;
  const verdict = finished?.assessment?.verdict || 'n/a';
  process.stdout.write(`  [${personaId}] #${String(index+1).padStart(2,'0')}: booked=${booked} asks=${askCount} verdict=${verdict} turns=${turns}\n`);
  return { booked, askCount, verdict, turns };
}

async function runPersona(personaId) {
  const results = [];
  // Run sessions sequentially per persona to avoid thrashing the server
  for (let i = 0; i < SESSIONS_PER_PERSONA; i++) {
    const r = await runSession(personaId, i);
    results.push(r);
  }
  return results;
}

async function runConcurrent(tasks, concurrency) {
  const results = {};
  const queue = [...tasks];
  const active = new Set();

  await new Promise((resolve) => {
    function next() {
      while (active.size < concurrency && queue.length > 0) {
        const { personaId } = queue.shift();
        const p = runPersona(personaId).then(r => {
          results[personaId] = r;
          active.delete(p);
          if (queue.length === 0 && active.size === 0) resolve();
          else next();
        });
        active.add(p);
      }
    }
    next();
    if (queue.length === 0 && active.size === 0) resolve();
  });
  return results;
}

function summarize(results) {
  console.log('\n\n═══════════════════════════════════════════════');
  console.log('РЕЗУЛЬТАТЫ ТЕСТА: 10 диалогов × ' + PERSONAS.length + ' персон');
  console.log('═══════════════════════════════════════════════\n');

  let totalRuns = 0, totalBooked = 0;
  const rows = [];

  for (const [personaId, sessions] of Object.entries(results)) {
    const booked = sessions.filter(s => s.booked).length;
    const rate = Math.round((booked / sessions.length) * 100);
    const avgTurns = (sessions.reduce((a,s) => a+s.turns, 0) / sessions.length).toFixed(1);
    totalRuns += sessions.length;
    totalBooked += booked;
    rows.push({ personaId, runs: sessions.length, booked, rate, avgTurns });
  }

  rows.sort((a, b) => b.rate - a.rate);

  for (const r of rows) {
    const bar = '█'.repeat(Math.round(r.rate / 10)).padEnd(10, '░');
    console.log(`${r.personaId.padEnd(28)} ${bar} ${String(r.rate).padStart(3)}%  (${r.booked}/${r.runs})  avg turns: ${r.avgTurns}`);
  }

  const overallRate = Math.round((totalBooked / totalRuns) * 100);
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`ИТОГО: ${totalBooked}/${totalRuns} встреч назначено — конверсия ${overallRate}%`);
  console.log('═══════════════════════════════════════════════\n');

  // Machine-readable JSON for report generation
  const outFile = `data/analysis/test_10x20_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.json`;
  writeFileSync(outFile, JSON.stringify({ results, summary: rows, overallRate, totalBooked, totalRuns }, null, 2));
  console.log(`JSON сохранён: ${outFile}`);
}

async function main() {
  console.log(`\nЗапуск теста: ${PERSONAS.length} персон × ${SESSIONS_PER_PERSONA} сессий (параллельность: ${CONCURRENCY})\n`);

  const tasks = PERSONAS.map(personaId => ({ personaId }));
  const results = await runConcurrent(tasks, CONCURRENCY);
  await summarize(results);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
