# Mellow Sales Simulator v3 — Immutable Baseline

**Version status**: v3 is the production baseline for Sales Sim. This repository is **locked to v3** for comparative testing.

**⚠️ Version Isolation (MEL-1879)**: Sales Sim v4 has moved to a **separate repository** for hard isolation:
- **v4 Repository**: https://github.com/Vspavel/mellow-sales-sim-4 (separate code, separate Vercel project)
- **v4 Deployment Guide**: See https://github.com/Vspavel/mellow-sales-sim-4/blob/main/DEPLOYMENT.md
- **v3/v4 Comparison**: Run both servers locally and use `npm run compare:10x10` to validate v4 against v3 baseline

The v4/ subdirectory that previously existed in this repo is **legacy scaffold only**. Do not use it; use the separate v4 repository instead.

---

Первая рабочая web-версия Mellow Sales Simulator. Сейчас поддерживает 8 buyer personas: Андрей, Алексей, CFO before fundraising, champion / Engineering Manager, Ops Manager, Head of Finance, internal legal, external legal.

## Что внутри
- web UI: выбор персоны → SDE-card → диалог → assessment
- backend на Node.js + Express
- хранение через adapter boundary: локально `data/*.json`, опционально Postgres для personas/sessions
- 8 buyer personas, сведённых к 3 рабочим archetypes: finance, ops/champion, legal
- детерминированная roleplay-логика без внешних LLM
- единый assessment по 5 критериям

## Локальный запуск
```bash
cd mellow-sales-sim
npm install
npm start
```

Приложение поднимется на `http://localhost:3210`.

По умолчанию используется локальное файловое хранилище.

## Postgres slice
Для migration-среза personas и sessions можно включить Postgres:

```bash
cp .env.example .env
STORAGE_DRIVER=postgres DATABASE_URL=postgres://... npm start
```

Что уже уехало в Postgres:
- `personas`
- `sales_sessions`
- миграции из `db/migrations/*.sql`
- `/api/meta` c версией приложения и storage metadata

Что пока остаётся файловым:
- artifacts
- hint memory / hint recency / tuning
- logs

При первом запуске с `STORAGE_DRIVER=postgres` приложение импортирует существующие `data/personas.json` и `data/sessions/*.json`, если таблицы ещё пустые. Это сделано как one-way bootstrap без удаления существующих файловых данных.

## Структура
- `server.js` — API, сессии, roleplay logic, assessment
- `public/` — frontend
- `data/sessions/` — сохранённые прогоны
- `storage/` — file/postgres adapter
- `db/migrations/` — SQL migration files

## Замечание по v1
Это сознательно узкая первая версия: без auth, без CRM, без history UI, без внешнего LLM runtime. Зато один полный run до assessment реально работает и доступен по web URL после публикации.
