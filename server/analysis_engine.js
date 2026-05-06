/**
 * Analysis Engine — post-batch Opus 4.7 analysis.
 * Takes 50 session results, returns ≤10 concrete improvement actions.
 */

import crypto from 'crypto';

const ANALYSIS_MODEL = 'claude-opus-4-7';

function buildAnalysisPrompt(sessions) {
  const byPersona = {};
  for (const s of sessions) {
    if (!byPersona[s.persona_id]) byPersona[s.persona_id] = [];
    byPersona[s.persona_id].push(s);
  }

  const lines = [];
  lines.push('# Batch Simulation Results — 50 conversations\n');

  for (const [personaId, sims] of Object.entries(byPersona)) {
    const booked = sims.filter((s) => s.meeting_booked).length;
    const hlScores = sims.filter((s) => typeof s.human_likeness_avg === 'number' && s.human_likeness_avg > 0);
    const avgHL = hlScores.length
      ? (hlScores.reduce((a, b) => a + b.human_likeness_avg, 0) / hlScores.length).toFixed(2)
      : 'N/A';
    const passSims = sims.filter((s) => s.assessment?.verdict === 'PASS').length;

    lines.push(`## Persona: ${personaId} (${sims.length} simulations)`);
    lines.push(`- meeting_booked: ${booked}/${sims.length} (${Math.round((booked / sims.length) * 100)}%)`);
    lines.push(`- assessment PASS: ${passSims}/${sims.length}`);
    lines.push(`- avg human-likeness: ${avgHL}/5`);

    // Criteria breakdown
    const criteriaStats = {};
    for (const s of sims) {
      for (const c of (s.assessment?.criteria || [])) {
        if (!criteriaStats[c.id]) criteriaStats[c.id] = { pass: 0, fail: 0 };
        if (c.status === 'PASS') criteriaStats[c.id].pass++;
        else criteriaStats[c.id].fail++;
      }
    }
    const criteriaLines = Object.entries(criteriaStats).map(([id, stat]) =>
      `  ${id}: PASS ${stat.pass}/${stat.pass + stat.fail}`
    );
    if (criteriaLines.length) lines.push('- criteria breakdown:\n' + criteriaLines.join('\n'));

    // Two example conversations: best booked + worst fail
    const bookedSims = sims.filter((s) => s.meeting_booked && (s.messages || []).length >= 4);
    const failSims = sims.filter((s) => !s.meeting_booked && s.assessment?.verdict === 'FAIL' && (s.messages || []).length >= 2);
    const examples = [
      bookedSims[0] && ['BOOKED example', bookedSims[0]],
      failSims[0] && ['NOT BOOKED example', failSims[0]],
    ].filter(Boolean);

    for (const [label, sim] of examples) {
      lines.push(`\n**${label}** (HL avg: ${sim.human_likeness_avg?.toFixed(1) || 'N/A'}, turns: ${sim.turns}, verdict: ${sim.assessment?.verdict || '?'})`);
      for (const m of (sim.messages || []).slice(0, 10)) {
        const hlTag = m.human_likeness != null ? ` [HL:${m.human_likeness}]` : '';
        lines.push(`[${m.role === 'seller' ? 'Seller' : personaId}${hlTag}] ${m.text}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function runAnalysis(batchRunId, sessions, anthropic, db) {
  const analysisId = `analysis_${crypto.randomBytes(6).toString('hex')}`;

  if (db) {
    try {
      await db.query(
        'INSERT INTO analysis_reports (id, batch_run_id, status) VALUES ($1, $2, $3)',
        [analysisId, batchRunId, 'running']
      );
    } catch (e) {
      console.error('[analysis_engine] db insert error:', e.message);
    }
  }

  const prompt = buildAnalysisPrompt(sessions);

  try {
    const response = await anthropic.messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 2000,
      system: `You are analyzing automated sales simulation data to find concrete improvement opportunities.
You have results from 50 conversations between a Claude-powered Mellow seller and buyer personas.

Your analysis must be specific and evidence-based — NOT generic sales advice.
Focus on:
1. Which specific seller phrases/approaches correlate with meeting_booked=true
2. Where sellers lose the buyer (common failure points by persona)
3. Human-likeness patterns — what makes the seller sound robotic vs human
4. K1-K6 criteria failures — which criteria are systematically weak

Return ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "actions": [
    {
      "priority": <1-10, 1=most important>,
      "area": "<opening|objections|language|next_step|human_likeness|product_knowledge>",
      "finding": "<what the data shows>",
      "action": "<specific change to make — to prompt, training, or approach>",
      "evidence": "<exact quote or data point from the simulations>"
    }
  ],
  "patterns": [
    {
      "pattern": "<observed pattern>",
      "personas_affected": ["<persona_id>"],
      "frequency": "<X of Y sims>"
    }
  ]
}
Max 10 actions, max 5 patterns. Order actions by priority.`,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = response.content.find((b) => b.type === 'text')?.text || '{}';
    let parsed = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {
        actions: [{
          priority: 1,
          area: 'system',
          finding: 'Could not parse Opus output as JSON',
          action: 'Review raw analysis output manually',
          evidence: rawText.slice(0, 300),
        }],
        patterns: [],
      };
    }

    const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 10) : [];
    const patterns = Array.isArray(parsed.patterns) ? parsed.patterns.slice(0, 5) : [];

    if (db) {
      try {
        await db.query(
          `UPDATE analysis_reports
           SET status='completed', actions=$1::jsonb, patterns=$2::jsonb, raw=$3::jsonb, finished_at=NOW()
           WHERE id=$4`,
          [JSON.stringify(actions), JSON.stringify(patterns), JSON.stringify(parsed), analysisId]
        );
      } catch (e) {
        console.error('[analysis_engine] db update error:', e.message);
      }
    }

    return { id: analysisId, batch_run_id: batchRunId, actions, patterns, raw: parsed, status: 'completed' };
  } catch (err) {
    if (db) {
      try {
        await db.query(
          `UPDATE analysis_reports SET status='failed', error=$1, finished_at=NOW() WHERE id=$2`,
          [err.message, analysisId]
        );
      } catch { /* non-fatal */ }
    }
    throw err;
  }
}
