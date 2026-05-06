/**
 * Batch Runner — 50 simulations (10 per persona × 5 personas), sequential.
 * Per-turn human-likeness scoring via Claude Haiku 4.5.
 * Auto-stop on meeting_booked or 20 turns.
 */

import crypto from 'crypto';
import { generateSellerMessage } from './seller_agent.js';
import { MELLOW_PERSONAS_KNOWLEDGE } from './seller_context.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const BUYER_MODEL = 'claude-sonnet-4-6';
const MAX_TURNS = 20;
export const SIMS_PER_PERSONA = 10;

export const BATCH_PERSONAS = [
  { id: 'andrey',      name: 'Andrey',  archetype: 'finance', language: 'ru' },
  { id: 'cfo_round',   name: 'Sofia',   archetype: 'finance', language: 'ru' },
  { id: 'alexey',      name: 'Alexey',  archetype: 'ops',     language: 'ru' },
  { id: 'eng_manager', name: 'Mark',    archetype: 'ops',     language: 'ru' },
  { id: 'ops_manager', name: 'Irina',   archetype: 'ops',     language: 'ru' },
];

export function randomBatchId() {
  return `batch_${crypto.randomBytes(6).toString('hex')}`;
}

function getBuyerSystemPrompt(persona) {
  return `You are ${persona.name}, a potential buyer in a cold outreach sales simulation.

${MELLOW_PERSONAS_KNOWLEDGE}

Play EXACTLY the persona "${persona.id}" described above — their role, pain, communication style, and unlock triggers.
Respond in Russian. Keep replies short (1-5 sentences) like a real busy professional.
Be realistic: be skeptical, ask questions, raise objections appropriate to your role.
Don't be artificially cooperative — make the seller earn it.

When you decide to accept a concrete next step (meeting/call/review):
- Include "договорились" or "давайте созвонимся" or "хорошо, давайте" in your reply.
- Only accept if the seller actually addressed your specific pain.

If the seller is too generic, uses marketing slogans, or doesn't understand your problem — stay cold or disengage.`;
}

function detectMeetingBooked(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /договорились|давайте\s+созвонимся|созвонимся|хорошо,?\s*давайте|окей,?\s*давайте|ладно,?\s*давайте/.test(t) ||
    /let'?s\s+(do\s+it|talk|connect|meet|schedule|chat)|sounds\s+good|works\s+for\s+me|i'?m\s+in|happy\s+to\s+(connect|meet)/.test(t)
  );
}

function assessConversation(personaId, messages) {
  const sellerMsgs = messages.filter((m) => m.role === 'seller').map((m) => m.text);
  const sellerText = sellerMsgs.join('\n').toLowerCase();
  const firstMsg = (sellerMsgs[0] || '').toLowerCase();

  const k1 = /сигнал|карточ|сайт|linkedin|подрядчик|контракт|signal|card|linkedin|contractor/.test(firstMsg);
  const k2 = /документ|kyc|audit|trail|sla|налог|ответствен|границ|document|responsible|boundary/.test(sellerText);
  const k3 = /риск|документ|быстр|ручн|процесс|эскалац|risk|manual|ops|process|fast/.test(sellerText);
  const k4 = (
    /sla|поддерж|эскалац|support|escalat/.test(sellerText) ||
    /стоим|эконом|экономи|cost|econom|saving/.test(sellerText)
  );
  const k5 = /созвон|звон|15\s*минут|20\s*минут|follow-up|review|материал|call|meeting|15.minute|20.minute/.test(sellerText);
  const k6 = !/misclassification/.test(sellerText) || !/guarantee/.test(sellerText);

  const criteria = [
    { id: 'K1', name: 'Contextual opening',    status: k1 ? 'PASS' : 'FAIL' },
    { id: 'K2', name: 'Compliance boundary',   status: k2 ? 'PASS' : 'FAIL' },
    { id: 'K3', name: 'Language fit',          status: k3 ? 'PASS' : 'FAIL' },
    { id: 'K4', name: 'Objection handling',    status: k4 ? 'PASS' : 'FAIL' },
    { id: 'K5', name: 'Clear next step',       status: k5 ? 'PASS' : 'FAIL' },
    { id: 'K6', name: 'No overclaiming',       status: k6 ? 'PASS' : 'FAIL' },
  ];

  const passCount = criteria.filter((c) => c.status === 'PASS').length;
  const verdict = passCount >= 5 ? 'PASS' : passCount >= 4 ? 'PASS_WITH_NOTES' : 'FAIL';

  return { criteria, verdict, pass_count: passCount };
}

async function scoreHumanLikeness(sellerText, anthropic) {
  try {
    const resp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 5,
      system: 'Score how natural and human this sales message sounds. 1=obviously robotic/AI, 5=completely natural human salesperson. Reply with just the digit.',
      messages: [{ role: 'user', content: sellerText }],
    });
    const raw = resp.content.find((b) => b.type === 'text')?.text?.trim() || '3';
    const score = parseInt(raw, 10);
    return Number.isNaN(score) ? 3 : Math.min(5, Math.max(1, score));
  } catch {
    return 3;
  }
}

export async function runOneSim(persona, ordinal, batchRunId, anthropic, db) {
  const simId = `bsim_${crypto.randomBytes(5).toString('hex')}`;
  const messages = [];
  const humanLikenessScores = [];
  let meetingBooked = false;
  let turns = 0;

  for (let turn = 0; turn < MAX_TURNS && !meetingBooked; turn++) {
    // Seller turn
    const sellerText = await generateSellerMessage(messages, anthropic);
    if (!sellerText) break;

    const hlScore = await scoreHumanLikeness(sellerText, anthropic);
    humanLikenessScores.push(hlScore);
    messages.push({ role: 'seller', text: sellerText, human_likeness: hlScore, turn });

    // Buyer turn
    const buyerHistory = messages.map((m) => ({
      role: m.role === 'seller' ? 'user' : 'assistant',
      content: m.text,
    }));

    let buyerText = '';
    try {
      const buyerResp = await anthropic.messages.create({
        model: BUYER_MODEL,
        max_tokens: 200,
        system: getBuyerSystemPrompt(persona),
        messages: buyerHistory,
      });
      buyerText = buyerResp.content.find((b) => b.type === 'text')?.text?.trim() || '';
    } catch {
      break;
    }

    if (!buyerText) break;
    messages.push({ role: 'buyer', text: buyerText, turn });
    turns = turn + 1;

    if (detectMeetingBooked(buyerText)) {
      meetingBooked = true;
    }
  }

  const assessment = assessConversation(persona.id, messages);
  const hlAvg = humanLikenessScores.length
    ? parseFloat((humanLikenessScores.reduce((a, b) => a + b, 0) / humanLikenessScores.length).toFixed(2))
    : 0;

  const result = {
    id: simId,
    batch_run_id: batchRunId,
    persona_id: persona.id,
    ordinal,
    status: 'completed',
    messages,
    assessment,
    human_likeness_scores: humanLikenessScores,
    human_likeness_avg: hlAvg,
    meeting_booked: meetingBooked,
    turns,
  };

  if (db) {
    try {
      await db.query(
        `INSERT INTO batch_sessions
           (id, batch_run_id, persona_id, ordinal, status, messages, assessment,
            human_likeness_scores, human_likeness_avg, meeting_booked, turns, finished_at)
         VALUES ($1,$2,$3,$4,'completed',$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,NOW())
         ON CONFLICT (id) DO UPDATE SET
           status='completed', messages=$5::jsonb, assessment=$6::jsonb,
           human_likeness_scores=$7::jsonb, human_likeness_avg=$8,
           meeting_booked=$9, turns=$10, finished_at=NOW()`,
        [
          simId, batchRunId, persona.id, ordinal,
          JSON.stringify(messages), JSON.stringify(assessment),
          JSON.stringify(humanLikenessScores), hlAvg, meetingBooked, turns,
        ]
      );
    } catch (dbErr) {
      console.error('[batch_runner] db write error:', dbErr.message);
    }
  }

  return result;
}

export async function runBatch(batchRunId, anthropic, db, onProgress) {
  const total = BATCH_PERSONAS.length * SIMS_PER_PERSONA;
  const allResults = [];
  let completed = 0;

  for (const persona of BATCH_PERSONAS) {
    for (let i = 0; i < SIMS_PER_PERSONA; i++) {
      let result;
      try {
        result = await runOneSim(persona, i + 1, batchRunId, anthropic, db);
      } catch (err) {
        console.error(`[batch_runner] sim error persona=${persona.id} ordinal=${i + 1}:`, err.message);
        result = {
          id: null,
          batch_run_id: batchRunId,
          persona_id: persona.id,
          ordinal: i + 1,
          status: 'error',
          error: err.message,
          meeting_booked: false,
          turns: 0,
          human_likeness_avg: 0,
          assessment: { verdict: 'FAIL', pass_count: 0, criteria: [] },
          messages: [],
          human_likeness_scores: [],
        };
      }
      allResults.push(result);
      completed++;

      if (db) {
        const byPersona = {};
        for (const r of allResults) {
          if (!byPersona[r.persona_id]) byPersona[r.persona_id] = { total: 0, booked: 0 };
          byPersona[r.persona_id].total++;
          if (r.meeting_booked) byPersona[r.persona_id].booked++;
        }
        try {
          await db.query(
            `UPDATE batch_runs SET progress=$1::jsonb, updated_at=NOW() WHERE id=$2`,
            [JSON.stringify({ total, completed, by_persona: byPersona }), batchRunId]
          );
        } catch { /* non-fatal */ }
      }

      if (onProgress) onProgress(completed, total, persona.id);
    }
  }

  return allResults;
}
