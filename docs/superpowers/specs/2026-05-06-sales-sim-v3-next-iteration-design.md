# Sales Sim v3.0 — Next Iteration Design Spec

**Date:** 2026-05-06
**Status:** approved for implementation
**Owner:** Erast (CEO)
**Project:** mellow-sales-sim-3

---

## Goal

Run 50 automated sales simulations (10 × 5 main personas) with Claude on both sides —
seller and buyer. Measure conversion to meeting booked. Evaluate human-likeness of both
seller messages and buyer responses. After all 50 runs, produce a concise analysis report
with ranked improvement recommendations. Simultaneously redesign the UI to Mellow minimalism
standards.

---

## Scope

### In scope
1. Automated batch runner — 50 simulations, both sides Claude-powered
2. Seller agent with Mellow product knowledge + real calculator tool
3. Human-likeness evaluation — per-message and per-conversation
4. Analysis report — conversion patterns + ranked improvement list
5. UI redesign — minimalist, 3 principles applied to existing screens

### Out of scope
- Live HubSpot / Confluence API integration during conversations (static context instead)
- Multi-user batch scheduling
- A/B testing of seller prompts in this iteration

---

## Architecture

### 1. Seller Agent

**Knowledge source (static, compiled):**
A `seller_context.js` module that exports a compiled `SELLER_SYSTEM_PROMPT` string.
Content: Mellow product taxonomy (Scout / CoR / CM / Radar / MoR), each product's
value proposition, typical objections and responses, pricing model overview, and 5–7
anonymized patterns from past successful deals. Compiled manually from mellow.io,
Confluence, and HubSpot; recompilable without code changes via a separate build step.

**Persona:** "You are an experienced Mellow Account Executive. You have 2 years at Mellow.
You know the product deeply. You sound like a real person — not a script-reader. You adapt
to the buyer's energy. You are direct but not pushy. When pricing comes up, you use the
calculator."

**Calculator tool:**
- Tool name: `calculate_mellow_savings`
- Parameters: `{ product: string, monthly_contractors: number, avg_monthly_cost_usd: number }`
- Implementation: HTTP GET to `https://lab.mellow.io/calculator` with query params
- Response: parsed savings estimate, returned as tool result to seller agent
- If calculator unreachable: seller proceeds without numbers, notes uncertainty

**Seller turn logic:**
```
generateSellerTurn(transcript, buyerState, sessionContext) →
  Claude claude-sonnet-4-6 call
  system: SELLER_SYSTEM_PROMPT
  messages: last 10 turns of transcript (context window management)
  tools: [calculate_mellow_savings]
  max_tokens: 400
  → seller message text
```

### 2. Batch Runner

**New API endpoint:** `POST /api/admin/batch-run`
Body: `{ persona_ids: string[], runs_per_persona: number }` (default: 5 main personas, 10 runs each)
Response: `{ batch_id: string }` — async, returns immediately

**Execution:**
- Runs simulations sequentially (not parallel) to avoid rate limits
- Each simulation: `runAutomatedSession(personaId, batchId)` → full session object
- Max turns per session: 20 (existing limit)
- Meeting booked → auto-finish (existing logic)
- Buyer: existing Claude Haiku buyer prompt (unchanged)
- After each session: evaluate human-likeness, save to DB

**Progress endpoint:** `GET /api/admin/batch-run/:batch_id/status`
Returns: `{ completed: number, total: number, sessions: [...] }`

**New DB table: `batch_runs`**
```sql
CREATE TABLE batch_runs (
  batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'running',  -- running | done | failed
  persona_ids JSONB,
  runs_per_persona INT,
  completed INT DEFAULT 0,
  total INT,
  analysis_report JSONB
);
```

**New DB table: `batch_sessions`**
```sql
CREATE TABLE batch_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES batch_runs(batch_id),
  session_id TEXT,
  persona_id TEXT,
  persona_name TEXT,
  run_number INT,
  meeting_booked BOOLEAN DEFAULT FALSE,
  total_turns INT,
  acceptance_stage TEXT,
  conversation_hl_score FLOAT,
  per_message_hl_scores JSONB,
  assessment JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3. Human-likeness Evaluation

**Per-message (seller only):**
After each seller turn during automated session:
```
evaluateMessageHL(message, buyerState, turnNumber) →
  Claude claude-haiku-4-5 call
  prompt: "Rate this sales message 1-5 on human-likeness.
           1=clearly AI/scripted, 5=indistinguishable from experienced human salesperson.
           Score only, no explanation."
  → score: 1-5 (float)
```
Stored in `batch_sessions.per_message_hl_scores` as `[{ turn: N, score: X }]`.

**Per-conversation:**
After session ends:
```
evaluateConversationHL(transcript, outcome) →
  Claude claude-haiku-4-5 call
  prompt: "Read this sales conversation. Rate the seller's overall human-likeness 1-5.
           Consider: natural flow, appropriate emotional register, adaptive responses,
           no AI tells (repetition, stiffness, over-explaining).
           Score only."
  → score: 1-5 (float)
```
Stored in `batch_sessions.conversation_hl_score`.

### 4. Analysis Report

**Triggered:** automatically after all sessions in batch complete.

**Input:** all 50 session records with transcripts, outcomes, HL scores, assessments.

**Analysis call:**
```
generateAnalysisReport(batchSessions) →
  Claude claude-sonnet-4-6 call
  system: "You are analyzing automated sales simulations to find improvement opportunities."
  prompt: structured summary of all 50 sessions (outcomes, stages reached, HL scores,
          K1-K6 patterns, calculator usage, turning points)
  → structured JSON:
    {
      conversion_rate: float,
      avg_hl_score: float,
      by_persona: [{ persona, conversion_rate, avg_hl_score, top_issue }],
      seller_prompt_improvements: [{ priority: 1-5, finding, recommendation }],
      conversion_improvements: [{ priority: 1-5, finding, recommendation }],
      top_winning_patterns: string[],
      top_losing_patterns: string[]
    }
```

**Report capped at 10 items** per improvement list. Sorted by priority descending.
Stored in `batch_runs.analysis_report`. Displayed in UI after batch completes.

---

## UI Redesign

### Three principles applied

**P1 — Nothing distracts from the main scenario.**
The main scenario is: read the conversation, type the next message. Everything else
(persona info, buyer state, phase progress, session metadata) moves to collapsed/secondary
position by default.

**P2 — No decorative elements.**
Remove: gradient backgrounds, box shadows on non-interactive elements, decorative
horizontal rules, emoji in UI chrome (keep in conversation bubbles if persona uses them),
color fills on informational badges where color has no function.

**P3 — Complex things look simple.**
Assessment (K1-K6): one criterion at a time (wizard), not a 6-row table.
Batch results: one row per simulation in a clean table, details behind click.
Analysis report: numbered list, no sub-headers per item, no decoration.

### Specific changes

**Run screen (main screen):**
- Remove the sidebar column from run phase — persona name/role shown as one line above transcript, not a card
- Buyer state metrics: collapsed by default, expandable on demand with one click
- Progress rail (acceptance stages): keep, simplify to dots-only with label on hover
- Move hints panel below input, not alongside — one at a time, swipeable

**Assessment screen:**
- Replace 6-card grid with step-by-step: one criterion per view, forward/back navigation
- Each criterion: label + PASS/FAIL chip + one-sentence reason + quote (if available)
- Summary score at end, then "Download" and "New simulation" buttons

**New: Batch screen (admin tab)**
- Top: "Run batch" form — persona checkboxes (5 main pre-selected), runs per persona (default 10), Start button
- During run: live progress table — persona | completed | booked | avg HL score
- After run: analysis report section — conversion rate big, by-persona table, then improvement list

**Navigation:**
- Current tabs: Setup / Run / Review / Analytics / History / Settings
- Add: Batch (admin-only, shown only when logged in as admin)
- Remove: visual tab underline decorations → replace with simple bold active state

---

## Data Flow

```
POST /api/admin/batch-run
  → create batch_run record
  → for each persona × 10 runs:
      → runAutomatedSession()
          → initSession() (existing)
          → loop:
              → generateSellerTurn() [claude-sonnet-4-6 + calculator tool]
              → evaluateMessageHL() [claude-haiku]
              → save seller turn
              → generateBuyerTurn() [existing buyer simulation]
              → update buyer_state
              → check meeting_booked → break if true
          → assessSession() (existing K1-K6)
          → evaluateConversationHL() [claude-haiku]
          → save batch_session record
          → increment batch_run.completed
  → generateAnalysisReport() [claude-sonnet-4-6]
  → save to batch_run.analysis_report
  → set batch_run.status = 'done'
```

---

## New Files

- `server/seller_agent.js` — seller turn generation + calculator tool
- `server/batch_runner.js` — batch orchestration logic
- `server/hl_evaluator.js` — human-likeness scoring functions
- `server/analysis_report.js` — analysis report generation
- `db/migrations/006_batch_runs.sql` — batch_runs + batch_sessions tables

**Modified files:**
- `server.js` — add batch endpoints, import new modules
- `public/app.js` — add Batch UI tab, redesign Run/Assessment screens
- `public/styles.css` — remove decorative styles, simplify component variants

---

## Mellow Product Brief (compiled context)

Compiled separately into `seller_context.js`. Sources:
1. `https://mellow.io` — product pages, landing copy
2. Confluence — internal product knowledge (key pages)
3. HubSpot — anonymized patterns from past deals

Compilation is a manual one-time step (or future automation). The file exports one constant:
`SELLER_SYSTEM_PROMPT`. Updating knowledge = updating this file, no code changes needed.

---

## Success Criteria

- 50 simulations complete without errors
- Analysis report generated with conversion rate + ≥5 ranked recommendations each for seller prompts and conversion improvement
- Human-likeness scores captured for all sessions
- Batch results visible in UI within 30s of completion
- UI redesign: no decorative shadows/gradients, assessment is wizard-style, batch table renders cleanly

---

## Open Items

1. Calculator API parameters at lab.mellow.io/calculator need verification before implementation — requires one HTTP exploration call.
2. Mellow product brief compilation (seller_context.js) is a prerequisite — needs one research pass over mellow.io + Confluence.
3. The 5 main personas to use in batch (Andrey/CFO, Alexey/Founder, Sofia/CFO-SeriesA, Mark/EngMgr, Irina/OpsManager) — confirm persona IDs in DB match these names.
