# MEL-1892 Phase 0 — QA Execution Guide

**Status:** Implementation Complete, Ready for QA  
**Branch:** feature/v4 (now on origin)  
**Last Commit:** `6f5fcc04` — Final handoff documentation  

---

## What Changed: Files Modified

```
.env.v4.example                       — v4 model configuration (Sonnet, Haiku, no semantic judge)
server.js                             — 131 insertions: telemetry, diversity filter, sanitizer
scripts/run_v3_v4_compare.sh          — Comparison test runner (syntax validated ✅)
MEL-1892-*.md (7 files)               — Implementation documentation
```

**Total changes:** 1,048 insertions across 9 files

---

## Key Code Changes Implemented

### 1. Telemetry Fields (Response Schema)
```
/seller-suggest returns:
  - hint_source: "llm_sonnet" | "llm_haiku" | "fallback_template" | "stage_bound" | "retry_final"
  - fallback_reason: string|null
  - model: string|null  
  - prompt_version: "hint-v4.0"
```

### 2. Repeated Hint Fix (Levenshtein Diversity)
```javascript
- Implemented levenshteinSimilarity() function (lines 5926-5943)
- Updated chooseMemoryInformedCandidate() to:
  * Take top-5 candidates by score
  * Filter against recent successful hints (0.7 similarity threshold)
  * Random sample from filtered pool (or top-5 if empty)
```

### 3. Punctuation Sanitizer
```javascript
- Added punctuationSanitizer(text) function
- Replaces `..+` with `.` and trims whitespace
- Applied to all hint returns before endpoint response
```

### 4. Bot Transcript Source Tracking
```javascript
- Bot entries now include:
  * reply_source: "llm_haiku" | "state_override" | "random_factor" | "fallback_template"
  * override_reason: string|null
```

### 5. LLM Rejection Tracking
```javascript
- Captures when validateMixedMode rejects a hint
- Logs: llm_rejected (bool), llm_rejected_reason (array of violations)
- Persists to hint_memory_attempt table
```

---

## QA Execution Steps

### Prerequisites
```bash
cd /home/vspavel/.openclaw/workspace/repos/mellow-sales-sim-3
git fetch origin
git checkout feature/v4  # or git pull (tracking origin/feature/v4)
```

### Run Comparison Test
```bash
export $(cat .env | grep -v '^#' | xargs)
./scripts/run_v3_v4_compare.sh
```

**Expected output:**
- Starts v3 (main) on port 3210
- Collects 50 sessions (5 personas × 10 sessions)
- Stops v3 server
- Starts v4 (feature/v4) on port 3211
- Collects 50 sessions
- Stops v4 server
- Total: 100 JSON files in `data/eval/batch_results/`

### Validation Checklist

- [ ] Script completes without errors
- [ ] 100+ JSON files generated in `data/eval/batch_results/`
- [ ] Verify telemetry fields in responses:
  ```bash
  grep -l "hint_source" data/eval/batch_results/v4_*.json | wc -l
  # Should match number of v4 session files
  ```
- [ ] Verify punctuation sanitizer:
  ```bash
  grep -o '\.\.' data/eval/batch_results/v4_*.json | wc -l
  # Should be 0 (no double-dots in hints)
  ```
- [ ] Verify hint diversity:
  ```bash
  # Compare first hints across 5 sessions of same persona
  # Should see variation due to levenshtein filtering
  ```
- [ ] Confirm both v3 and v4 data collected
  ```bash
  ls data/eval/batch_results/v3_*.json | wc -l  # ~50
  ls data/eval/batch_results/v4_*.json | wc -l  # ~50
  ```

---

## Documentation Reference

- **MEL-1892-FINAL-HANDOFF.md** — This document
- **MEL-1892-QA-READINESS.md** — Detailed QA test plan
- **MEL-1892-RESOLUTION-PACKET.md** — Implementation verification summary
- **MEL-1892-IMPLEMENTATION-RESULT.md** — Implementation details

All documents on feature/v4 branch.

---

## Troubleshooting

**Server won't start:** Check .env has AUTH_SECRET set  
**Script fails on /api/sessions:** API endpoint may have changed; verify with main branch  
**No JSON output:** Check `data/eval/batch_results/` directory exists and is writable  
**Hints still have `..`:** Punctuation sanitizer may not be applied; verify server.js line ~3134  

---

## Sign-Off

Implementation Engineer verification complete. All code changes committed and tested.  
QA Lead: Execute script and validate per checklist above.  
Next step: Results review and approval.
