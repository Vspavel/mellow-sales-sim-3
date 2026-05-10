#!/usr/bin/env node
// Batch runner: 30 sessions x 5 canonical personas
// Usage: node run_batch_30x6.js

const BASE = 'http://localhost:3210';
const PERSONAS = [
  'rate_floor_cfo',
  'panic_churn_ops',
  'fx_trust_shock_finance',
  'cm_winback',
  'grey_pain_switcher',
];
const SESSIONS_PER_PERSONA = 30;
const MAX_AUTO_TURNS = 18;

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

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} => ${res.status}`);
  return res.json();
}

async function runSession(personaId, index) {
  const session = await post('/api/sessions', { personaId, language: 'ru' });
  const id = session.session_id;
  let meetingBooked = false;

  for (let turn = 0; turn < MAX_AUTO_TURNS; turn++) {
    let result;
    try {
      result = await post(`/api/sessions/${id}/auto-message`, {});
    } catch (e) {
      // session may have already finished
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
  process.stdout.write(
    `  [${personaId}] session ${String(index + 1).padStart(2, '0')}/${SESSIONS_PER_PERSONA}: meeting_booked=${booked} ask_count=${askCount} verdict=${verdict}\n`
  );
  return { booked, askCount, verdict };
}

async function main() {
  console.log(`\nStarting 30x6 batch (${PERSONAS.length} personas x ${SESSIONS_PER_PERSONA} sessions)\n`);

  const results = {};
  for (const personaId of PERSONAS) {
    console.log(`\n--- Persona: ${personaId} ---`);
    results[personaId] = { runs: 0, booked: 0, totalAsks: 0, verdicts: {} };
    for (let i = 0; i < SESSIONS_PER_PERSONA; i++) {
      const r = await runSession(personaId, i);
      results[personaId].runs++;
      if (r.booked) results[personaId].booked++;
      results[personaId].totalAsks += r.askCount;
      results[personaId].verdicts[r.verdict] = (results[personaId].verdicts[r.verdict] || 0) + 1;
    }
  }

  console.log('\n\n========== BATCH COMPLETE ==========\n');
  console.log('Fetching /api/analytics for final stats...\n');

  const analytics = await get('/api/analytics');

  // Print per-persona summary from analytics
  const byPersona = analytics.by_persona || [];
  console.log('Per-persona meeting_booked_rate (from analytics):');
  for (const p of byPersona) {
    if (PERSONAS.includes(p.persona_id)) {
      console.log(
        `  ${p.persona_id.padEnd(32)} runs=${p.runs} booked=${p.meeting_booked_count} rate=${(p.meeting_booked_rate * 100).toFixed(1)}% pass_rate=${((p.pass_rate || 0) * 100).toFixed(1)}%`
      );
    }
  }

  console.log('\nGlobal totals:');
  const g = analytics.global || analytics;
  console.log(`  total_sessions:    ${g.total_sessions || g.finished_sessions || '?'}`);
  console.log(`  meeting_booked_rate: ${((g.meeting_booked_rate || 0) * 100).toFixed(1)}%`);
  console.log(`  success_rate:      ${((g.success_rate || 0) * 100).toFixed(1)}%`);

  // Print local run summary (this batch only)
  console.log('\n--- This batch run ---');
  for (const [personaId, r] of Object.entries(results)) {
    const rate = r.runs ? ((r.booked / r.runs) * 100).toFixed(1) : '0.0';
    const avgAsks = r.runs ? (r.totalAsks / r.runs).toFixed(2) : '0.00';
    console.log(
      `  ${personaId.padEnd(32)} booked=${r.booked}/${r.runs} (${rate}%) avg_ask_count=${avgAsks} verdicts=${JSON.stringify(r.verdicts)}`
    );
  }

  // Identify 0% personas and failure pattern
  console.log('\n--- Failure analysis ---');
  let allPassed = true;
  for (const [personaId, r] of Object.entries(results)) {
    if (r.booked === 0) {
      allPassed = false;
      const topVerdict = Object.entries(r.verdicts).sort((a, b) => b[1] - a[1])[0];
      console.log(
        `  ZERO conversion: ${personaId} — top verdict: ${topVerdict ? topVerdict[0] + ' (x' + topVerdict[1] + ')' : 'n/a'} avg_asks=${r.runs ? (r.totalAsks / r.runs).toFixed(2) : '0'}`
      );
    }
  }
  if (allPassed) {
    console.log('  All personas achieved at least one meeting booking.');
  }

  console.log('\nDone.\n');
  return { results, analytics };
}

main().catch((err) => {
  console.error('Batch error:', err.message);
  process.exit(1);
});
