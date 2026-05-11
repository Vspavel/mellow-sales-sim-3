# ⚠️ v4 Subdirectory — DEPRECATED

**This directory is legacy scaffold only.**

Sales Sim v4 has been extracted to a **separate repository** as per MEL-1879 (Version Isolation Rule).

## Use the v4 Repository Instead

**v4 Repository**: https://github.com/Vspavel/mellow-sales-sim-4

This separate repository provides:
- Independent Git history
- Separate Vercel project
- Clear deployment boundaries
- No mixing with v3 baseline

## Why Hard Isolation?

The Version Isolation Rule (2026-05-11) requires:
1. New projects must not be subdirectories of prior versions
2. v4 needs separate repo + separate Vercel project
3. v3 remains immutable baseline for comparative testing
4. QA can clearly distinguish v3 (production) from v4 (new build)

## What Was Here

The v4/ subdirectory previously contained:
- `server.js` (v4 entry point) → moved to separate repo
- `package.json` (v4 dependencies) → moved to separate repo
- `public/` (UI) → moved to separate repo
- `data/` (personas/config) → moved to separate repo

All files have been extracted to https://github.com/Vspavel/mellow-sales-sim-4.

## Local Development

Clone the separate v4 repository:
```bash
git clone https://github.com/Vspavel/mellow-sales-sim-4.git
cd mellow-sales-sim-4
npm install
npm start  # Runs on port 3211
```

See https://github.com/Vspavel/mellow-sales-sim-4/blob/main/DEPLOYMENT.md for deployment instructions.
