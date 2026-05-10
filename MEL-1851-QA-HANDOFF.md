# MEL-1851 QA Smoke Test — Language Parameter Fix

## Objective
Verify that batch-runner scripts now correctly pass `language: 'ru'` to session creation, so auto-dialogs run in Russian instead of defaulting to English.

## Fixed Files
- `run_test_10x20.js` — line 37: `language: 'ru'` added to POST /api/sessions
- `run_batch_30x6.js` — line 36: `language: 'ru'` added to POST /api/sessions

## Smoke Test Steps

### 1. Start Server
```bash
cd /home/vspavel/.openclaw/workspace/repos/mellow-sales-sim-3
npm install  # if needed
npm start
# Wait for: "Mellow Sales Sim listening on http://localhost:3210"
```

### 2. Run Batch Test
In a separate terminal:
```bash
cd /home/vspavel/.openclaw/workspace/repos/mellow-sales-sim-3
node run_test_10x20.js
```
This creates 10 sessions × 20 personas. Should complete in ~30 min.

### 3. Verify Language Parameter
While batch is running (or right after first session completes), check one session:
```bash
curl -s http://localhost:3210/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"personaId":"andrey"}' | jq '.language'
```

Expected output: `"ru"` (not `"en"`)

Alternatively, check the batch output logs for persona names and session details — Russian language output in system messages should be visible.

## Pass Criteria
- ✅ At least one session created with `language: "ru"`
- ✅ Auto-messages are in Russian (Cyrillic text, Russian persona responses)
- ✅ No ERROR logs related to language parameter

## Fail Criteria
- ❌ Sessions default to English (language = "en" in response)
- ❌ Server error on language parameter
- ❌ Batch test crashes

## Expected Behavior After Fix
- All 200 sessions (10×20) should have `language: "ru"`
- Persona responses will be in Russian
- Meeting booking flows proceed in Russian
- Assessment verdicts calculated correctly for Russian conversations

## Deliverable
Post result as comment on MEL-1851:
```
✅ PASSED: 200 sessions created with language=ru, all responses in Russian
```
or
```
❌ FAILED: Sessions still defaulting to English. Details: [error details]
```
