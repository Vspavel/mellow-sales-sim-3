import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createStorage } from './storage/index.js';
import { createAuth } from './middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3210;
const dataDir = path.join(__dirname, 'data');
const sessionsDir = path.join(dataDir, 'sessions');
const logsDir = path.join(dataDir, 'logs');
const sdrHintTuningFile = path.join(dataDir, 'sdr_hint_tuning.json');
const hintMemoryFile = path.join(dataDir, 'hint_memory.json');
const hintRecencyFile = path.join(dataDir, 'hint_recency.json');
const promptMemoryRunsDir = path.join(dataDir, 'prompt_memory_runs');
const evaluationRunsDir = path.join(dataDir, 'evaluation_runs');
const artifactsDir = path.join(dataDir, 'artifacts');
const personasFile = path.join(dataDir, 'personas.json');
const doctrinesFile = path.join(dataDir, 'doctrine_config.json');
const promptArtifactsFile = path.join(__dirname, '..', 'mellow-sales-sim-v1-artifacts.md');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const storage = await createStorage({
  dataDir,
  sessionsDir,
  personasFile,
  doctrinesFile,
  logsDir,
  hintMemoryFile,
  hintRecencyFile,
  sdrHintTuningFile,
  artifactsDir,
  promptMemoryRunsDir,
  evaluationRunsDir,
});
await storage.init();
if (storage.driver === 'file') {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(promptMemoryRunsDir, { recursive: true });
  fs.mkdirSync(evaluationRunsDir, { recursive: true });
}

let sdrHintTuningCache = { mtimeMs: -1, data: { openers: {}, concerns: {}, next_steps: {} } };
let hintMemoryCache = { mtimeMs: -1, data: { version: 'v2', records: [] } };
let hintRecencyCache = [];
const HINT_MEMORY_VERSION = 'v2';
const HINT_MEMORY_MAX_RECORDS = 600;
const HINT_MEMORY_RETRIEVAL_WINDOW = 240;
const HINT_MEMORY_MAX_SUCCESS = 3;
const HINT_MEMORY_MAX_FAILURE = 2;
const HINT_RECENCY_MAX = 8;
const UCB_C = Number(process.env.HINT_UCB_C ?? 1.0);
const MAX_DIALOGUE_MESSAGES = 30;
const ANALYTICS_BASELINE_RESET_AT = Date.parse('2026-04-26T05:29:00.000Z');

function visibleDialogueMessages(session) {
  return (session?.transcript || []).filter((entry) => entry.role !== 'system');
}

function visibleDialogueMessageCount(session) {
  return visibleDialogueMessages(session).length;
}

function dialogueMessageBudgetRemaining(session) {
  return Math.max(0, MAX_DIALOGUE_MESSAGES - visibleDialogueMessageCount(session));
}

function shouldPersistSession(session) {
  return !(session?.meta?.skip_persistence);
}

async function finalizeSession(session, trigger = 'final_state') {
  session.status = 'finished';
  session.finished_at = now();
  session.trigger = trigger;
  session.assessment = assess(session);
  session.assessment_id = session.assessment.assessment_id;
  session.dialogue_summary = buildDialogueSummary(session);
  if (shouldPersistSession(session)) {
    appendSessionHintMemory(session);
    await saveSession(session);
    saveArtifact(session);
    logFinishedRun(session);
  }
  return session;
}

function normalizeTuningMap(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function normalizeTuningList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

async function hydrateAuxiliaryStorage() {
  try {
    const [recentOpeners, tuning, hintRecords] = await Promise.all([
      storage.loadHintRecency ? storage.loadHintRecency() : [],
      storage.loadSdrHintTuning ? storage.loadSdrHintTuning() : { openers: {}, concerns: {}, next_steps: {} },
      storage.loadHintMemoryStore ? storage.loadHintMemoryStore() : [],
    ]);
    hintRecencyCache = Array.isArray(recentOpeners) ? recentOpeners.slice(-HINT_RECENCY_MAX) : [];
    sdrHintTuningCache = {
      mtimeMs: Date.now(),
      data: {
        openers: normalizeTuningMap(tuning?.openers),
        concerns: normalizeTuningMap(tuning?.concerns),
        next_steps: normalizeTuningMap(tuning?.next_steps)
      }
    };
    hintMemoryCache = {
      mtimeMs: Date.now(),
      data: {
        version: HINT_MEMORY_VERSION,
        records: Array.isArray(hintRecords) ? hintRecords : []
      }
    };
  } catch (err) {
    console.error('[storage] auxiliary hydrate error:', err?.message || err);
  }
}

await hydrateAuxiliaryStorage();

function loadHintRecency() {
  return Array.isArray(hintRecencyCache) ? hintRecencyCache : [];
}

function saveHintRecency(openers) {
  const normalized = Array.isArray(openers) ? openers.slice(-HINT_RECENCY_MAX) : [];
  hintRecencyCache = normalized;
  if (storage.saveHintRecency) {
    Promise.resolve(storage.saveHintRecency(normalized)).catch((err) => {
      console.error('[hint-recency] save error:', err?.message || err);
    });
  }
}

function loadSdrHintTuning() {
  if (storage.driver === 'file') {
    try {
      const stat = fs.statSync(sdrHintTuningFile);
      if (stat.mtimeMs !== sdrHintTuningCache.mtimeMs) {
        const parsed = JSON.parse(fs.readFileSync(sdrHintTuningFile, 'utf8'));
        sdrHintTuningCache = {
          mtimeMs: stat.mtimeMs,
          data: {
            openers: normalizeTuningMap(parsed?.openers),
            concerns: normalizeTuningMap(parsed?.concerns),
            next_steps: normalizeTuningMap(parsed?.next_steps)
          }
        };
      }
    } catch {
      sdrHintTuningCache = { mtimeMs: -1, data: { openers: {}, concerns: {}, next_steps: {} } };
    }
  }
  return sdrHintTuningCache.data;
}

function tunedOpeners(personaId) {
  const tuning = loadSdrHintTuning();
  return [
    ...normalizeTuningList(tuning?.openers?.[personaId]),
    ...normalizeTuningList(tuning?.openers?.default)
  ];
}

function tunedConcernLines(personaId, concern, archetype) {
  const tuning = loadSdrHintTuning();
  const concerns = normalizeTuningMap(tuning?.concerns);
  const personaConcerns = normalizeTuningMap(concerns?.[personaId]);
  const archetypeConcerns = normalizeTuningMap(concerns?.[archetype]);
  const defaultConcerns = normalizeTuningMap(concerns?.default);
  return [
    ...normalizeTuningList(personaConcerns?.[concern]),
    ...normalizeTuningList(archetypeConcerns?.[concern]),
    ...normalizeTuningList(defaultConcerns?.[concern])
  ];
}

function tunedNextSteps(personaId, archetype) {
  const tuning = loadSdrHintTuning();
  const nextSteps = normalizeTuningMap(tuning?.next_steps);
  return [
    ...normalizeTuningList(nextSteps?.[personaId]),
    ...normalizeTuningList(nextSteps?.[archetype]),
    ...normalizeTuningList(nextSteps?.default)
  ];
}

const BUILTIN_PERSONAS = {
  andrey: {
    id: 'andrey',
    name: 'Андрей Волков',
    role: 'CFO — финансовые риски и сложные гео',
    intro: 'Жёсткий CFO. Проверяет границы ответственности, риск и следующий шаг.',
    archetype: 'finance',
    tone: 'risk',
    cards: [
      {
        card_id: 'andrey-card-1',
        signal_type: 'COMPLIANCE_PRESSURE',
        heat: 'hot',
        outreach_window: '48 часов',
        contact: { name: 'Андрей Волков', title: 'CFO', linkedin: 'linkedin.com/in/andrey-volkov' },
        company: { name: 'Northstar Games', industry: 'GameDev', size: '280 сотрудников', hq: 'Amsterdam', founded_year: 2018, latest_event: 'Компания обсуждает стратегическое партнёрство и готовится к внешней юридической проверке.' },
        what_happened: 'Финансовая команда застряла в ручной сверке выплат подрядчикам, а один из платежей завис почти на три недели прямо перед внешней юридической проверкой.',
        apollo_context: [
          '45 подрядчиков в UA/KZ/GE/AM и часть с паспортами РФ',
          'Текущая схема: Wise / Payoneer / посредник в Грузии',
          'Скоро внешняя юридическая проверка схемы работы с подрядчиками и выплатами'
        ],
        target_profile: 'A',
        probable_pain: 'Сочетание санкционного и налогового риска с ручной перегрузкой внутри finance.',
        recommended_product: 'CoR',
        recommended_channel: 'LinkedIn',
        first_touch_hint: 'Заходи через зависший платёж и предстоящую юридическую проверку, не обещай волшебного снятия комплаенс-рисков.',
        dont_do: ['Не обещай защиту от неправильной классификации', 'Не начинай с обезличенного захода'],
        rendered_text: 'Сигнал: у Northstar Games перед внешней юридической проверкой всплыла проблема с выплатами подрядчикам. Один платёж завис на 23 дня, а финансовая команда тратит 3-4 дня в месяц на ручную сверку. Контекст: 45 подрядчиков, сложные юрисдикции, смесь Wise, Payoneer и посредника.'
      },
      {
        card_id: 'andrey-card-2',
        signal_type: 'FUNDRAISING_DILIGENCE',
        heat: 'warm',
        outreach_window: '3 недели',
        contact: { name: 'Андрей Волков', title: 'CFO', linkedin: 'linkedin.com/in/andrey-volkov' },
        company: { name: 'Stellarpath', industry: 'B2B Software', size: '320 сотрудников', hq: 'Warsaw', founded_year: 2017, latest_event: 'Совет директоров поставил задачу привести схему работы с подрядчиками в порядок до Series B.' },
        what_happened: 'Совет директоров попросил CFO проверить текущую схему работы с подрядчиками перед переговорами о новом раунде. CFO видит риски в смешанной географической структуре.',
        apollo_context: [
          '60+ подрядчиков в PL/UA/GE/KZ',
          'Часть выплат идёт через личные счета',
          'Совет директоров требует привести документы по подрядчикам в порядок до раунда'
        ],
        target_profile: 'A',
        probable_pain: 'Схема выглядит недостаточно управляемой перед проверкой со стороны инвесторов',
        recommended_product: 'CoR',
        recommended_channel: 'LinkedIn',
        first_touch_hint: 'Заходи через готовность к проверке инвесторов и управляемость схемы, а не через общий комплаенс-нарратив.',
        dont_do: ['Не обещай снять legal risk целиком', 'Не говори как с операционным менеджером'],
        rendered_text: 'Сигнал: у Stellarpath совет директоров поставил задачу привести схему работы с подрядчиками в порядок до Series B. CFO видит риски в географически смешанной структуре и частичных выплатах через личные счета.'
      }
    ]
  },
  alexey: {
    id: 'alexey',
    name: 'Алексей Громов',
    role: 'Founder / CEO — операционный и быстрый',
    intro: 'Быстрый founder. Любит коротко, конкретно, без маркетинговых клише.',
    archetype: 'ops',
    tone: 'speed',
    cards: [
      {
        card_id: 'alexey-card-1',
        signal_type: 'PAIN_SIGNAL',
        heat: 'warm',
        outreach_window: '72 часа',
        contact: { name: 'Алексей Громов', title: 'CEO / Founder', linkedin: 'linkedin.com/in/alexey-gromov' },
        company: { name: 'OrbitFlow', industry: 'B2B SaaS', size: '140 сотрудников', hq: 'remote / Dubai', founded_year: 2021, latest_event: 'Команда активно нанимает и расширяет подрядчиков в Кавказе и Центральной Азии.' },
        what_happened: 'Операционная команда жалуется на задержки выплат и постоянную ручную координацию через Wise / crypto.',
        apollo_context: [
          'Founder живёт вне ЕС, думает скоростью и execution',
          'Подрядчики в Армении, Грузии, Казахстане и иногда РФ',
          'Главная боль: бардак, задержки, ручная возня, а не legal detail'
        ],
        target_profile: 'B',
        probable_pain: 'Операционный friction и потеря времени команды',
        recommended_product: 'CM',
        recommended_channel: 'email',
        first_touch_hint: 'Продавай операционный апгрейд, а не страх.',
        dont_do: ['Не душни compliance-нарративом', 'Не пиши длинно', 'Не используй маркетинговые клише'],
        rendered_text: 'Сигнал: у OrbitFlow растёт распределённая команда подрядчиков, а ops уже тонет в задержках выплат и ручной координации через Wise / crypto. Founder ценит скорость и не любит тяжёлые sales-процессы.'
      },
      {
        card_id: 'alexey-card-2',
        signal_type: 'OPERATIONS_OVERLOAD',
        heat: 'hot',
        outreach_window: '48 часов',
        contact: { name: 'Алексей Громов', title: 'CEO / Founder', linkedin: 'linkedin.com/in/alexey-gromov' },
        company: { name: 'PatchStack', industry: 'DevSec', size: '85 сотрудников', hq: 'Tallinn', founded_year: 2022, latest_event: 'За последние 6 месяцев добавили 50+ contractors, ops процессы уже не справляются.' },
        what_happened: 'После быстрого роста команды операционный контур стал узким местом: выплаты идут через 4 разных канала, задержки нарастают.',
        apollo_context: [
          'Компания агрессивно растёт, скорость важнее процессов',
          'Подрядчики в AM/GE/KZ/UZ, часть выплат через криптовалюту',
          'Founder лично разруливает эскалации по выплатам — уже раздражён'
        ],
        target_profile: 'B',
        probable_pain: 'Операционный контур тормозит рост, а founder тратит время не на продукт, а на ручные разборы',
        recommended_product: 'CM',
        recommended_channel: 'email',
        first_touch_hint: 'Говори про скорость и снятие ручной нагрузки, а не про комплаенс. Конкретно: сколько каналов уберёт и сколько часов вернёт.',
        dont_do: ['Не начинай с legal framing', 'Не пиши длинно', 'Не обещай compliance-волшебства'],
        rendered_text: 'Сигнал: у PatchStack быстрый рост привёл к операционному хаосу с выплатами, 4 разным каналам и постоянным задержкам. Founder лично занимается эскалациями и уже ищет способ убрать это из своего фокуса.'
      }
    ]
  },
  cfo_round: {
    id: 'cfo_round',
    name: 'София Бреннер',
    role: 'CFO — подготовка к новому раунду',
    intro: 'Финансовый лидер перед проверкой инвесторов. Слушает только то, что снижает риск раунда.',
    archetype: 'finance',
    tone: 'diligence',
    cards: [
      {
        card_id: 'cfo-round-card-1',
        signal_type: 'FUNDRAISING_DILIGENCE',
        heat: 'hot',
        outreach_window: '30 дней',
        contact: { name: 'Sofia Brenner', title: 'CFO', linkedin: 'linkedin.com/in/sofia-brenner-finance' },
        company: { name: 'Vaultify', industry: 'B2B SaaS', size: '95 сотрудников', hq: 'Dublin', founded_year: 2020, latest_event: 'Series A закрыта три недели назад, ведущий инвестор запросил более чистый контроль подрядчиков.' },
        what_happened: 'После закрытия раунда CFO поднимает тему документов по подрядчикам и готовится к будущей проверке со стороны инвесторов.',
        apollo_context: [
          '6 подрядчиков в UA/KZ и новый юридический советник',
          'Нужно быстро собрать более чистую схему работы с подрядчиками и выплатами',
          'Есть чувствительность к прозрачности следа операций и объяснимости перед инвесторами'
        ],
        target_profile: 'C',
        probable_pain: 'Потеря управляемости перед инвесторами и давление будущей проверки',
        recommended_product: 'CoR',
        recommended_channel: 'LinkedIn + email',
        first_touch_hint: 'Заходи через готовность к проверке инвесторов и управляемость схемы до следующего раунда.',
        dont_do: ['Не обещай, что Mellow снимет юридический риск за CFO', 'Не сваливайся в общий финтех-питч'],
        rendered_text: 'Сигнал: CFO только что вошла в роль после раунда и уже собирает более чистую схему работы с подрядчиками и выплатами перед будущей проверкой инвесторов. Есть чувствительность к прозрачному следу операций, документам по подрядчикам и объяснимости для инвесторов.'
      },
      {
        card_id: 'cfo-round-card-2',
        signal_type: 'COMPLIANCE_PRESSURE',
        heat: 'hot',
        outreach_window: '10 дней',
        contact: { name: 'Sofia Brenner', title: 'CFO', linkedin: 'linkedin.com/in/sofia-brenner-finance' },
        company: { name: 'Liftwave', industry: 'PropTech', size: '130 сотрудников', hq: 'Amsterdam', founded_year: 2021, latest_event: 'Ведущий инвестор после Series A запросил более чистый контроль подрядчиков и документов.' },
        what_happened: 'После закрытия раунда ведущий инвестор выразил обеспокоенность текущей схемой работы с подрядчиками и попросил CFO привести её в порядок до следующего квартального разбора.',
        apollo_context: [
          '25 подрядчиков в NL/UA/GE со смешанным качеством документов',
          'Давление идёт со стороны инвестора, это не внутренняя инициатива',
          'CFO работает в условиях сжатых сроков'
        ],
        target_profile: 'C',
        probable_pain: 'Давление со стороны инвестора без инструмента для быстрого наведения порядка',
        recommended_product: 'CoR',
        recommended_channel: 'LinkedIn + email',
        first_touch_hint: 'Заходи через давление инвестора и сжатые сроки, это не внутренняя уборка, а подготовка к проверке сверху.',
        dont_do: ['Не затягивай вступление', 'Не уходи в общий compliance pitch'],
        rendered_text: 'Сигнал: после Series A у Liftwave ведущий инвестор запросил более чистый контроль подрядчиков. CFO под давлением привести схему в порядок до следующего квартального разбора.'
      }
    ]
  },
  eng_manager: {
    id: 'eng_manager',
    name: 'Марк Левин',
    role: 'Engineering Manager — потенциальный внутренний champion',
    intro: 'Потенциальный внутренний champion. Любит практику, не любит театра в продажах.',
    archetype: 'ops',
    tone: 'champion',
    cards: [
      {
        card_id: 'eng-manager-card-1',
        signal_type: 'TEAM_SCALING',
        heat: 'warm',
        outreach_window: '10 дней',
        contact: { name: 'Mark Levin', title: 'Engineering Manager', linkedin: 'linkedin.com/in/mark-levin-eng' },
        company: { name: 'Docklane', industry: 'DevTools', size: '180 сотрудников', hq: 'Berlin', founded_year: 2019, latest_event: 'Команда нанимает в Восточной Европе и Кавказе, а engineering тратит время на payment/firefighting.' },
        what_happened: 'Engineering manager несколько раз помогал разруливать срывы выплат подрядчикам и устал быть операционным мостом между finance и contractors.',
        apollo_context: [
          '15+ external engineers across AM/GE/KZ',
          'Нервы команды растут после двух задержек выплат',
          'Champion может открыть дверь в finance, если увидит практическую пользу'
        ],
        target_profile: 'D',
        probable_pain: 'Команда теряет фокус, а manager становится ручным эскалационным слоем',
        recommended_product: 'CM',
        recommended_channel: 'LinkedIn',
        first_touch_hint: 'Покажи, как убрать ручные эскалации и дать champion сильный internal case.',
        dont_do: ['Не разговаривай как с CFO', 'Не навязывай тяжёлый compliance-нарратив'],
        rendered_text: 'Сигнал: у Docklane engineering manager уже не первый раз гасит раздражение подрядчиков из-за выплат. Если увидит реальный operational relief, может стать внутренним champion и занести разговор в finance.'
      }
    ]
  },
  ops_manager: {
    id: 'ops_manager',
    name: 'Ирина Коваль',
    role: 'Ops Manager',
    intro: 'Операционный менеджер. Считает руками, живёт в процессах, хочет убрать хаос.',
    archetype: 'ops',
    tone: 'process',
    cards: [
      {
        card_id: 'ops-manager-card-1',
        signal_type: 'OPERATIONS_OVERLOAD',
        heat: 'hot',
        outreach_window: '14 дней',
        contact: { name: 'Ирина Коваль', title: 'Operations Manager', linkedin: 'linkedin.com/in/irina-koval-ops' },
        company: { name: 'BlueMesa', industry: 'Marketplace', size: '210 сотрудников', hq: 'Limassol', founded_year: 2018, latest_event: 'Компания ускоряет найм подрядчиков, а операционный контур уже не успевает за координацией выплат.' },
        what_happened: 'Операционный менеджер тратит несколько часов в неделю на статусы, сверки и ручные напоминания по выплатам подрядчикам.',
        apollo_context: [
          '30+ contractors in KZ/GE/RS/AM',
          'Статусы по выплатам размазаны по чатам и таблицам',
          'Главная боль не legal framing, а отсутствие предсказуемого процесса'
        ],
        target_profile: 'E',
        probable_pain: 'Ручная координация съедает время операционного контура и ломает предсказуемость процесса',
        recommended_product: 'CM',
        recommended_channel: 'email',
        first_touch_hint: 'Заходи через снятие хаоса, статусы и меньше ручных напоминаний.',
        dont_do: ['Не говори слишком абстрактно', 'Не продавай инвесторский нарратив тому, кто живёт процессом'],
        rendered_text: 'Сигнал: у BlueMesa операционный менеджер уже держит координацию выплат руками через таблицы и чаты. Боль в предсказуемости, статусах и потере времени на ручные напоминания.'
      },
      {
        card_id: 'ops-manager-card-2',
        signal_type: 'FINANCE_CONTROL_GAP',
        heat: 'warm',
        outreach_window: '14 дней',
        contact: { name: 'Ирина Коваль', title: 'Operations Manager', linkedin: 'linkedin.com/in/irina-koval-ops' },
        company: { name: 'TalentHub', industry: 'HRTech', size: '155 сотрудников', hq: 'Vilnius', founded_year: 2019, latest_event: 'Finance запросил детализацию contractor payments за Q1 для внутреннего audit.' },
        what_happened: 'Finance запросила детализацию всех выплат подрядчикам за квартал, и ops потратила три дня, чтобы собрать картину из пяти разных источников.',
        apollo_context: [
          '25 contractors across LT/EE/LV/UA',
          'Данные о выплатах размазаны между Slack, Wise и таблицами',
          'Finance недовольна качеством reporting'
        ],
        target_profile: 'E',
        probable_pain: 'Нет единого источника данных — любой запрос от finance превращается в ручную сборку',
        recommended_product: 'CM',
        recommended_channel: 'email',
        first_touch_hint: 'Заходи через боль ручной отчётности. Для ops это должно занимать минуты, а не дни.',
        dont_do: ['Не усложняй compliance-нарративом', 'Не пиши длинно'],
        rendered_text: 'Сигнал: у TalentHub запрос из finance на детализацию выплат подрядчикам за квартал превратил ops в ручной сборочный цех на три дня. Главная боль в том, что нет единого источника данных и нормального процесса отчётности.'
      }
    ]
  },
  head_finance: {
    id: 'head_finance',
    name: 'Елена Мартин',
    role: 'Head of Finance',
    intro: 'Head of Finance между руками и стратегией. Нужны контроль, объяснимость и меньше ручной сверки.',
    archetype: 'finance',
    tone: 'control',
    cards: [
      {
        card_id: 'head-finance-card-1',
        signal_type: 'FINANCE_CONTROL_GAP',
        heat: 'warm',
        outreach_window: '21 день',
        contact: { name: 'Elena Martin', title: 'Head of Finance', linkedin: 'linkedin.com/in/elena-martin-finance' },
        company: { name: 'ClearHarbor', industry: 'Martech', size: '160 сотрудников', hq: 'London', founded_year: 2017, latest_event: 'Finance наводит порядок перед annual audit и пересматривает contractor payout controls.' },
        what_happened: 'Команда finance устала жить между ручной сверкой, разбросанными документами и вопросами от leadership.',
        apollo_context: [
          'Есть distributed contractors across EE/CIS',
          'Внутренний pressure на cleaner reporting and documentation',
          'Head of Finance нужно решение, которое легче объяснять вверх и вести руками вниз'
        ],
        target_profile: 'F',
        probable_pain: 'Слабый контроль и высокая ручная нагрузка внутри finance без внятной истории для аудита.',
        recommended_product: 'CoR',
        recommended_channel: 'email',
        first_touch_hint: 'Держи линию на контроль, объяснимость и снижение ручной сверки. Говори спокойно и предметно.',
        dont_do: ['Не продавай через founder-energy', 'Не обещай тотальный legal shield'],
        rendered_text: 'Сигнал: у Head of Finance накопился разрыв между ручной сверкой выплат подрядчикам и требованием руководства видеть контролируемую, объяснимую схему. Команда уже готовится к ежегодному аудиту.'
      },
      {
        card_id: 'head-finance-card-2',
        signal_type: 'FUNDRAISING_DILIGENCE',
        heat: 'hot',
        outreach_window: '14 дней',
        contact: { name: 'Elena Martin', title: 'Head of Finance', linkedin: 'linkedin.com/in/elena-martin-finance' },
        company: { name: 'Greychain', industry: 'InsurTech', size: '190 сотрудников', hq: 'Helsinki', founded_year: 2018, latest_event: 'CFO поставил задачу привести contractor controls в порядок до Series B.' },
        what_happened: 'Готовясь к Series B, CFO поручил Head of Finance проверить контур подрядчиков. Текущая схема пока плохо выглядит для инвесторской проверки.',
        apollo_context: [
          '35 contractors in FI/EE/UA/GE',
          'Investor-level pressure через CFO',
          'Head of Finance нужен инструмент, который можно показать вверх'
        ],
        target_profile: 'F',
        probable_pain: 'Схема не готова к проверке, и Head of Finance одновременно отвечает и вверх, и за ручное исполнение вниз.',
        recommended_product: 'CoR',
        recommended_channel: 'email',
        first_touch_hint: 'Говори про объяснимость для руководства и управляемость для команды. У Head of Finance действительно два фронта.',
        dont_do: ['Не уходи в founder-pitch', 'Не обещай полного устранения риска'],
        rendered_text: 'Сигнал: у Greychain CFO поставил задачу привести контроль подрядчиков в порядок до Series B. Head of Finance нужен контур, который можно спокойно показать руководству и которым можно управлять в ежедневной работе.'
      }
    ]
  },
  internal_legal: {
    id: 'internal_legal',
    name: 'Анна Рихтер',
    role: 'Internal Legal Counsel',
    intro: 'Внутренний юрист. Слушает формулировки, границы и управляемость документов.',
    archetype: 'legal',
    tone: 'internal-legal',
    cards: [
      {
        card_id: 'internal-legal-card-1',
        signal_type: 'LEGAL_REVIEW_TRIGGER',
        heat: 'warm',
        outreach_window: '14 дней',
        contact: { name: 'Anna Richter', title: 'Legal Counsel', linkedin: 'linkedin.com/in/anna-richter-legal' },
        company: { name: 'SynthPort', industry: 'Fintech', size: '120 сотрудников', hq: 'Berlin', founded_year: 2021, latest_event: 'Внутренний юрист обновляет шаблоны подрядчиков и ищет более чистую схему документов и выплат.' },
        what_happened: 'Юрист получила задачу пересобрать документы по подрядчикам и хочет сократить серые зоны между операционным контуром, финансами и текущими посредниками.',
        apollo_context: [
          'Есть вопросы к согласованности документов и прослеживаемости',
          'Нужно решение, которое юрист может объяснить финансам и руководству',
          'Фокус на границах ответственности, прозрачном следе операций и дисциплине процесса'
        ],
        target_profile: 'G',
        probable_pain: 'Слишком много серых зон и ручных исключений в схеме документов и выплат подрядчикам',
        recommended_product: 'CoR',
        recommended_channel: 'email',
        first_touch_hint: 'Говори аккуратно: документация, прозрачный след операций, ограничения, без завышенных обещаний.',
        dont_do: ['Не обещай снять юридический риск целиком', 'Не уходи в напористый founder-style заход'],
        rendered_text: 'Сигнал: внутренний юрист пересобирает документы по подрядчикам и хочет более объяснимую схему выплат и документов. Главная чувствительность в границах ответственности, прослеживаемости и лишних серых зонах.'
      },
      {
        card_id: 'internal-legal-card-2',
        signal_type: 'OUTSIDE_COUNSEL_CHECK',
        heat: 'warm',
        outreach_window: '14 дней',
        contact: { name: 'Anna Richter', title: 'Legal Counsel', linkedin: 'linkedin.com/in/anna-richter-legal' },
        company: { name: 'Meridian Cloud', industry: 'SaaS', size: '100 сотрудников', hq: 'Riga', founded_year: 2021, latest_event: 'Компания расширяется на новые юрисдикции ЕС, а юридическая функция приводит в порядок классификацию подрядчиков.' },
        what_happened: 'При расширении на новые рынки ЕС юридическая функция обнаружила непоследовательную классификацию подрядчиков между юрисдикциями. Нужно привести всё в порядок до выхода на новый рынок.',
        apollo_context: [
          'Выход в DE и FR, структура подрядчиков не унифицирована',
          'Legal отвечает за документацию перед новыми регуляторными средами',
          'Проблема в consistency, не в отдельных инцидентах'
        ],
        target_profile: 'G',
        probable_pain: 'Несогласованная классификация между юрисдикциями создаёт регуляторный риск при расширении',
        recommended_product: 'CoR',
        recommended_channel: 'email',
        first_touch_hint: 'Говори про согласованность между юрисдикциями и прозрачный след операций, а не про отдельный кейс.',
        dont_do: ['Не обещай legal certainty', 'Не заходи с ops-нарративом'],
        rendered_text: 'Сигнал: у Meridian Cloud при расширении в ЕС юридическая функция нашла непоследовательную классификацию подрядчиков между юрисдикциями. Нужно привести всё в порядок до выхода на DE и FR.'
      }
    ]
  },
  external_legal: {
    id: 'external_legal',
    name: 'Давид Шмидт',
    role: 'External Legal Advisor',
    intro: 'Внешний советник. Скептичен к обещаниям, смотрит на защищаемость схемы и минимизацию серых зон.',
    archetype: 'legal',
    tone: 'external-legal',
    cards: [
      {
        card_id: 'external-legal-card-1',
        signal_type: 'OUTSIDE_COUNSEL_CHECK',
        heat: 'hot',
        outreach_window: '7 дней',
        contact: { name: 'David Schmidt', title: 'Внешний юридический советник', linkedin: 'linkedin.com/in/david-schmidt-law' },
        company: { name: 'Westline Commerce', industry: 'eCommerce', size: '260 сотрудников', hq: 'Munich', founded_year: 2016, latest_event: 'Внешнего юриста попросили проверить схему подрядчиков и выплат перед выходом на новый рынок.' },
        what_happened: 'Внешний юрист пришёл на короткую проверку текущей схемы подрядчиков и быстро увидел слишком много ручных слоёв и слабую объяснимость.',
        apollo_context: [
          'Внешний советник не станет внутренним сторонником, но может усилить или убить сделку',
          'Нужны точные формулировки по зоне контроля и процессным safeguards',
          'Любая маркетинговая вата сразу режет доверие'
        ],
        target_profile: 'H',
        probable_pain: 'Схема работы с подрядчиками и выплатами выглядит недостаточно защищаемой перед внешней проверкой',
        recommended_product: 'CoR',
        recommended_channel: 'email + короткий созвон',
        first_touch_hint: 'Говори как со скептичным внешним советником: что контролируется, что нет, где остаётся прозрачный след операций.',
        dont_do: ['Не пытайся очаровывать вместо аргументов', 'Не обещай юридической определённости вне своей зоны ответственности'],
        rendered_text: 'Сигнал: внешний юридический советник подключён к проверке схемы подрядчиков и выплат и уже видит хрупкую смесь посредников и ручных исключений. Разговор держится на защищаемости, прослеживаемости и границах ответственности.'
      },
      {
        card_id: 'external-legal-card-2',
        signal_type: 'LEGAL_REVIEW_TRIGGER',
        heat: 'hot',
        outreach_window: '5 дней',
        contact: { name: 'David Schmidt', title: 'Внешний юридический советник', linkedin: 'linkedin.com/in/david-schmidt-law' },
        company: { name: 'Steelway Commerce', industry: 'eCommerce', size: '310 сотрудников', hq: 'Frankfurt', founded_year: 2016, latest_event: 'Внешний юрист нашёл непоследовательность в платёжной цепочке подрядчиков во время проверки расширения.' },
        what_happened: 'При проверке новой юрисдикции внешний юрист обнаружил несоответствия между тем, как классифицируются подрядчики, и реальной схемой выплат.',
        apollo_context: [
          'Расширение в NL и UK, договорная база устарела',
          'Внешний юрист видит несоответствие между классификацией и реальным платёжным процессом',
          'Любая маркетинговая вата немедленно снижает доверие'
        ],
        target_profile: 'H',
        probable_pain: 'Несоответствие между классификацией подрядчиков и реальным платёжным процессом создаёт регуляторный риск',
        recommended_product: 'CoR',
        recommended_channel: 'email + короткий созвон',
        first_touch_hint: 'Говори точно: что конкретно контролирует Mellow, где остаётся прозрачный след операций, где проходит граница ответственности.',
        dont_do: ['Не обещай юридической определённости', 'Не уходи в маркетинговые тезисы'],
        rendered_text: 'Сигнал: внешний юридический советник во время проверки расширения нашёл несоответствие между классификацией подрядчиков и реальной схемой выплат у Steelway Commerce. Разговор держится на точных формулировках, прозрачном следе операций и границах ответственности.'
      }
    ]
  }
};

function loadPromptLibrary() {
  try {
    const markdown = fs.readFileSync(promptArtifactsFile, 'utf8');
    const matches = [...markdown.matchAll(/##\s+\d+\.\s+System Prompt\s+—\s+`([^`]+)`\s+[\s\S]*?```text\n([\s\S]*?)```/g)];
    return Object.fromEntries(matches.map(([, id, prompt]) => [id, prompt.trim()]));
  } catch {
    return {};
  }
}

const PROMPT_LIBRARY = loadPromptLibrary();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizePersonaId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeRequiredFields(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((field, index) => {
      const id = sanitizePersonaId(field?.id || field?.label || `field_${index + 1}`) || `field_${index + 1}`;
      const label = String(field?.label || id).trim().slice(0, 120);
      const kind = ['text', 'textarea', 'number', 'select'].includes(field?.kind) ? field.kind : 'text';
      const helpText = String(field?.helpText || '').trim().slice(0, 240);
      const required = field?.required !== false;
      return label ? { id, label, kind, required, helpText } : null;
    })
    .filter(Boolean);
}

function promptLine(prompt, pattern) {
  const match = String(prompt || '').match(pattern);
  return match?.[1]?.trim() || '';
}

function extractPromptDraft(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) return {};
  const role = promptLine(text, /Роль:\s*([^\n]+)/i) || promptLine(text, /Role:\s*([^\n]+)/i);
  const name = promptLine(text, /Имя:\s*([^\n]+)/i) || promptLine(text, /Name:\s*([^\n]+)/i);
  const intro = promptLine(text, /Ты\s+—\s*([^\.\n]+\.?)/i) || promptLine(text, /You are\s+([^\.\n]+\.?)/i);
  const styleBlock = text.match(/КАК ТЫ ГОВОРИШЬ\s*\n([\s\S]*?)(?:\n\n[A-ZА-ЯЁ]|$)/i)?.[1] || text.match(/HOW YOU SPEAK\s*\n([\s\S]*?)(?:\n\n[A-ZА-ЯЁ]|$)/i)?.[1] || '';
  const styleLines = styleBlock
    .split('\n')
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const objectionBlock = text.match(/ПРИОРИТЕТ ВОЗРАЖЕНИЙ\s*\n([\s\S]*?)(?:\n\n[A-ZА-ЯЁ]|$)/i)?.[1] || text.match(/OBJECTION PRIORITY\s*\n([\s\S]*?)(?:\n\n[A-ZА-ЯЁ]|$)/i)?.[1] || '';
  const objections = objectionBlock
    .split('\n')
    .map((line) => line.replace(/^[-\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 5);
  return {
    name,
    role,
    intro: [intro, styleLines[0]].filter(Boolean).join(' '),
    styleLines,
    objections
  };
}

function defaultRequiredFieldsTemplate() {
  const firstBuiltinWithFields = Object.values(BUILTIN_PERSONAS).find((persona) => Array.isArray(persona?.required_fields) && persona.required_fields.length);
  if (firstBuiltinWithFields?.required_fields?.length) return clone(firstBuiltinWithFields.required_fields);
  return [
    { id: 'company', label: 'Company context', kind: 'text', required: true, helpText: 'What company this is and why the signal is relevant.' },
    { id: 'pain', label: 'Pain hypothesis', kind: 'textarea', required: true, helpText: 'The real pain or risk that opens the conversation.' }
  ];
}

function synthesizePromptFromPersona(persona = {}, builtin = {}) {
  const source = persona?.cards?.[0] || builtin?.cards?.[0] || {};
  const name = persona?.name || builtin?.name || 'Unknown persona';
  const role = persona?.role || builtin?.role || 'Persona';
  const intro = persona?.intro || builtin?.intro || 'Realistic buyer persona for a sales simulation.';
  const company = source.company || {};
  const objections = (persona?.prompt_objections || []).length
    ? persona.prompt_objections
    : [source.first_touch_hint, ...(source.dont_do || [])].filter(Boolean).slice(0, 4);
  const contextLines = [
    company.name ? `- Company: ${company.name}, ${company.industry || 'technology'}, ${company.size || 'distributed team'}` : '',
    source.what_happened ? `- Trigger: ${source.what_happened}` : '',
    source.probable_pain ? `- Core pain: ${source.probable_pain}` : '',
    ...(source.apollo_context || []).slice(0, 3).map((item) => `- ${item}`)
  ].filter(Boolean);

  return [
    'ТЫ — ПЕРСОНАЖ СИМУЛЯЦИИ ПРОДАЖ MELLOW.',
    '',
    `Имя: ${name}.`,
    `Роль: ${role}.`,
    '',
    'ТВОЯ ЗАДАЧА',
    intro,
    'Ты не помогаешь продавцу. Ты ведёшь себя как реальный покупатель и держишь разговор в рамках своего рабочего контекста.',
    '',
    'КОНТЕКСТ',
    ...contextLines,
    '',
    'КАК ТЫ ГОВОРИШЬ',
    '- Коротко.',
    '- Конкретно.',
    '- Не принимаешь marketing slang и overclaiming.',
    '',
    'ПРИОРИТЕТ ВОЗРАЖЕНИЙ',
    ...objections.map((item, index) => `${index + 1}. ${item}`),
    '',
    'ПРАВИЛА СИМУЛЯЦИИ',
    '- Сначала проверяешь качество захода и контекст.',
    '- Если продавец конкретен, постепенно открываешься к next step.',
    '- Если продавец обещает лишнее или звучит шаблонно, доверие падает.',
  ].join('\n').trim();
}

function deriveConcernOrderFromPrompt(prompt = '', fallback = []) {
  const lower = String(prompt || '').toLowerCase();
  if (!lower) return fallback;
  const ordered = [];
  const push = (key, markers) => {
    if (!ordered.includes(key) && markers.some((marker) => lower.includes(marker))) ordered.push(key);
  };
  push('scope', ['что конкретно вы контролируете', 'где заканчивается ваша ответственность', 'границы ответственности']);
  push('why_change', ['зачем менять', 'зачем мне что-то менять', 'что я за это получаю']);
  push('op_value', ['операционный апгрейд', 'меньше ручной возни', 'скорость', 'удобство']);
  push('sla', ['есть ли sla', 'что происходит если платёж застрянет', 'что происходит если платеж застрянет']);
  push('cost', ['сколько это будет стоить', 'дороже', 'цена']);
  push('geo_tax', ['ндфл', 'российскими выплатами', 'российским паспорт']);
  return [...ordered, ...fallback.filter((item) => !ordered.includes(item))];
}

function normalizeCard(card, personaId, index) {
  const fallbackId = `${personaId}-card-${index + 1}`;
  const company = card?.company || {};
  const contact = card?.contact || {};
  return {
    card_id: String(card?.card_id || fallbackId).trim() || fallbackId,
    signal_type: String(card?.signal_type || 'PAIN_SIGNAL').trim() || 'PAIN_SIGNAL',
    heat: ['hot', 'warm', 'cold'].includes(String(card?.heat || '').toLowerCase()) ? String(card.heat).toLowerCase() : 'warm',
    outreach_window: String(card?.outreach_window || '7 дней').trim() || '7 дней',
    contact: {
      name: String(contact.name || '').trim() || 'New Contact',
      title: String(contact.title || '').trim() || 'Decision maker',
      linkedin: String(contact.linkedin || '').trim()
    },
    company: {
      name: String(company.name || '').trim() || 'NewCo',
      industry: String(company.industry || '').trim() || 'Technology',
      size: String(company.size || '').trim() || '50 сотрудников',
      hq: String(company.hq || '').trim() || 'Remote',
      founded_year: Number.isFinite(Number(company.founded_year)) ? Number(company.founded_year) : new Date().getUTCFullYear(),
      latest_event: String(company.latest_event || '').trim() || 'Команда ищет более управляемый contractor flow.'
    },
    what_happened: String(card?.what_happened || '').trim() || 'Есть операционный или контрольный сбой в текущем contractor flow.',
    apollo_context: normalizeArray(card?.apollo_context),
    target_profile: String(card?.target_profile || '').trim() || 'A',
    probable_pain: String(card?.probable_pain || '').trim() || 'Ручная нагрузка и слабая управляемость процесса.',
    recommended_product: String(card?.recommended_product || '').trim() || 'CM',
    recommended_channel: String(card?.recommended_channel || '').trim() || 'email',
    first_touch_hint: String(card?.first_touch_hint || '').trim() || 'Зайди через конкретный операционный контекст и не обещай лишнего.',
    dont_do: normalizeArray(card?.dont_do),
    rendered_text: String(card?.rendered_text || '').trim() || 'Сигнал: у компании есть pain в contractor/payment flow, который стоит открыть через конкретный рабочий контекст.'
  };
}

function normalizePersona(persona, fallbackId) {
  const id = sanitizePersonaId(persona?.id || fallbackId || persona?.name) || `persona_${crypto.randomUUID().slice(0, 8)}`;
  const builtin = BUILTIN_PERSONAS[id] || {};
  const systemPrompt = String(persona?.system_prompt || persona?.systemPrompt || builtin?.system_prompt || PROMPT_LIBRARY[id] || synthesizePromptFromPersona(persona, builtin) || '').trim();
  const promptDraft = extractPromptDraft(systemPrompt);
  const signals = Array.isArray(persona?.cards) && persona.cards.length
    ? persona.cards.map((card, index) => normalizeCard(card, id, index))
    : Array.isArray(builtin?.cards) && builtin.cards.length
    ? builtin.cards.map((card, index) => normalizeCard(card, id, index))
    : [normalizeCard({}, id, 0)];
  const requiredFields = normalizeRequiredFields(persona?.required_fields || persona?.requiredFields);
  const archetype = String(persona?.archetype || builtin?.archetype || 'custom').trim() || 'custom';
  const canonicalPersonaId = getCanonicalPersonaId(id);
  const mergedInto = persona?.merged_into || builtin?.merged_into || (canonicalPersonaId !== id ? canonicalPersonaId : null);
  return {
    id,
    name: String(persona?.name || promptDraft.name || builtin?.name || id).trim() || id,
    role: String(persona?.role || promptDraft.role || builtin?.role || 'Persona').trim() || 'Persona',
    intro: String(persona?.intro || promptDraft.intro || builtin?.intro || '').trim() || 'New persona for sales training.',
    archetype,
    doctrine_family: String(persona?.doctrine_family || builtin?.doctrine_family || getDoctrineFamilyForPersonaId(id, archetype)).trim(),
    tone: String(persona?.tone || builtin?.tone || 'balanced').trim() || 'balanced',
    system_prompt: systemPrompt,
    email_prompt: String(persona?.email_prompt || builtin?.email_prompt || '').trim(),
    prompt_style: promptDraft.styleLines,
    prompt_objections: promptDraft.objections,
    required_fields: requiredFields.length ? requiredFields : defaultRequiredFieldsTemplate(),
    cards: signals,
    merged_into: mergedInto,
    deprecated: Boolean(persona?.deprecated || builtin?.deprecated || mergedInto)
  };
}

function normalizeDialogueType(value) {
  return String(value || '').trim().toLowerCase() === 'email' ? 'email' : 'messenger';
}

function getDoctrineFamilyForPersonaId(personaId = '', archetype = '') {
  if (['rate_floor_cfo', 'fx_trust_shock_finance', 'cfo_round', 'head_finance'].includes(personaId) || archetype === 'finance') return 'finance';
  if (['panic_churn_ops', 'grey_pain_switcher'].includes(personaId)) return 'ops_recovery';
  if (['cm_winback', 'direct_contract_transition'].includes(personaId)) return 'transition_winback';
  if (archetype === 'legal') return 'legal';
  return 'custom';
}

function getDoctrineFamilyLabel(family = '') {
  return {
    finance: 'Finance',
    ops_recovery: 'Ops / recovery',
    transition_winback: 'Transition / winback',
    legal: 'Legal',
    custom: 'Custom',
  }[family] || 'Custom';
}

const PERSONA_CANONICAL_MAP = {
  direct_contract_transition: 'cm_winback',
};

function getCanonicalPersonaId(personaId = '') {
  return PERSONA_CANONICAL_MAP[personaId] || personaId;
}

function isDeprecatedPersona(persona = null) {
  return Boolean(persona?.deprecated || persona?.merged_into);
}

const DEFAULT_SIDE_DOCTRINES = {
  demand: {
    id: 'demand',
    label: 'Demand side',
    description: 'Corporate buyers selecting Mellow as business infrastructure.',
    objective: 'Simulate business-side buying conversations for companies evaluating Mellow products.',
    value_frame: 'Operational reliability, ownership clarity, compliance infrastructure, and reduced manual burden.',
    success_criteria: ['Qualified next step with a business buyer', 'Fit-confirming call or review', 'No overclaiming beyond Mellow control'],
    tone_rules: ['Executive', 'Precise', 'Infrastructure-grade'],
    allowed_moves: ['signal-led opener', 'diagnostic question', 'bounded proof', 'bounded next step'],
    forbidden_moves: ['consumer language', 'lifestyle pitch', 'broad generic demo invite']
  },
  supply: {
    id: 'supply',
    label: 'Supply side',
    description: 'Independent contractors and small teams using Mellow to find work and get paid globally.',
    objective: 'Simulate contractor-side conversations where the user evaluates Mellow as growth and monetization infrastructure.',
    value_frame: 'Project access, income activation, cross-border simplicity, and contractor control.',
    success_criteria: ['Activation next step', 'Product fit confirmation', 'Low-friction continuation into onboarding or usage'],
    tone_rules: ['Clear', 'Useful', 'Low-bureaucracy'],
    allowed_moves: ['practical clarification', 'utility proof', 'activation prompt'],
    forbidden_moves: ['enterprise procurement language', 'heavy compliance opener', 'unnecessary formality']
  }
};

const DEFAULT_PRODUCT_DOCTRINES = {
  scout: {
    id: 'scout', side: 'demand', label: 'Scout', description: 'AI contractor sourcing for business-side project leaders.',
    objective: 'Help buyers assess whether Scout reduces sourcing time and improves shortlist quality.',
    value_frame: 'Manager time compression, shortlist quality, sourcing delegation, and project speed.',
    proof_policy: ['scoring logic', 'speed to shortlist', 'quality of candidates', 'delegation economics'],
    ask_policy: ['request review', 'calibration call', 'trial request'],
    success_criteria: ['Agreement to review sourcing fit', 'Request submission or shortlist follow-up'],
    forbidden_moves: ['treat as HR ATS', 'promise hiring outcome certainty']
  },
  cm: {
    id: 'cm', side: 'demand', label: 'CM', description: 'Contractor Management for easy-geo contractor operations.',
    objective: 'Show how CM reduces contractor admin and creates a cleaner operating layer.',
    value_frame: 'Operational visibility, cleaner workflows, lower admin load, and migration path to CoR where needed.',
    proof_policy: ['workflow simplification', 'visibility', 'time saved', 'cleaner contractor management'],
    ask_policy: ['workflow review', 'fit call', 'light implementation review'],
    success_criteria: ['Agreement to workflow review or product walkthrough'],
    forbidden_moves: ['sell as CoR', 'lead with fear instead of workflow value']
  },
  cor: {
    id: 'cor', side: 'demand', label: 'CoR', description: 'Contractor of Record for cross-border contractor payments and control.',
    objective: 'Qualify and convert business buyers around reliability, boundary clarity, and payment/control infrastructure.',
    value_frame: 'Reliability, ownership, auditability, and hard-geo payment infrastructure.',
    proof_policy: ['case snippet', 'one-screen proof', 'calculator snapshot'],
    ask_policy: ['bounded review call', 'written proof first', 'narrow next step'],
    success_criteria: ['Agreement to review call or concrete next step'],
    forbidden_moves: ['promise misclassification protection', 'generic fintech pitch']
  },
  radar: {
    id: 'radar', side: 'supply', label: 'Radar', description: 'Contractor-side project discovery and career agent.',
    objective: 'Help contractors see Radar as a useful acquisition layer for finding relevant projects.',
    value_frame: 'Project discovery, relevance, speed, and contractor-side opportunity visibility.',
    proof_policy: ['relevance', 'time saved', 'signal quality', 'fit of projects'],
    ask_policy: ['activation step', 'signup', 'profile completion'],
    success_criteria: ['Activation step or product try'],
    forbidden_moves: ['enterprise procurement framing', 'treat like CoR pitch']
  },
  global_invoicing: {
    id: 'global_invoicing', side: 'supply', label: 'Global Invoicing', description: 'Cross-border invoicing and payment infrastructure for contractors and small teams.',
    objective: 'Show contractors and teamlancers how Mellow helps them invoice and get paid globally with less friction.',
    value_frame: 'Get paid globally, simplify invoicing, reduce operational drag, improve income legitimacy.',
    proof_policy: ['payment flow clarity', 'cross-border ease', 'time saved', 'income regularity'],
    ask_policy: ['onboarding review', 'activation step', 'trial setup'],
    success_criteria: ['Agreement to try or review onboarding'],
    forbidden_moves: ['treat like enterprise finance sale']
  }
};

const DEFAULT_SIGNAL_TYPE_DOCTRINES = {
  category_confusion: {
    id: 'category_confusion', side: 'demand', product: 'cor', label: 'Category confusion',
    description: 'The buyer does not yet place Mellow cleanly and needs category clarity before deeper evaluation.',
  },
  churn_signal: {
    id: 'churn_signal', side: 'demand', product: 'cor', label: 'Trust-break recovery',
    description: 'A prior failure, late communication, or service shock created an active recovery and trust-repair conversation.',
  },
  competitor_price_objection: {
    id: 'competitor_price_objection', side: 'demand', product: 'cor', label: 'Competitor price objection',
    description: 'A cheaper competitor frame is dominating and forcing value defense beyond headline price.',
  },
  compliance_pressure: {
    id: 'compliance_pressure', side: 'demand', product: 'cor', label: 'Compliance pressure (finance / review)',
    description: 'Finance, investor, or review-driven scrutiny around contractor setup and payment flow before a major check.',
  },
  compliance_switch: {
    id: 'compliance_switch', side: 'demand', product: 'cor', label: 'Compliance switch (after grey provider)',
    description: 'A prior grey-provider or weak-structure experience is forcing a safer, more defensible replacement path.',
  },
  direct_contract_need: {
    id: 'direct_contract_need', side: 'demand', product: 'cor', label: 'Direct contract need',
    description: 'The buyer needs a narrower direct-contract or roster-slice transition path.',
  },
  finance_control_gap: {
    id: 'finance_control_gap', side: 'demand', product: 'cor', label: 'Finance control gap',
    description: 'Finance lacks visibility, control, or trust in the current payment process.',
  },
  fundraising_diligence: {
    id: 'fundraising_diligence', side: 'demand', product: 'cor', label: 'Post-round diligence',
    description: 'Investor or diligence pressure is forcing the operating model into focus.',
  },
  fx_transparency: {
    id: 'fx_transparency', side: 'demand', product: 'cor', label: 'FX transparency gap',
    description: 'Foreign exchange logic or total-cost visibility is unclear and creating hesitation.',
  },
  legal_review_trigger: {
    id: 'legal_review_trigger', side: 'demand', product: 'cor', label: 'Legal review trigger',
    description: 'Counsel or internal legal is reviewing the contractor and payments contour.',
  },
  operations_overload: {
    id: 'operations_overload', side: 'demand', product: 'cor', label: 'Ops overload',
    description: 'The current process is too manual and unstable for the team to carry.',
  },
  outside_counsel_check: {
    id: 'outside_counsel_check', side: 'demand', product: 'cor', label: 'Outside counsel check',
    description: 'External legal review is pressuring the buyer to tighten scope and defensibility.',
  },
  pain_signal: {
    id: 'pain_signal', side: 'demand', product: 'cor', label: 'Operational payment failure',
    description: 'A concrete payout failure, delay, or operational breakdown already happened.',
  },
  post_onboarding_risk: {
    id: 'post_onboarding_risk', side: 'demand', product: 'cor', label: 'Post-onboarding economics / control risk',
    description: 'After onboarding, the buyer experienced an economics, FX, or control shock and now needs explanation and trust repair.',
  },
  rate_pressure: {
    id: 'rate_pressure', side: 'demand', product: 'cor', label: 'Rate pressure',
    description: 'Commercial pressure around rate, premium, or pricing justification is dominating the conversation.',
  },
  re_engagement_signal: {
    id: 're_engagement_signal', side: 'demand', product: 'cor', label: 'Re-engagement signal',
    description: 'A previously stalled account is back in motion through an event or new operating trigger and can be reopened via a narrower fit signal.',
  },
  sanctions_stress: {
    id: 'sanctions_stress', side: 'demand', product: 'cor', label: 'Sanctions stress',
    description: 'Geo, sanctions, or banking pressure is stressing the current contractor operating path.',
  },
  team_scaling: {
    id: 'team_scaling', side: 'demand', product: 'cor', label: 'Team scaling overload',
    description: 'Hiring or contractor growth is stretching the current operating contour.',
  },
  general: {
    id: 'general', side: 'demand', product: 'cor', label: 'General trigger',
    description: 'Fallback trigger when the specific signal type is not yet classified.',
  },
};

const SIGNAL_TYPE_ALIASES = {
  event_reengagement: 're_engagement_signal',
};

const DEFAULT_DIALOGUE_TYPE_DOCTRINES = {
  inbound: {
    id: 'inbound', label: 'Inbound', description: 'Buyer or user initiated or already expressed interest.',
    objective: 'Convert existing intent into a concrete qualified next step.',
    value_frame: 'Clarify fit quickly and remove friction to the next useful step.',
    tone_rules: ['More direct', 'Less context-setting', 'Assume existing intent'],
    allowed_moves: ['diagnose quickly', 'answer directly', 'move to bounded next step'],
    forbidden_moves: ['cold-outbound opener logic', 'unnecessary re-introduction']
  },
  outbound: {
    id: 'outbound', label: 'Outbound', description: 'Seller initiated based on signal or cold/warm trigger.',
    objective: 'Earn the right to continue through signal-led relevance and useful first contact.',
    value_frame: 'Value in the first touch, signal relevance, respectful pressure, and bounded asks.',
    tone_rules: ['Permission-aware', 'Signal-led', 'No generic pitch'],
    allowed_moves: ['signal opener', 'narrow diagnosis', 'bounded proof', 'light next step'],
    forbidden_moves: ['assume too much context', 'aggressive meeting push on turn 1']
  }
};

const DEFAULT_ENVIRONMENT_DOCTRINES = {
  messenger: {
    id: 'messenger', label: 'Messenger', description: 'Short-form conversational environment like chat or DM.',
    objective: 'Keep momentum in short turns with high specificity.',
    value_frame: 'Compression, relevance, and low-friction dialogue.',
    tone_rules: ['Short', 'Conversational', 'Compressed'],
    allowed_moves: ['single-point response', 'light ask', 'short proof'],
    forbidden_moves: ['email-style long paragraphs', 'multi-topic blocks']
  },
  email: {
    id: 'email', label: 'Email', description: 'Formal asynchronous written communication.',
    objective: 'Deliver a self-contained message with enough context to earn a reply.',
    value_frame: 'Structured clarity, explicit framing, and calm follow-through.',
    tone_rules: ['Formal', 'Self-contained', 'Paragraph-based'],
    allowed_moves: ['clear subject', 'structured paragraph', 'single concrete ask'],
    forbidden_moves: ['chat shorthand', 'fragmented replies'],
    email_additions: {
      tone_rules: ['Calm', 'Deliberate', 'Written-friendly'],
      structure_rules: ['open with context in sentence one', 'keep one thread per email', 'use short paragraphs', 'close with one bounded CTA'],
      subject_rules: ['specific not clever', 'reflect the real issue or review context', 'avoid vague follow-up subjects'],
      cta_rules: ['one bounded next step only', 'prefer review ask over broad meeting ask', 'do not stack multiple asks in one email'],
      proof_policy: ['self-contained written proof', 'concise evidence', 'written clarity before expansion'],
      forbidden_moves: ['messenger fragments', 'just checking in fluff', 'artificial urgency without signal justification']
    }
  }
};

const DEFAULT_GROUP_DOCTRINES = {
  finance: {
    id: 'finance', side: 'demand', product: 'cor', dialogue_types: ['outbound'], environments: ['messenger', 'email'],
    label: 'Finance', description: 'CFO / finance-led business buyers evaluating economics, control, and responsibility.',
    objective: 'Prove control, economics, and boundary clarity without overclaiming.',
    value_frame: 'Visible total cost, control boundary, auditability, incident path.',
    proof_policy: ['mechanics first', 'economics next', 'bounded written proof before broad ask when needed'],
    ask_policy: ['narrow finance review', 'written proof to review call'],
    success_criteria: ['Agreement to review call or written proof review'],
    forbidden_moves: ['generic compliance language', 'misclassification overclaim'],
    email_additions: {
      tone_rules: ['Executive written tone', 'Control-first framing'],
      structure_rules: ['state finance context early', 'separate mechanism from economics', 'keep proof review-friendly'],
      cta_rules: ['ask for short review slot or reply with comments', 'avoid casual chat-style CTA'],
      subject_rules: ['lead with control, audit, diligence, FX, or cost topic'],
      proof_policy: ['one-screen economics proof', 'auditability explanation', 'control boundary clarity']
    }
  },
  legal: {
    id: 'legal', side: 'demand', product: 'cor', dialogue_types: ['outbound'], environments: ['messenger', 'email'],
    label: 'Legal', description: 'Legal or counsel buyers focused on defensibility and scope.',
    objective: 'Demonstrate scope clarity, safeguards, and document trail.',
    value_frame: 'Defensibility, control zone, documentation, audit trail.',
    proof_policy: ['document boundary', 'control zone', 'process safeguards'],
    ask_policy: ['written review first', 'narrow legal review'],
    success_criteria: ['Agreement to review documentation or legal fit call'],
    forbidden_moves: ['broad promises', 'hand-wavy compliance claims'],
    email_additions: {
      tone_rules: ['Precise', 'Restrained', 'Document-oriented'],
      structure_rules: ['state boundary first', 'scope claims tightly', 'make document trail explicit'],
      cta_rules: ['offer memo or bounded review slot', 'ask for comments on written material'],
      subject_rules: ['reference review, scope, safeguards, or documentation'],
      proof_policy: ['document references', 'scope boundary', 'process safeguards in writing']
    }
  },
  ops_recovery: {
    id: 'ops_recovery', side: 'demand', product: 'cor', dialogue_types: ['outbound'], environments: ['messenger', 'email'],
    label: 'Ops / recovery', description: 'Operational buyers after payment failure or process instability.',
    objective: 'Show calmer operating model and recovery ownership.',
    value_frame: 'Operational relief, incident ownership, smoother workflow.',
    proof_policy: ['owner model', 'incident path', 'workflow relief'],
    ask_policy: ['narrow operational walkthrough'],
    success_criteria: ['Agreement to recovery-fit or workflow review'],
    forbidden_moves: ['finance-heavy pitch', 'generic product tour'],
    email_additions: {
      tone_rules: ['Operationally calm', 'Concrete', 'Low-drama'],
      structure_rules: ['summarize the operational issue quickly', 'show owner path and workflow change', 'keep the email short'],
      cta_rules: ['offer narrow workflow review', 'ask what part should be pressure-tested first'],
      subject_rules: ['reference incident, workflow, ops load, or recovery path'],
      proof_policy: ['owner model in writing', 'incident path summary', 'workflow simplification proof']
    }
  },
  transition_winback: {
    id: 'transition_winback', side: 'demand', product: 'cor', dialogue_types: ['outbound'], environments: ['messenger', 'email'],
    label: 'Transition / winback', description: 'Re-entry, transition, or narrow-slice reconsideration.',
    objective: 'Rebuild fit around a narrow slice without reopening the whole old story.',
    value_frame: 'Safer slice, narrower move, cleaner ownership.',
    proof_policy: ['slice fit', 'transition safety', 'owner model'],
    ask_policy: ['bounded slice review'],
    success_criteria: ['Agreement to narrow review of a new slice'],
    forbidden_moves: ['broad comeback pitch', 'pretend history did not happen'],
    email_additions: {
      tone_rules: ['Measured', 'Respectful of history', 'Non-pushy'],
      structure_rules: ['acknowledge prior context early', 'propose one narrow new slice', 'avoid restart rhetoric'],
      cta_rules: ['invite a narrow re-check or written reaction', 'do not ask for full relaunch discussion'],
      subject_rules: ['reference specific slice, transition path, or narrower fit'],
      proof_policy: ['slice-specific proof', 'transition safety in writing', 'ownership clarity']
    }
  },
  custom: {
    id: 'custom', side: 'demand', product: 'cor', dialogue_types: ['outbound'], environments: ['messenger', 'email'],
    label: 'Custom', description: 'Profiles outside the main doctrinal families.',
    objective: 'Keep a clean scenario-specific buyer logic without forcing it into a wrong family.',
    value_frame: 'Scenario fit, concrete relevance, respectful next step.',
    proof_policy: ['context-specific proof'],
    ask_policy: ['bounded next step'],
    success_criteria: ['Scenario-fit next step'],
    forbidden_moves: ['force into wrong doctrine family']
  },
  supply_activation: {
    id: 'supply_activation', side: 'supply', product: 'radar', dialogue_types: ['inbound', 'outbound'], environments: ['messenger', 'email'],
    label: 'Supply activation', description: 'Contractor-side activation and relevance group for Radar.',
    objective: 'Help a contractor see immediate utility and activate the product.',
    value_frame: 'Relevant opportunities, low-friction activation, career momentum.',
    proof_policy: ['relevance', 'fit of projects', 'time saved'],
    ask_policy: ['activation prompt'],
    success_criteria: ['Activation step'],
    forbidden_moves: ['enterprise buyer logic']
  },
  supply_invoicing: {
    id: 'supply_invoicing', side: 'supply', product: 'global_invoicing', dialogue_types: ['inbound', 'outbound'], environments: ['messenger', 'email'],
    label: 'Supply invoicing', description: 'Contractor-side invoicing and getting-paid scenarios.',
    objective: 'Move the user toward onboarding and first payment flow understanding.',
    value_frame: 'Cross-border invoicing clarity, payment simplicity, contractor control.',
    proof_policy: ['payment flow clarity', 'onboarding simplicity'],
    ask_policy: ['onboarding review', 'activation step'],
    success_criteria: ['Onboarding or try step'],
    forbidden_moves: ['enterprise procurement framing']
  }
};

function normalizeDoctrineFieldList(value, fallback = []) {
  const list = Array.isArray(value) ? value : fallback;
  return list.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeDoctrineEmailAdditions(value, fallback = {}) {
  const merged = { ...(fallback || {}), ...((value && typeof value === 'object') ? value : {}) };
  return {
    objective: String(merged.objective || '').trim(),
    value_frame: String(merged.value_frame || '').trim(),
    proof_policy: normalizeDoctrineFieldList(merged.proof_policy, fallback.proof_policy || []),
    ask_policy: normalizeDoctrineFieldList(merged.ask_policy, fallback.ask_policy || []),
    tone_rules: normalizeDoctrineFieldList(merged.tone_rules, fallback.tone_rules || []),
    allowed_moves: normalizeDoctrineFieldList(merged.allowed_moves, fallback.allowed_moves || []),
    forbidden_moves: normalizeDoctrineFieldList(merged.forbidden_moves, fallback.forbidden_moves || []),
    structure_rules: normalizeDoctrineFieldList(merged.structure_rules, fallback.structure_rules || []),
    subject_rules: normalizeDoctrineFieldList(merged.subject_rules, fallback.subject_rules || []),
    cta_rules: normalizeDoctrineFieldList(merged.cta_rules, fallback.cta_rules || []),
  };
}

const PLAYBOOK_STAGE_ORDER = ['mechanics_engaged', 'economics_engaged', 'written_step_requested', 'written_step_accepted', 'written_step_then_call', 'review_call_ready'];

function normalizePlaybookStageEntry(entry, fallbackStage = 'mechanics_engaged') {
  const stage = String(entry?.stage || fallbackStage).trim() || fallbackStage;
  return {
    stage,
    seller_behavior: String(entry?.seller_behavior || '').trim(),
    tone_of_voice: String(entry?.tone_of_voice || '').trim(),
  };
}

function normalizePlaybookSignalEntry(entry, fallbackSignal = 'general') {
  const signalType = normalizeSignalTypeId(entry?.signal_type || fallbackSignal || 'general');
  return {
    signal_type: signalType,
    conversation_initiation: String(entry?.conversation_initiation || '').trim(),
  };
}

function normalizePlaybookRecord(record, kind = 'doctrine') {
  const personaMode = ['general', 'group', 'persona'].includes(String(record?.persona_mode || '').trim())
    ? String(record.persona_mode).trim()
    : record?.persona_id ? 'persona' : record?.group_id ? 'group' : 'general';
  return {
    id: String(record?.id || '').trim() || crypto.randomUUID(),
    side: String(record?.side || 'demand').trim() || 'demand',
    product: String(record?.product || 'cor').trim() || 'cor',
    sales_type: String(record?.sales_type || 'outbound').trim() || 'outbound',
    environment: String(record?.environment || 'messenger').trim() || 'messenger',
    persona_mode: personaMode,
    group_id: personaMode === 'group' ? String(record?.group_id || '').trim() : '',
    persona_id: personaMode === 'persona' ? getCanonicalPersonaId(String(record?.persona_id || '').trim()) : '',
    signal_type: normalizeSignalTypeId(record?.signal_type || 'general'),
    stages: kind === 'doctrine'
      ? PLAYBOOK_STAGE_ORDER.map((stage) => {
          const current = (Array.isArray(record?.stages) ? record.stages : []).find((item) => String(item?.stage || '').trim() === stage);
          return normalizePlaybookStageEntry(current, stage);
        })
      : [],
    entries: kind === 'signals'
      ? (Array.isArray(record?.entries) ? record.entries : []).map((entry) => normalizePlaybookSignalEntry(entry)).filter(Boolean)
      : [],
    updated_at: String(record?.updated_at || '').trim() || null,
  };
}

function normalizeDoctrinePlaybooks(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  return {
    doctrine_records: Array.isArray(safe.doctrine_records) ? safe.doctrine_records.map((record) => normalizePlaybookRecord(record, 'doctrine')) : [],
    signal_records: Array.isArray(safe.signal_records) ? safe.signal_records.map((record) => normalizePlaybookRecord(record, 'signals')) : [],
  };
}

function normalizeDoctrineRecord(record, fallback = {}) {
  const merged = { ...fallback, ...(record || {}) };
  return {
    ...merged,
    id: String(merged.id || fallback.id || '').trim(),
    label: String(merged.label || '').trim(),
    description: String(merged.description || '').trim(),
    objective: String(merged.objective || '').trim(),
    value_frame: String(merged.value_frame || '').trim(),
    proof_policy: normalizeDoctrineFieldList(merged.proof_policy, fallback.proof_policy || []),
    ask_policy: normalizeDoctrineFieldList(merged.ask_policy, fallback.ask_policy || []),
    success_criteria: normalizeDoctrineFieldList(merged.success_criteria, fallback.success_criteria || []),
    tone_rules: normalizeDoctrineFieldList(merged.tone_rules, fallback.tone_rules || []),
    allowed_moves: normalizeDoctrineFieldList(merged.allowed_moves, fallback.allowed_moves || []),
    forbidden_moves: normalizeDoctrineFieldList(merged.forbidden_moves, fallback.forbidden_moves || []),
    email_additions: normalizeDoctrineEmailAdditions(merged.email_additions, fallback.email_additions || {}),
  };
}

function mergeDoctrineList(...lists) {
  return [...new Set(lists.flat().map((item) => String(item || '').trim()).filter(Boolean))];
}

function mergeDoctrineEmailAdditions(base = {}, patch = {}) {
  const next = patch && typeof patch === 'object' ? patch : {};
  return {
    objective: String(next.objective || base.objective || '').trim(),
    value_frame: String(next.value_frame || base.value_frame || '').trim(),
    proof_policy: mergeDoctrineList(base.proof_policy || [], next.proof_policy || []),
    ask_policy: mergeDoctrineList(base.ask_policy || [], next.ask_policy || []),
    tone_rules: mergeDoctrineList(base.tone_rules || [], next.tone_rules || []),
    allowed_moves: mergeDoctrineList(base.allowed_moves || [], next.allowed_moves || []),
    forbidden_moves: mergeDoctrineList(base.forbidden_moves || [], next.forbidden_moves || []),
    structure_rules: mergeDoctrineList(base.structure_rules || [], next.structure_rules || []),
    subject_rules: mergeDoctrineList(base.subject_rules || [], next.subject_rules || []),
    cta_rules: mergeDoctrineList(base.cta_rules || [], next.cta_rules || []),
  };
}

function compileDoctrineForSession(session = null) {
  const scenario = inferScenarioSelection(session);
  const personaId = getCanonicalPersonaId(session?.bot_id || scenario.profile || '');
  const profile = doctrineProfileForPersona(personaId) || {};
  const stack = [
    doctrineConfig?.sides?.[scenario.side || profile.side || 'demand'],
    doctrineConfig?.products?.[scenario.product || profile.product || 'cor'],
    doctrineConfig?.signal_types?.[scenario.signal_type || 'general'],
    doctrineConfig?.dialogue_types?.[normalizeDialogueType(session?.dialogue_type || scenario.dialogue_type || 'messenger')],
    doctrineConfig?.environments?.[scenario.environment || normalizeDialogueType(session?.dialogue_type || 'messenger')],
    doctrineConfig?.groups?.[scenario.group || profile.group_id || 'custom'],
    profile,
  ].filter(Boolean);

  const compiled = stack.reduce((acc, layer) => ({
    objective: String(layer.objective || acc.objective || '').trim(),
    value_frame: String(layer.value_frame || acc.value_frame || '').trim(),
    proof_policy: mergeDoctrineList(acc.proof_policy || [], layer.proof_policy || []),
    ask_policy: mergeDoctrineList(acc.ask_policy || [], layer.ask_policy || []),
    success_criteria: mergeDoctrineList(acc.success_criteria || [], layer.success_criteria || []),
    tone_rules: mergeDoctrineList(acc.tone_rules || [], layer.tone_rules || []),
    allowed_moves: mergeDoctrineList(acc.allowed_moves || [], layer.allowed_moves || []),
    forbidden_moves: mergeDoctrineList(acc.forbidden_moves || [], layer.forbidden_moves || []),
    email_additions: mergeDoctrineEmailAdditions(acc.email_additions || {}, layer.email_additions || {}),
  }), { email_additions: {} });

  compiled.layers = stack.map((layer) => layer.id).filter(Boolean);
  compiled.environment = scenario.environment || normalizeDialogueType(session?.dialogue_type || 'messenger');
  if (compiled.environment === 'email') {
    compiled.objective = compiled.email_additions?.objective || compiled.objective || '';
    compiled.value_frame = compiled.email_additions?.value_frame || compiled.value_frame || '';
    compiled.proof_policy = mergeDoctrineList(compiled.proof_policy || [], compiled.email_additions?.proof_policy || []);
    compiled.ask_policy = mergeDoctrineList(compiled.ask_policy || [], compiled.email_additions?.ask_policy || []);
    compiled.tone_rules = mergeDoctrineList(compiled.tone_rules || [], compiled.email_additions?.tone_rules || []);
    compiled.allowed_moves = mergeDoctrineList(compiled.allowed_moves || [], compiled.email_additions?.allowed_moves || []);
    compiled.forbidden_moves = mergeDoctrineList(compiled.forbidden_moves || [], compiled.email_additions?.forbidden_moves || []);
  }
  return compiled;
}

function formatDoctrineGuidance(doctrine = {}, { includeEmail = false } = {}) {
  const lines = [];
  if (doctrine.objective) lines.push(`Objective: ${doctrine.objective}`);
  if (doctrine.value_frame) lines.push(`Value frame: ${doctrine.value_frame}`);
  if ((doctrine.proof_policy || []).length) lines.push(`Proof policy: ${(doctrine.proof_policy || []).join('; ')}`);
  if ((doctrine.ask_policy || []).length) lines.push(`Ask policy: ${(doctrine.ask_policy || []).join('; ')}`);
  if ((doctrine.tone_rules || []).length) lines.push(`Tone rules: ${(doctrine.tone_rules || []).join('; ')}`);
  if ((doctrine.allowed_moves || []).length) lines.push(`Allowed moves: ${(doctrine.allowed_moves || []).join('; ')}`);
  if ((doctrine.forbidden_moves || []).length) lines.push(`Forbidden moves: ${(doctrine.forbidden_moves || []).join('; ')}`);
  if (includeEmail && doctrine.email_additions) {
    if ((doctrine.email_additions.structure_rules || []).length) lines.push(`Email structure rules: ${doctrine.email_additions.structure_rules.join('; ')}`);
    if ((doctrine.email_additions.subject_rules || []).length) lines.push(`Email subject rules: ${doctrine.email_additions.subject_rules.join('; ')}`);
    if ((doctrine.email_additions.cta_rules || []).length) lines.push(`Email CTA rules: ${doctrine.email_additions.cta_rules.join('; ')}`);
  }
  return lines.join('\n');
}

function seedDoctrineConfig() {
  const profiles = {};
  for (const persona of Object.values(personas || {})) {
    if (isDeprecatedPersona(persona)) continue;
    profiles[persona.id] = {
      id: persona.id,
      label: persona.name,
      description: persona.intro || persona.role,
      side: 'demand',
      product: 'cor',
      dialogue_types: ['outbound'],
      environments: ['messenger', 'email'],
      group_id: persona.doctrine_family || getDoctrineFamilyForPersonaId(persona.id, persona.archetype || ''),
      role: persona.role,
      objective: 'Preserve the individual buyer behavior and objections of this profile.',
      value_frame: persona.intro || persona.role,
      tone_rules: normalizeDoctrineFieldList(persona.prompt_style || []),
      forbidden_moves: normalizeDoctrineFieldList(persona.prompt_objections || []),
    };
  }
  return {
    sides: DEFAULT_SIDE_DOCTRINES,
    products: DEFAULT_PRODUCT_DOCTRINES,
    signal_types: DEFAULT_SIGNAL_TYPE_DOCTRINES,
    dialogue_types: DEFAULT_DIALOGUE_TYPE_DOCTRINES,
    environments: DEFAULT_ENVIRONMENT_DOCTRINES,
    groups: DEFAULT_GROUP_DOCTRINES,
    profiles,
  };
}

function normalizeDoctrineConfig(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const normalizeMap = (source, defaults) => Object.fromEntries(
    Object.entries(defaults).map(([id, fallback]) => {
      const current = source?.[id] || {};
      const base = normalizeDoctrineRecord({ ...current, id }, { ...fallback, id });
      if ('side' in fallback || 'side' in current) base.side = String(current.side || fallback.side || '').trim();
      if ('product' in fallback || 'product' in current) base.product = String(current.product || fallback.product || '').trim();
      if ('group_id' in current) base.group_id = String(current.group_id || '').trim();
      if ('role' in current) base.role = String(current.role || '').trim();
      base.dialogue_types = normalizeDoctrineFieldList(current.dialogue_types, fallback.dialogue_types || []);
      base.environments = normalizeDoctrineFieldList(current.environments, fallback.environments || []);
      return [id, base];
    })
  );
  const defaults = seedDoctrineConfig();
  const profileIds = new Set([...Object.keys(defaults.profiles || {}), ...Object.keys(safe.profiles || {})]);
  const profiles = Object.fromEntries([...profileIds].map((id) => {
    const fallback = defaults.profiles?.[id] || { id, label: id, side: 'demand', product: 'cor', dialogue_types: ['outbound'], environments: ['messenger', 'email'], group_id: 'custom' };
    const current = safe.profiles?.[id] || {};
    const base = normalizeDoctrineRecord({ ...current, id }, fallback);
    base.side = String(current.side || fallback.side || 'demand').trim();
    base.product = String(current.product || fallback.product || 'cor').trim();
    base.group_id = String(current.group_id || fallback.group_id || 'custom').trim();
    base.role = String(current.role || fallback.role || '').trim();
    base.dialogue_types = normalizeDoctrineFieldList(current.dialogue_types, fallback.dialogue_types || ['outbound']);
    base.environments = normalizeDoctrineFieldList(current.environments, fallback.environments || ['messenger', 'email']);
    return [id, base];
  }));
  return {
    sides: normalizeMap(safe.sides, defaults.sides),
    products: normalizeMap(safe.products, defaults.products),
    signal_types: normalizeMap(safe.signal_types, defaults.signal_types),
    dialogue_types: normalizeMap(safe.dialogue_types, defaults.dialogue_types),
    environments: normalizeMap(safe.environments, defaults.environments),
    groups: normalizeMap(safe.groups, defaults.groups),
    profiles,
    playbooks: normalizeDoctrinePlaybooks(safe.playbooks),
  };
}

function doctrineProfileForPersona(personaId) {
  return doctrineConfig?.profiles?.[personaId] || null;
}

function enrichPersonaWithScenario(persona) {
  const profile = doctrineProfileForPersona(persona.id) || {};
  const groupId = profile.group_id || persona.doctrine_family || 'custom';
  const group = doctrineConfig?.groups?.[groupId] || null;
  return {
    ...persona,
    market_side: profile.side || 'demand',
    product: profile.product || 'cor',
    available_signal_types: [...new Set((persona.cards || []).map((card) => normalizeSignalTypeId(card?.signal_type)).filter(Boolean))],
    signal_types: Object.values(doctrineConfig?.signal_types || {}).filter((signal) => {
      if (signal.side && signal.side !== (profile.side || 'demand')) return false;
      if (signal.product && signal.product !== (profile.product || 'cor')) return false;
      return true;
    }).map((signal) => signal.id),
    dialogue_types: profile.dialogue_types?.length ? profile.dialogue_types : ['outbound'],
    environments: profile.environments?.length ? profile.environments : ['messenger', 'email'],
    group_id: groupId,
    group_label: group?.label || getDoctrineFamilyLabel(groupId),
    profile_label: profile.label || persona.name,
  };
}

function normalizeSignalTypeId(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'general';
  return SIGNAL_TYPE_ALIASES[normalized] || normalized;
}

function signalTypeVariants(value = '') {
  const raw = String(value || '').trim();
  const normalized = normalizeSignalTypeId(raw);
  return [...new Set([raw, normalized, raw.toUpperCase(), normalized.toUpperCase()].filter(Boolean))];
}

function inferScenarioSelection(session = null) {
  const personaId = getCanonicalPersonaId(session?.bot_id || '');
  const persona = personaId ? personas[personaId] : null;
  const enriched = persona ? enrichPersonaWithScenario(persona) : null;
  const existing = session?.scenario_selection || {};
  const signalType = existing.signal_type
    || normalizeSignalTypeId(session?.sde_card?.signal_type)
    || (enriched?.signal_types?.[0] || 'general');
  return {
    side: existing.side || enriched?.market_side || 'demand',
    product: existing.product || enriched?.product || 'cor',
    signal_type: signalType,
    dialogue_type: existing.dialogue_type || 'outbound',
    environment: existing.environment || normalizeDialogueType(session?.dialogue_type || 'messenger'),
    group: existing.group || enriched?.group_id || 'custom',
    profile: existing.profile || personaId || session?.bot_id || '',
  };
}

function normalizeSliceFilters(raw = {}) {
  const side = String(raw.side || 'demand').trim() || 'demand';
  const product = String(raw.product || 'cor').trim() || 'cor';
  const salesType = String(raw.sales_type || raw.salesType || raw.dialogue_type || 'outbound').trim() || 'outbound';
  const environment = normalizeDialogueType(raw.environment || raw.instrument || 'messenger');
  const personaMode = ['general', 'group', 'persona'].includes(String(raw.persona_mode || raw.personaMode || '').trim())
    ? String(raw.persona_mode || raw.personaMode).trim()
    : raw.persona_id || raw.personaId ? 'persona' : raw.group_id || raw.groupId ? 'group' : 'general';
  const groupId = personaMode === 'group' ? String(raw.group_id || raw.groupId || '').trim() : '';
  const personaId = personaMode === 'persona' ? getCanonicalPersonaId(String(raw.persona_id || raw.personaId || '').trim()) : '';
  const signalType = normalizeSignalTypeId(raw.signal_type || raw.signalType || 'general');
  return {
    side,
    product,
    sales_type: salesType,
    environment,
    persona_mode: personaMode,
    group_id: groupId,
    persona_id: personaId,
    signal_type: signalType,
  };
}

function sliceFilterKey(filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  return [
    normalized.side,
    normalized.product,
    normalized.sales_type,
    normalized.environment,
    normalized.persona_mode,
    normalized.group_id || 'general',
    normalized.persona_id || 'general',
    normalized.signal_type,
  ].join('::');
}

function firstPersonaForGroup(filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  return Object.values(personas || {})
    .filter((persona) => !isDeprecatedPersona(persona))
    .map((persona) => enrichPersonaWithScenario(persona))
    .find((persona) => {
      if (persona.market_side !== normalized.side) return false;
      if (persona.product !== normalized.product) return false;
      if (normalized.persona_mode === 'group' && (persona.group_id || 'custom') !== normalized.group_id) return false;
      return true;
    }) || null;
}

function compileDoctrineForFilters(filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  const personaId = normalized.persona_mode === 'persona' ? normalized.persona_id : '';
  const persona = personaId ? personas?.[personaId] : null;
  const fallbackPersona = !persona && normalized.persona_mode === 'group' ? firstPersonaForGroup(normalized) : null;
  const profile = doctrineProfileForPersona(personaId || fallbackPersona?.id || '') || {};
  const scenario = {
    side: normalized.side,
    product: normalized.product,
    signal_type: normalized.signal_type,
    dialogue_type: normalized.sales_type,
    environment: normalized.environment,
    group: normalized.persona_mode === 'group' ? normalized.group_id : (profile.group_id || fallbackPersona?.group_id || 'custom'),
    profile: personaId || fallbackPersona?.id || '',
  };
  const stack = [
    doctrineConfig?.sides?.[scenario.side || 'demand'],
    doctrineConfig?.products?.[scenario.product || 'cor'],
    doctrineConfig?.dialogue_types?.[scenario.dialogue_type || 'outbound'],
    doctrineConfig?.environments?.[scenario.environment || 'messenger'],
    doctrineConfig?.groups?.[scenario.group || 'custom'],
    doctrineConfig?.signal_types?.[scenario.signal_type || 'general'],
    profile,
  ].filter(Boolean);
  return stack.reduce((acc, layer) => ({
    objective: String(layer.objective || acc.objective || '').trim(),
    value_frame: String(layer.value_frame || acc.value_frame || '').trim(),
    proof_policy: mergeDoctrineList(acc.proof_policy || [], layer.proof_policy || []),
    ask_policy: mergeDoctrineList(acc.ask_policy || [], layer.ask_policy || []),
    tone_rules: mergeDoctrineList(acc.tone_rules || [], layer.tone_rules || []),
    forbidden_moves: mergeDoctrineList(acc.forbidden_moves || [], layer.forbidden_moves || []),
    layers: [...(acc.layers || []), layer.id].filter(Boolean),
  }), { layers: [] });
}

function playbookScopeLabel(filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  if (normalized.persona_mode === 'persona') {
    return personas?.[normalized.persona_id]?.name || normalized.persona_id || 'selected persona';
  }
  if (normalized.persona_mode === 'group') {
    return doctrineConfig?.groups?.[normalized.group_id]?.label || normalized.group_id || 'selected group';
  }
  return doctrineConfig?.products?.[normalized.product]?.label || normalized.product || 'selected slice';
}

function fallbackDoctrineStages(filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  const compiled = compileDoctrineForFilters(normalized);
  const signalLabel = doctrineConfig?.signal_types?.[normalized.signal_type]?.label || 'General signal';
  const scopeLabel = playbookScopeLabel(normalized);
  const toneLine = (compiled.tone_rules || []).slice(0, 3).join(', ') || 'Calm, specific, controlled.';
  const proofLine = (compiled.proof_policy || []).slice(0, 2).join(', ') || 'one concrete proof layer';
  const askLine = (compiled.ask_policy || []).slice(0, 2).join(', ') || 'one bounded next step';
  const valueFrame = compiled.value_frame || 'a concrete business reason to continue';
  const objective = compiled.objective || 'move the conversation one disciplined step forward';
  const stageTemplates = {
    mechanics_engaged: {
      seller_behavior: `Open through the exact ${signalLabel.toLowerCase()} context for ${scopeLabel}. Show you understand the trigger before explaining product value, and keep the conversation anchored in ${valueFrame}.`,
      tone_of_voice: toneLine,
    },
    economics_engaged: {
      seller_behavior: `Translate the problem into business logic. Explain what changes operationally or commercially, use ${proofLine}, and keep the scope narrow enough to support ${objective}.`,
      tone_of_voice: toneLine,
    },
    written_step_requested: {
      seller_behavior: `Offer a compact written proof that is easy to review asynchronously. The material should clarify ownership, value, and risk boundaries without turning into a broad deck.`,
      tone_of_voice: toneLine,
    },
    written_step_accepted: {
      seller_behavior: `Confirm what the buyer accepted, hold the line on the agreed proof, and avoid reopening old arguments. Use the accepted material to earn the next bounded move.`,
      tone_of_voice: toneLine,
    },
    written_step_then_call: {
      seller_behavior: `Bridge from written proof into a short working review. Keep the ask disciplined, tie it to the already accepted proof, and frame the call as decision support rather than a generic demo.`,
      tone_of_voice: toneLine,
    },
    review_call_ready: {
      seller_behavior: `Ask for the next step directly and narrowly. Use ${askLine}, preserve clarity on scope, and stop selling once the buyer is ready to review.`,
      tone_of_voice: toneLine,
    },
  };
  return PLAYBOOK_STAGE_ORDER.map((stage) => ({ stage, ...stageTemplates[stage] }));
}

function allowedSignalsForFilters(filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  const profileSignals = normalized.persona_mode === 'persona' && personas?.[normalized.persona_id]
    ? [...new Set((personas[normalized.persona_id].cards || []).map((card) => normalizeSignalTypeId(card?.signal_type)).filter(Boolean))]
    : [];
  const doctrineSignals = Object.values(doctrineConfig?.signal_types || {})
    .filter((signal) => (!signal.side || signal.side === normalized.side) && (!signal.product || signal.product === normalized.product))
    .map((signal) => signal.id);
  const merged = [...new Set(['general', ...profileSignals, ...doctrineSignals])];
  return merged;
}

function fallbackSignalEntries(filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  const compiled = compileDoctrineForFilters(normalized);
  const scopeLabel = playbookScopeLabel(normalized);
  const valueFrame = compiled.value_frame || 'a real operating improvement';
  const toneLine = (compiled.tone_rules || []).slice(0, 3).join(', ') || 'Calm, specific, relevant.';
  const signalIds = normalized.signal_type !== 'general' ? [normalized.signal_type] : allowedSignalsForFilters(normalized);
  return signalIds.map((signalType) => {
    const signalLabel = doctrineConfig?.signal_types?.[signalType]?.label || analyticsReasonLabel(signalType);
    const signalDescription = doctrineConfig?.signal_types?.[signalType]?.description || 'a concrete trigger';
    return {
      signal_type: signalType,
      conversation_initiation: `Start with the observed ${signalLabel.toLowerCase()} context for ${scopeLabel}. The first message should connect that trigger to ${valueFrame}, open with one concrete observation, and close with one bounded question. Avoid a generic company intro, broad product tour, or vague meeting push. Tone: ${toneLine}. Signal context: ${signalDescription}`,
    };
  });
}

function findPlaybookRecord(records = [], filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  const candidates = (Array.isArray(records) ? records : []).filter((record) => {
    if (record.side !== normalized.side) return false;
    if (record.product !== normalized.product) return false;
    if (record.sales_type !== normalized.sales_type) return false;
    if (record.environment !== normalized.environment) return false;
    if (record.persona_mode === 'persona' && record.persona_id && normalized.persona_id !== record.persona_id) return false;
    if (record.persona_mode === 'group' && record.group_id && normalized.group_id !== record.group_id) return false;
    if (record.persona_mode === 'general' && normalized.persona_mode !== 'general') return true;
    return true;
  });
  const scored = candidates.map((record) => {
    let score = 0;
    if (record.persona_mode === normalized.persona_mode) score += 8;
    else if (record.persona_mode === 'general') score += 2;
    if (record.group_id && record.group_id === normalized.group_id) score += 4;
    if (record.persona_id && record.persona_id === normalized.persona_id) score += 6;
    if (record.signal_type === normalized.signal_type) score += 5;
    else if (record.signal_type === 'general') score += 1;
    return { record, score };
  }).sort((a, b) => b.score - a.score || String(b.record.updated_at || '').localeCompare(String(a.record.updated_at || '')));
  return scored[0]?.record || null;
}

function resolveDoctrinePlaybook(filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  const record = findPlaybookRecord(doctrineConfig?.playbooks?.doctrine_records || [], normalized);
  const stages = record?.stages?.length ? record.stages : fallbackDoctrineStages(normalized);
  return {
    filters: normalized,
    record_id: record?.id || null,
    resolved_from: record ? normalizeSliceFilters(record) : normalized,
    stages,
  };
}

function resolveSignalPlaybook(filters = {}) {
  const normalized = normalizeSliceFilters(filters);
  const record = findPlaybookRecord(doctrineConfig?.playbooks?.signal_records || [], normalized);
  const fallbackEntries = fallbackSignalEntries(normalized);
  const entries = record?.entries?.length ? record.entries : fallbackEntries;
  const filteredEntries = normalized.signal_type === 'general'
    ? entries.filter((entry) => allowedSignalsForFilters(normalized).includes(entry.signal_type))
    : entries.filter((entry) => entry.signal_type === normalized.signal_type);
  return {
    filters: normalized,
    record_id: record?.id || null,
    resolved_from: record ? normalizeSliceFilters(record) : normalized,
    entries: filteredEntries.length ? filteredEntries : fallbackEntries.filter((entry) => normalized.signal_type === 'general' || entry.signal_type === normalized.signal_type),
  };
}

function upsertDoctrinePlaybook(filters = {}, stages = []) {
  const normalized = normalizeSliceFilters(filters);
  const records = doctrineConfig.playbooks?.doctrine_records || [];
  const existingIndex = records.findIndex((record) => sliceFilterKey(record) === sliceFilterKey(normalized));
  const nextRecord = normalizePlaybookRecord({
    ...(existingIndex >= 0 ? records[existingIndex] : {}),
    ...normalized,
    stages,
    updated_at: now(),
  }, 'doctrine');
  if (existingIndex >= 0) records[existingIndex] = nextRecord;
  else records.push(nextRecord);
  doctrineConfig.playbooks.doctrine_records = records;
  return nextRecord;
}

function upsertSignalPlaybook(filters = {}, entries = []) {
  const normalized = normalizeSliceFilters(filters);
  const records = doctrineConfig.playbooks?.signal_records || [];
  const existingIndex = records.findIndex((record) => sliceFilterKey(record) === sliceFilterKey(normalized));
  const nextRecord = normalizePlaybookRecord({
    ...(existingIndex >= 0 ? records[existingIndex] : {}),
    ...normalized,
    entries,
    updated_at: now(),
  }, 'signals');
  if (existingIndex >= 0) records[existingIndex] = nextRecord;
  else records.push(nextRecord);
  doctrineConfig.playbooks.signal_records = records;
  return nextRecord;
}

function detectMessageLanguage(text, fallback = 'en') {
  const value = String(text || '');
  const cyrillic = (value.match(/[А-Яа-яЁё]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  if (cyrillic > latin) return 'ru';
  if (latin > cyrillic) return 'en';
  return fallback === 'ru' ? 'ru' : 'en';
}

function isEmailMode(session) {
  return normalizeDialogueType(session?.dialogue_type) === 'email';
}

function splitIntoSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?]+[.!?]?/g)?.map((line) => line.trim()).filter(Boolean) || [];
}

function emailPersonaGuidance(session) {
  const persona = personaMeta(session);
  const doctrine = compileDoctrineForSession(session);
  const doctrineGuidance = formatDoctrineGuidance(doctrine, { includeEmail: true });
  const custom = String(persona?.email_prompt || '').trim();
  if (custom) return [custom, doctrineGuidance].filter(Boolean).join('\n');
  if (persona?.archetype === 'finance') {
    return ['Email mode: sound like a finance buyer in email, not chat. Use a calm formal tone, self-contained paragraphs, explicit responsibility boundaries, and ask one concrete question at a time.', doctrineGuidance].filter(Boolean).join('\n');
  }
  if (persona?.archetype === 'legal') {
    return ['Email mode: sound like legal counsel in email. Be precise, restrained, and document-oriented. Avoid chatty shorthand and keep the concern focused on scope, safeguards, and traceability.', doctrineGuidance].filter(Boolean).join('\n');
  }
  return ['Email mode: sound like a real business email thread. Use complete sentences, a clear acknowledgment, one concrete concern, and avoid compressed messenger-style phrasing.', doctrineGuidance].filter(Boolean).join('\n');
}

function buildEmailSubject(session) {
  const card = session?.sde_card || {};
  const company = card?.company?.name || 'your contractor flow';
  const pain = String(card?.probable_pain || '').trim();
  if (pain) return `${company}: ${pain}`;
  return `${company}: contractor workflow`;
}

function sanitizeEmailHintText(text, lang = 'ru') {
  let out = String(text || '').trim();
  if (!out) return out;
  const bannedLeadins = [
    /(^|\s)стартовать тут стоит не с общего питча[^.?!]*[.?!]?/gi,
    /(^|\s)не спорь с рынком[^.?!]*[.?!]?/gi,
    /(^|\s)сразу заходи через[^.?!]*[.?!]?/gi,
    /(^|\s)начни с observed context[^.?!]*[.?!]?/gi,
    /(^|\s)зайди через readiness[^.?!]*[.?!]?/gi,
    /(^|\s)reset the category map[^.?!]*[.?!]?/gi,
    /(^|\s)i would approach it through[^.?!]*[.?!]?/gi,
  ];
  for (const pattern of bannedLeadins) out = out.replace(pattern, ' ');
  if (lang === 'ru') {
    const replacements = [
      [/\btrigger\b/gi, 'сигнал'],
      [/\bpredictability\b/gi, 'предсказуемость'],
      [/\bexplainability\b/gi, 'объяснимость'],
      [/\bpressure\b/gi, 'давление'],
      [/\bdefensibility\b/gi, 'защищаемость'],
      [/\bobserved context\b/gi, 'наблюдаемый контекст'],
      [/\breadiness\b/gi, 'готовность'],
      [/\beconomic logic\b/gi, 'экономическую логику'],
      [/\bhidden cost\/risk trade-off\b/gi, 'скрытые издержки и риски'],
    ];
    for (const [pattern, replacement] of replacements) out = out.replace(pattern, replacement);
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();
}

function shouldUseRawEmailText(text, lang = 'ru') {
  const value = String(text || '').trim();
  if (!value) return false;
  if (lang === 'en') return true;
  return detectMessageLanguage(value, lang) === lang;
}

function buildEmailSignalAwareOpeners(session, lang = 'ru') {
  const card = session?.sde_card || {};
  const persona = personaMeta(session) || {};
  const companyName = String(card?.company?.name || 'the company').trim();
  const contactName = String(card?.contact?.name || session?.bot_name || 'there').trim();
  const firstName = contactName.split(/\s+/)[0] || contactName;
  const rawWhatHappened = sanitizeEmailHintText(String(card?.what_happened || '').trim(), lang);
  const rawProbablePain = sanitizeEmailHintText(String(card?.probable_pain || '').trim(), lang);
  const rawFirstTouchHint = sanitizeEmailHintText(String(card?.first_touch_hint || '').trim(), lang);
  const whatHappened = shouldUseRawEmailText(rawWhatHappened, lang) ? rawWhatHappened : '';
  const probablePain = shouldUseRawEmailText(rawProbablePain, lang) ? rawProbablePain : '';
  const firstTouchHint = shouldUseRawEmailText(rawFirstTouchHint, lang) ? rawFirstTouchHint : '';
  const product = getRecommendedProduct(session) === 'cor' ? 'Mellow CoR' : 'Mellow CM';

  const financeContextEn = `${product} is relevant only if it gives a cleaner control boundary, audit trail, and a more explainable contractor path before the next finance review.`;
  const legalContextEn = `${product} is relevant only if it makes scope, safeguards, and document trail more defensible in writing, not if it adds another vague vendor layer.`;
  const opsContextEn = `${product} is relevant only if it removes manual coordination, gives a clear owner path, and makes the workflow calmer under pressure.`;
  const financeQuestionEn = 'Is this already creating finance pressure internally, or is the issue still mostly hidden?';
  const legalQuestionEn = 'Is the bigger concern for you scope boundary, document trail, or how this would hold up in review?';
  const opsQuestionEn = 'Where is the sharpest pressure right now: payment coordination, exception handling, or internal follow-up load?';

  const financeContextRu = `${product} имеет смысл только если даёт более чистую зону контроля, понятный audit trail и объяснимую contractor-схему перед следующим финансовым разбором.`;
  const legalContextRu = `${product} имеет смысл только если делает границы, safeguards и документный след более защищаемыми в письменном виде, а не добавляет ещё один размытый vendor-слой.`;
  const opsContextRu = `${product} имеет смысл только если убирает ручную координацию, даёт понятную owner-модель и делает процесс спокойнее под давлением.`;
  const financeQuestionRu = 'Это уже создаёт давление внутри finance, или проблема пока ещё скрыта?';
  const legalQuestionRu = 'Для вас сейчас главнее граница ответственности, документный след или защищаемость схемы на review?';
  const opsQuestionRu = 'Где сейчас самая острая нагрузка: координация выплат, разбор исключений или внутренние follow-up?';

  const archetype = persona.archetype || 'finance';
  const contextEn = archetype === 'legal' ? legalContextEn : archetype === 'ops' ? opsContextEn : financeContextEn;
  const questionEn = archetype === 'legal' ? legalQuestionEn : archetype === 'ops' ? opsQuestionEn : financeQuestionEn;
  const contextRu = archetype === 'legal' ? legalContextRu : archetype === 'ops' ? opsContextRu : financeContextRu;
  const questionRu = archetype === 'legal' ? legalQuestionRu : archetype === 'ops' ? opsQuestionRu : financeQuestionRu;

  if (lang === 'en') {
    return [
      `${firstName}, I noticed a concrete signal at ${companyName}: ${whatHappened || probablePain || 'the contractor workflow is under new pressure'}. ${contextEn} ${questionEn}`,
      `${firstName}, from the outside it looks like ${companyName} may be dealing with ${probablePain || whatHappened || 'a contractor control problem'}. ${firstTouchHint || contextEn} ${questionEn}`,
    ].map((line) => sanitizeEmailHintText(line, 'en')).filter(Boolean);
  }
  return [
    `${firstName}, увидела у ${companyName} конкретный сигнал: ${whatHappened || probablePain || 'в contractor flow появилось новое давление'}. ${contextRu} ${questionRu}`,
    `${firstName}, со стороны это выглядит так, будто у ${companyName} сейчас узел в теме ${probablePain || whatHappened || 'контроля и управляемости contractor flow'}. ${firstTouchHint || contextRu} ${questionRu}`,
  ].map((line) => sanitizeEmailHintText(line, 'ru')).filter(Boolean);
}

function toEmailSellerMessage(base, session) {
  const card = session?.sde_card || {};
  const contactName = String(card?.contact?.name || '').trim() || 'there';
  const firstName = contactName.split(/\s+/)[0] || contactName;
  const lang = session?.language === 'en' ? 'en' : 'ru';
  const cleanedBase = sanitizeEmailHintText(String(base || '').trim(), lang).replace(new RegExp(`^${firstName},?\\s*`, 'i'), '').trim();
  const sentences = splitIntoSentences(cleanedBase);
  const intro = sentences.slice(0, 2).join(' ');
  const ask = sentences.slice(2).join(' ') || (lang === 'en' ? 'Would it make sense to compare this against your current flow?' : 'Есть ли смысл коротко сверить это с вашим текущим процессом?');
  const greeting = lang === 'en' ? `Hi ${contactName},` : `Здравствуйте, ${contactName}.`;
  const body = [intro, ask].filter(Boolean).join('\n\n');
  const signature = lang === 'en' ? 'Best,\nPavel' : 'С уважением,\nPavel';
  if ((session?.meta?.bot_turns || 0) === 0 && sellerMessages(session).length === 0) {
    return `Subject: ${buildEmailSubject(session)}\n\n${greeting}\n\n${body}\n\n${signature}`;
  }
  return `${greeting}\n\n${body}\n\n${signature}`;
}

function toEmailBuyerReply(base, session) {
  const persona = personaMeta(session);
  const signer = String(persona?.name || session?.bot_name || 'Buyer').trim().split(/\s+/)[0] || 'Buyer';
  const rawSellerName = String(session?.seller_username || session?.seller_id || 'Pavel').trim() || 'Pavel';
  const sellerName = rawSellerName.charAt(0).toUpperCase() + rawSellerName.slice(1);
  const lang = session?.language === 'en' ? 'en' : 'ru';

  // Use email_prompt as the primary guidance source (emailPersonaGuidance returns it if set)
  const guidance = emailPersonaGuidance(session);
  const guidanceLower = guidance.toLowerCase();
  const customEmailPrompt = String(persona?.email_prompt || '').trim();

  let normalized = String(base || '').trim();
  normalized = normalized.replace(/^fine\.\s*straight to it:\s*/i, 'Before we go further, I need clarity on one point. ');
  normalized = normalized.replace(/what's in your scope, what's not\?/i, "What sits within Mellow's scope, and what remains on your side?");
  normalized = normalized.replace(/^hi,?\s*/i, '');
  let sentences = splitIntoSentences(normalized);

  // Determine formality from email_prompt or archetype
  const isFormal = guidanceLower.includes('formal') || guidanceLower.includes('legal') ||
    guidanceLower.includes('finance') || guidanceLower.includes('precise') ||
    guidanceLower.includes('restrained');

  // Opener: use email_prompt opener directive if present, else derive from formality + language
  const openerMatch = customEmailPrompt.match(/opener:\s*([^\n.]+\.?)/i);
  const opener = openerMatch
    ? openerMatch[1].trim()
    : lang === 'ru'
    ? (isFormal ? 'Спасибо за письмо.' : 'Спасибо, что написали.')
    : isFormal
    ? 'Thank you for the note.'
    : 'Thanks for reaching out.';

  // Sign-off: use email_prompt closing directive if present
  const signoffMatch = customEmailPrompt.match(/(?:sign.?off|closing):\s*([^\n]+)/i);
  const closing = signoffMatch
    ? `${signoffMatch[1].trim()}\n${signer}`
    : lang === 'ru'
    ? (isFormal ? `С уважением,\n${signer}` : `Спасибо,\n${signer}`)
    : isFormal
    ? `Regards,\n${signer}`
    : `Best,\n${signer}`;

  // Length constraint: respect "under N words" or "max N words" in email_prompt
  const wordLimitMatch = customEmailPrompt.match(/(?:under|max|limit|keep.{0,10})\s+(\d+)\s+words?/i);
  if (wordLimitMatch) {
    const limit = Math.max(10, parseInt(wordLimitMatch[1], 10));
    const combined = sentences.join(' ');
    const words = combined.split(/\s+/);
    if (words.length > limit) {
      sentences = [words.slice(0, limit).join(' ')];
    }
  }

  const firstParagraph = [opener, sentences.slice(0, 2).join(' ')].filter(Boolean).join(' ');
  const secondParagraph = sentences.slice(2).join(' ');
  return `${sellerName},\n\n${firstParagraph}${secondParagraph ? `\n\n${secondParagraph}` : ''}\n\n${closing}`;
}

function normalizeSellerLanguage(text, lang = 'ru') {
  let out = String(text || '').trim();
  if (!out) return out;
  if (lang === 'ru') {
    const replacements = [
      [/\blead investor\b/gi, 'ведущий инвестор'],
      [/\bboard\b/gi, 'совет'],
      [/\bbuyer\b/gi, 'покупатель'],
      [/\bcapability\b/gi, 'возможность'],
      [/\bturbulence\b/gi, 'турбулентность'],
      [/\bhidden cost\/risk trade-off\b/gi, 'скрытые издержки и риски'],
      [/\beconomic logic\b/gi, 'экономическую логику'],
      [/\bpayout statuses\b/gi, 'статусы выплат'],
      [/\bpayout status\b/gi, 'статус выплаты'],
      [/\bpayout\b/gi, 'выплата'],
      [/\bexplainable\b/gi, 'объяснимый'],
      [/\binvestor scrutiny\b/gi, 'давление со стороны инвестора'],
      [/\binvestor-level\b/gi, 'на уровне инвестора'],
      [/\bfuture due diligence\b/gi, 'будущий дью-дилидженс'],
      [/\bdue diligence\b/gi, 'дью-дилидженс'],
      [/\bdiligence-readiness\b/gi, 'готовность к дью-дилидженсу'],
      [/\breadiness\b/gi, 'готовность'],
      [/\bexplainability\b/gi, 'объяснимость'],
      [/\bpredictability\b/gi, 'предсказуемость'],
      [/\bdefensibility\b/gi, 'защищаемость'],
      [/\btrigger\b/gi, 'сигнал'],
      [/\bchanged fit\b/gi, 'изменившееся совпадение по задаче'],
      [/\bfit\b/gi, 'совпадение по задаче'],
      [/\bworkflow\b/gi, 'процесс'],
      [/\bcontractor flow\b/gi, 'контур работы с подрядчиками'],
      [/\bpayment flow\b/gi, 'платёжный процесс'],
      [/\bpayout flow\b/gi, 'процесс выплат'],
      [/\bflow\b/gi, 'процесс'],
      [/\baudit trail\b/gi, 'прозрачный след операций'],
      [/\btrail\b/gi, 'след операций'],
      [/\bgrey zones\b/gi, 'серые зоны'],
      [/\bgrey zone\b/gi, 'серая зона'],
      [/\bgrey provider\b/gi, 'серый провайдер'],
      [/\boutside counsel\b/gi, 'внешний юрист'],
      [/\bexternal counsel\b/gi, 'внешний юрист'],
      [/\bexternal legal review\b/gi, 'внешняя юридическая проверка'],
      [/\blegal review\b/gi, 'юридическая проверка'],
      [/\binternal legal\b/gi, 'внутренний юрист'],
      [/\bfinance team\b/gi, 'финансовая команда'],
      [/\bfinance\b/gi, 'финансы'],
      [/\bops manager\b/gi, 'операционный менеджер'],
      [/\bops\b/gi, 'операционный контур'],
      [/\bboard update\b/gi, 'обновление для совета'],
      [/\bquarterly review\b/gi, 'квартальный разбор'],
      [/\breview call\b/gi, 'разборный созвон'],
      [/\bwritten outline\b/gi, 'письменная схема'],
      [/\bone invoice\b/gi, 'единый счет'],
      [/\badmin overhead\b/gi, 'лишняя ручная нагрузка'],
      [/\bcontour\b/gi, 'контур'],
      [/\boutline\b/gi, 'схема'],
      [/\bcall\b/gi, 'созвон'],
      [/\breview\b/gi, 'разбор'],
      [/\bbrief\b/gi, 'краткий материал'],
      [/\bmemo\b/gi, 'записка'],
      [/\bslice\b/gi, 'срез'],
      [/\bpremium\b/gi, 'премия к цене'],
      [/\bfollow-ups\b/gi, 'дополнительные напоминания'],
      [/\bfollow-up\b/gi, 'дополнительное напоминание'],
      [/\bfollow ups\b/gi, 'дополнительные напоминания'],
      [/\bbottleneck\b/gi, 'узкое место'],
      [/\bnamed owner\b/gi, 'выделенный ответственный'],
      [/\bowner model\b/gi, 'модель ответственности'],
      [/\bcontrol zone\b/gi, 'зона контроля'],
      [/\bpressure\b/gi, 'давление'],
      [/\bcontrol\b/gi, 'контроль'],
      [/\bimplementation\b/gi, 'внедрение'],
      [/\bchampion\b/gi, 'внутренний сторонник'],
      [/\benterprise theatre\b/gi, 'корпоративная показуха'],
      [/\bcontractors\b/gi, 'подрядчики'],
      [/\bcontractor\b/gi, 'подрядчик'],
      [/\bnext step\b/gi, 'следующий шаг'],
      [/\bmarketing slang\b/gi, 'маркетинговый шум'],
    ];
    for (const [pattern, replacement] of replacements) out = out.replace(pattern, replacement);
    out = out.replace(/Не спорь с рынком\.?\s*/gi, '');
    out = out.replace(/Сразу заходи через\s*/gi, 'Сразу говори про ');
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();
}

function adaptTextToDialogue(base, session, role) {
  const lang = session?.language === 'en' ? 'en' : 'ru';
  const baseText = String(base || '').trim();
  const preserveSellerText = role === 'seller' && isEmailMode(session) && detectMessageLanguage(baseText, lang) === lang;
  const normalizedBase = role === 'seller'
    ? (preserveSellerText ? baseText : normalizeSellerLanguage(baseText, lang))
    : baseText;
  if (!isEmailMode(session)) return normalizedBase;
  return role === 'seller' ? toEmailSellerMessage(normalizedBase, session) : toEmailBuyerReply(normalizedBase, session);
}

function seedPersonaStore() {
  const seeded = {};
  for (const [id, persona] of Object.entries(BUILTIN_PERSONAS)) {
    seeded[id] = normalizePersona(persona, id);
  }
  return seeded;
}

async function loadPersonaStore() {
  const parsed = await storage.loadPersonas({ seedFactory: seedPersonaStore });
  const entries = Array.isArray(parsed)
    ? parsed.map((persona) => [persona.id, persona])
    : Object.entries(parsed || {});
  const normalized = Object.fromEntries(
    entries.map(([id, persona]) => [sanitizePersonaId(id) || persona.id, normalizePersona(persona, id)])
  );
  if (!Object.keys(normalized).length) {
    const seeded = seedPersonaStore();
    if (storage.driver === 'file') {
      await storage.savePersonas(seeded);
    }
    return seeded;
  }
  if (JSON.stringify(parsed) !== JSON.stringify(normalized) && storage.driver === 'file') {
    await storage.savePersonas(normalized);
  }
  return normalized;
}

async function savePersonaStore() {
  await storage.savePersonas(personas);
}

let personas = await loadPersonaStore();
let doctrineConfig = normalizeDoctrineConfig(await storage.loadDoctrineConfig({ seedFactory: seedDoctrineConfig }));

async function saveDoctrineConfig() {
  doctrineConfig = normalizeDoctrineConfig(doctrineConfig);
  await storage.saveDoctrineConfig(doctrineConfig);
}

app.use(express.json());
app.get('/version.json', (_req, res) => {
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || null;
  const shortSha = commitSha ? commitSha.slice(0, 7) : null;
  res.json({
    name: packageJson.name,
    packageVersion: packageJson.version,
    commitSha,
    shortSha,
    displayVersion: shortSha ? `${packageJson.version}+${shortSha}` : packageJson.version,
    buildTimestamp: new Date().toISOString(),
    runtime: 'express',
  });
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const auth = createAuth();
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/auth/login', auth.loginHandler());
app.post('/auth/logout', auth.logoutHandler());
app.get('/auth/whoami', auth.middleware(), auth.whoamiHandler());

app.use(auth.middleware());
app.use(express.static(path.join(__dirname, 'public')));

function now() {
  return new Date().toISOString();
}

function sessionPath(sessionId) {
  return storage.sessionFilePath(sessionId);
}

async function saveSession(session) {
  if (!shouldPersistSession(session)) return session;
  await storage.saveSession(session);
  return session;
}

function createSalesSession({ personaId, sellerId = 'pavel', dialogueType = 'messenger', randomizerConfig = null, language = null, difficultyTier = 1, scenarioSelection = null } = {}) {
  personaId = getCanonicalPersonaId(personaId);
  if (!personaId || !personas[personaId]) {
    throw new Error('Unknown personaId');
  }
  const explicitLanguage = language === 'ru' || language === 'en' ? language : null;
  const tier = Math.max(1, Math.min(3, parseInt(difficultyTier, 10) || 1));
  const normalizedScenarioSelection = scenarioSelection && typeof scenarioSelection === 'object'
    ? {
        side: String(scenarioSelection.side || '').trim() || 'demand',
        product: String(scenarioSelection.product || '').trim() || 'cor',
        signal_type: normalizeSignalTypeId(scenarioSelection.signal_type),
        dialogue_type: String(scenarioSelection.dialogue_type || '').trim() || 'outbound',
        environment: String(scenarioSelection.environment || '').trim() || normalizeDialogueType(dialogueType),
        group: String(scenarioSelection.group || '').trim() || 'custom',
        profile: String(scenarioSelection.profile || '').trim() || personaId,
      }
    : null;
  const normalizedRandomizerConfig = normalizeRandomizerConfig({
    ...(randomizerConfig || {}),
    signal_types: normalizedScenarioSelection?.signal_type ? [String((doctrineConfig?.signal_types?.[normalizedScenarioSelection.signal_type]?.id || normalizedScenarioSelection.signal_type).toUpperCase())] : randomizerConfig?.signal_types,
  });
  const card = pickCard(personaId, normalizedRandomizerConfig);
  const inferredLanguage = detectMessageLanguage([
    card?.what_happened,
    card?.probable_pain,
    card?.first_touch_hint,
    card?.rendered_text,
  ].filter(Boolean).join(' '), 'en');
  const lang = explicitLanguage || inferredLanguage || 'en';
  const sessionSeed = buildPersonaSeed(personaId);
  const persona = personas[personaId];
  const resolvedDialogueType = normalizeDialogueType(dialogueType);
  const session = {
    session_id: randomId('session'),
    seller_id: sellerId,
    seller_username: sellerId,
    bot_id: personaId,
    bot_name: personas[personaId].name,
    started_at: now(),
    finished_at: null,
    status: 'in_progress',
    trigger: null,
    language: lang,
    dialogue_type: resolvedDialogueType,
    scenario_selection: normalizedScenarioSelection,
    difficulty_tier: tier,
    scenario_type: 'first_contact_to_discovery',
    sde_card_id: card.card_id,
    sde_card: card,
    transcript: [],
    assessment_id: null,
    assessment: null,
    buyer_state: buildInitialBuyerState({
      bot_id: personaId,
      dialogue_type: resolvedDialogueType,
      difficulty_tier: tier,
    }),
    meta: {
      bot_turns: 0,
      flags: {},
      claims: {},
      trust: 1,
      irritation: 0,
      miss_streak: 0,
      persona_seed: sessionSeed,
      concern_order: buildConcernOrder(personaId, sessionSeed),
      resolved_concerns: {},
      prompt_style: persona.prompt_style || [],
      prompt_objections: persona.prompt_objections || [],
      email_prompt: persona.email_prompt || '',
      randomizer_config: normalizedRandomizerConfig,
      buyer_state_version: 'v1',
      language_locked: false,
      initial_seller_language: null,
      skip_persistence: false,
    }
  };
  syncLegacyBehaviorState(session);
  return session;
}

async function commitAutoMessageTurn(session) {
  const contrastiveSnapshot = buildHintMemorySnapshot(session);
  const explorationStrategy = pickExplorationStrategy();
  const sellerText = await generateSellerSuggestion(session, null, contrastiveSnapshot, explorationStrategy);
  const hintAttempt = createHintMemoryAttempt(session, sellerText, null, 'auto', contrastiveSnapshot, explorationStrategy);
  const sellerEntry = { role: 'seller', text: sellerText, ts: now() };
  sellerEntry.hint_memory_id = hintAttempt.record.id;
  sellerEntry.hint_memory_context = hintAttempt.retrieval;
  session.transcript.push(sellerEntry);
  trackSellerTurnMetadata(session, sellerEntry, sellerText);
  const transition = evaluateBuyerStateDelta(session, sellerText);
  session.buyer_state = normalizeBuyerState({
    ...transition.state_after,
  }, session);
  sellerEntry.buyer_state_transition = transition;
  updateBehaviorState(session, sellerText);
  syncLegacyBehaviorState(session);
  const reply = await generateBotReply(session, sellerText);
  updateSessionClaims(session, sellerText);
  session.meta.bot_turns += 1;
  if (reply !== null) {
    session.transcript.push({ role: 'bot', text: reply, ts: now() });
    sellerEntry.buyer_reply_outcome = 'replied';
    applyBuyerAcceptanceOutcome(session, sellerEntry, reply);
  } else {
    session.transcript.push({ role: 'system', text: '[No reply — the prospect went silent. Try a follow-up.]', ts: now() });
    session.meta.ghost_turns = (session.meta.ghost_turns || 0) + 1;
    sellerEntry.buyer_reply_outcome = 'silent';
  }
  if (reply && !session.meta.meeting_booked && (detectBuyerMeetingAcceptance(reply, session.language) || detectConditionalLegalReviewAcceptance(reply, sellerText, personaMeta(session)?.id))) {
    session.meta.meeting_booked = true;
    session.meta.meeting_booked_turn = sellerMessages(session).length;
  }
  updateHintMemoryAttempt(session, sellerEntry, hintAttempt.record.id);
  if (visibleDialogueMessageCount(session) >= MAX_DIALOGUE_MESSAGES) {
    await finalizeSession(session, 'max_dialogue_messages');
  } else {
    await saveSession(session);
  }
  return { seller_text: sellerText, reply, session };
}

const evaluationRunMemoryStore = new Map();

function evaluationSummaryTemplate() {
  return { personas: {}, overall: { total: 0, pass: 0, pass_with_notes: 0, fail: 0, blocker: 0 } };
}

function summarizeEvaluationResults(results = []) {
  const summary = evaluationSummaryTemplate();
  for (const item of results) {
    const personaId = item.persona_id || 'unknown';
    if (!summary.personas[personaId]) {
      summary.personas[personaId] = { total: 0, pass: 0, pass_with_notes: 0, fail: 0, blocker: 0, sessions: [] };
    }
    const verdict = String(item.verdict || 'FAIL').toUpperCase();
    const bucket = summary.personas[personaId];
    bucket.total += 1;
    bucket.sessions.push(item.session_id);
    summary.overall.total += 1;
    if (verdict === 'PASS') {
      bucket.pass += 1;
      summary.overall.pass += 1;
    } else if (verdict === 'PASS_WITH_NOTES') {
      bucket.pass_with_notes += 1;
      summary.overall.pass_with_notes += 1;
    } else if (verdict === 'BLOCKER') {
      bucket.blocker += 1;
      summary.overall.blocker += 1;
    } else {
      bucket.fail += 1;
      summary.overall.fail += 1;
    }
  }
  return summary;
}

function normalizeEvaluationConfig(raw = {}) {
  const personaIds = Array.isArray(raw.personaIds) && raw.personaIds.length
    ? raw.personaIds.map(String).filter((id) => personas[id])
    : Object.keys(personas);
  const uniquePersonaIds = [...new Set(personaIds)];
  if (!uniquePersonaIds.length) {
    throw new Error('No valid personaIds provided');
  }
  return {
    persona_ids: uniquePersonaIds,
    sims_per_persona: Math.max(1, Math.min(100, parseInt(raw.simsPerPersona, 10) || 1)),
    turns_per_simulation: Math.max(1, Math.min(12, parseInt(raw.turnsPerSimulation, 10) || 4)),
    seller_id: String(raw.sellerId || 'eval_runner'),
    dialogue_type: normalizeDialogueType(raw.dialogueType || 'messenger'),
    language: raw.language === 'ru' ? 'ru' : 'en',
    difficulty_tier: Math.max(1, Math.min(3, parseInt(raw.difficultyTier, 10) || 1)),
    max_runtime_ms: Math.max(500, Math.min(25000, parseInt(raw.maxRuntimeMs, 10) || 8000)),
    max_simulations_per_chunk: Math.max(1, Math.min(50, parseInt(raw.maxSimulationsPerChunk, 10) || 3)),
    stop_on_error: raw.stopOnError === true,
    randomizer_config: normalizeRandomizerConfig(raw.randomizerConfig),
  };
}

function createEvaluationRun(rawConfig = {}) {
  const config = normalizeEvaluationConfig(rawConfig);
  return {
    run_id: randomId('evalrun'),
    status: 'pending',
    created_at: now(),
    updated_at: now(),
    started_at: null,
    finished_at: null,
    last_error: null,
    config,
    cursor: { persona_index: 0, simulation_index: 0 },
    progress: {
      total_personas: config.persona_ids.length,
      completed_personas: 0,
      total_simulations: config.persona_ids.length * config.sims_per_persona,
      completed_simulations: 0,
      failed_simulations: 0,
    },
    results: [],
    summary: evaluationSummaryTemplate(),
  };
}

async function saveEvaluationRun(run) {
  run.updated_at = now();
  run.summary = summarizeEvaluationResults(run.results);
  run.progress.completed_simulations = run.results.length;
  run.progress.failed_simulations = run.results.filter((item) => item.error).length;
  run.progress.completed_personas = run.config.persona_ids.reduce((count, personaId) => {
    const done = run.results.filter((item) => item.persona_id === personaId).length;
    return count + (done >= run.config.sims_per_persona ? 1 : 0);
  }, 0);
  try {
    await storage.saveEvaluationRun(run);
  } catch (error) {
    if (!/project size limit|could not extend file/i.test(String(error?.message || error))) throw error;
    evaluationRunMemoryStore.set(run.run_id, clone(run));
  }
  return run;
}

async function loadEvaluationRun(runId) {
  const memoryRun = evaluationRunMemoryStore.get(runId);
  if (memoryRun) return clone(memoryRun);
  return storage.loadEvaluationRun(runId);
}

async function listEvaluationRuns(limit = 20) {
  const persisted = await storage.listEvaluationRuns(limit).catch(() => []);
  const memoryRuns = [...evaluationRunMemoryStore.values()].map((payload) => summarizeEvaluationRun(payload)).filter(Boolean);
  const combined = [...memoryRuns, ...persisted]
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  const seen = new Set();
  return combined.filter((item) => {
    if (!item?.run_id || seen.has(item.run_id)) return false;
    seen.add(item.run_id);
    return true;
  }).slice(0, limit);
}

async function executeEvaluationSimulation(run, personaId, simulationOrdinal) {
  const session = createSalesSession({
    personaId,
    sellerId: `${run.config.seller_id}_${run.run_id}`,
    dialogueType: run.config.dialogue_type,
    randomizerConfig: run.config.randomizer_config,
    language: run.config.language,
    difficultyTier: run.config.difficulty_tier,
  });
  session.meta.skip_persistence = true;
  await saveSession(session);
  let currentSession = session;
  while (currentSession.status === 'in_progress' && sellerMessages(currentSession).length < run.config.turns_per_simulation) {
    const step = await commitAutoMessageTurn(currentSession);
    currentSession = step.session;
  }
  if (currentSession.status !== 'finished') {
    await finalizeSession(currentSession, 'evaluation_run');
  }
  return {
    session_id: currentSession.session_id,
    persona_id: personaId,
    simulation_ordinal: simulationOrdinal,
    verdict: currentSession.assessment?.verdict || 'FAIL',
    meeting_booked: sessionHasMeetingBooked(currentSession),
    started_at: currentSession.started_at,
    finished_at: currentSession.finished_at,
    seller_turns: sellerMessages(currentSession).length,
    visible_messages: visibleDialogueMessageCount(currentSession),
    next_step_likelihood: Number(currentSession?.buyer_state?.next_step_likelihood || 0),
    reply_likelihood: Number(currentSession?.buyer_state?.reply_likelihood || 0),
    disengagement_risk: Number(currentSession?.buyer_state?.disengagement_risk || 0),
  };
}

async function advanceEvaluationRun(run, rawOverrides = {}) {
  const maxRuntimeMs = Math.max(500, Math.min(25000, parseInt(rawOverrides.maxRuntimeMs, 10) || run.config.max_runtime_ms || 8000));
  const maxSimulationsPerChunk = Math.max(1, Math.min(50, parseInt(rawOverrides.maxSimulationsPerChunk, 10) || run.config.max_simulations_per_chunk || 3));
  const started = Date.now();
  let processed = 0;
  if (!run.started_at) run.started_at = now();
  run.status = 'running';
  await saveEvaluationRun(run);

  while (run.cursor.persona_index < run.config.persona_ids.length) {
    if (processed >= maxSimulationsPerChunk) break;
    if (Date.now() - started >= maxRuntimeMs && processed > 0) break;
    const personaId = run.config.persona_ids[run.cursor.persona_index];
    const simulationOrdinal = run.cursor.simulation_index + 1;
    try {
      const result = await executeEvaluationSimulation(run, personaId, simulationOrdinal);
      run.results.push(result);
      run.last_error = null;
    } catch (error) {
      run.results.push({
        session_id: null,
        persona_id: personaId,
        simulation_ordinal: simulationOrdinal,
        verdict: 'BLOCKER',
        error: error?.message || String(error),
        finished_at: now(),
      });
      run.last_error = { persona_id: personaId, simulation_ordinal: simulationOrdinal, message: error?.message || String(error), at: now() };
      if (run.config.stop_on_error) {
        run.status = 'failed';
        await saveEvaluationRun(run);
        return run;
      }
    }

    processed += 1;
    run.cursor.simulation_index += 1;
    if (run.cursor.simulation_index >= run.config.sims_per_persona) {
      run.cursor.persona_index += 1;
      run.cursor.simulation_index = 0;
    }
    await saveEvaluationRun(run);
  }

  if (run.cursor.persona_index >= run.config.persona_ids.length) {
    run.status = run.results.some((item) => item.error) ? 'completed_with_errors' : 'completed';
    run.finished_at = now();
  } else if (processed === 0) {
    run.status = 'running';
  } else {
    run.status = 'paused';
  }
  await saveEvaluationRun(run);
  return run;
}

const POSITIVE_OUTCOME_RE = /(созвон|звонок|встреч|meeting|short call|20-minute call|15-minute|walkthrough)/i;

function sessionHasPositiveOutcome(session) {
  return (session?.transcript || []).some((entry) => entry.role === 'bot' && POSITIVE_OUTCOME_RE.test(String(entry.text || '')));
}

// Detects explicit buyer ACCEPTANCE of a meeting/call (stronger than a bare mention).
function detectBuyerMeetingAcceptance(text, lang) {
  const lower = String(text || '').toLowerCase();
  const isEN = lang === 'en';
  if (isEN) {
    // Positive acceptance phrases in English
    if (/\b(let'?s\s+(do\s+it|talk|connect|meet|schedule|chat|book)|sounds\s+good|that\s+works|i'?m\s+in|works\s+for\s+me|happy\s+to\s+(connect|meet|talk|chat)|sure,?\s*(let'?s|i'?d|we\s+can)|yes,?\s*(let'?s|sounds\s+good|absolutely)|absolutely,?\s*let'?s|great,?\s*let'?s|i'?d\s+be\s+(happy|glad|open)\s+to|book\s+it|set\s+it\s+up|schedule\s+(a\s+)?(call|meeting))\b/i.test(lower)) return true;
    // "yes" or "ok" combined with call/meeting reference (word-bounded to avoid "specifically" matching "call")
    if (/\b(yes|ok|okay|sure|great|good|fine|alright|works)\b/i.test(lower) && /(15|20)[- ]minute|\bcall\b|\bmeeting\b|\bwalkthrough\b/i.test(lower)) return true;
    if (/\b(send|share)\b/i.test(lower) && /\b(brief|memo|one-pager|implementation plan|cost breakdown)\b/i.test(lower) && /\b(then|after that|right after|we can)\b/i.test(lower) && /\b(call|meeting|review)\b/i.test(lower)) return true;
    if (/\b(find|book|hold|set)\b/i.test(lower) && /\b(slot|time)\b/i.test(lower) && /\b(call|meeting|review)\b/i.test(lower)) return true;
    if (/\b(i'?ll|i will|can|could)\b/i.test(lower) && /\b(find|make|give)\b/i.test(lower) && /(15|20)[- ]minute|\bcall\b|\bmeeting\b|\breview\b/i.test(lower)) return true;
    return false;
  } else {
    // Explicit deferral / resistance — reject before checking positives.
    // Catches "Пока созвон рано" (too early), "не сейчас" (not now), etc.
    if (/(рано|не\s+сейчас|не\s+готов|не\s+готова|пока\s+не|позже|подождите|пришлите\s+материал|отправьте\s+материал|для\s+начала)/.test(lower)) return false;

    // Strong acceptance phrases. \b does not work for Cyrillic in JS (only matches ASCII
    // word chars), so we use space/punctuation anchors to simulate word boundaries.
    const RU_ANCHOR = '(?:^|[\\s,;!?—])';
    const RU_TAIL = '(?:[\\s,;!?—]|$)';
    const strongPhrase = new RegExp(
      RU_ANCHOR +
      '(?:давайте\\s+созвонимся|ок[,\\s]+созвонимся|да[,\\s]*давайте|хорошо[,\\s]*давайте' +
      '|ладно[,\\s]*давайте|конечно[,\\s]*давайте|договорились|согласен|согласна' +
      '|можно\\s+созвониться|созвонимся|звоните)' +
      RU_TAIL
    );
    if (strongPhrase.test(lower)) return true;

    // Agreement word (must be a standalone token, not a substring of a longer word)
    // + explicit meeting reference anywhere in the text.
    // Prevents "ок" from matching within "пока", "около", etc.
    const standaloneAgree = new RegExp(
      RU_ANCHOR +
      '(?:да|ок|хорошо|ладно|конечно|отлично|согласен|согласна|договорились)' +
      RU_TAIL
    );
    if (standaloneAgree.test(lower) && /(созвон|встреч|звоним|call|meeting)/.test(lower)) return true;
    if (/(пришлите|отправьте)/.test(lower) && /(brief|memo|one-pager|материал|план внедрения|cost breakdown|summary)/.test(lower) && /(потом|после этого|и тогда|дальше)/.test(lower) && /(созвон|встреч|review call|call)/.test(lower)) return true;
    if (/(найд[её]м|зафиксир|поставим|заброн|выделю|дам)/.test(lower) && /(слот|время|15 минут|20 минут)/.test(lower) && /(созвон|встреч|review|call)/.test(lower)) return true;
    if (/(можно|готов|готова|ок|хорошо|ладно)/.test(lower) && /(коротк|15 минут|20 минут)/.test(lower) && /(созвон|встреч|review|call)/.test(lower)) return true;

    return false;
  }
}

function detectConditionalLegalReviewAcceptance(replyText, latestSellerText = '', personaId = '') {
  if (!['internal_legal', 'external_legal', 'olga'].includes(personaId)) return false;
  const reply = String(replyText || '').toLowerCase();
  const seller = String(latestSellerText || '').toLowerCase();
  const buyerWaitingForMaterials = /(waiting for your email|waiting for the materials|жду письмо|жду материалы|пришлите|отправьте)/.test(reply);
  const buyerAgreed = /(agreed|works for me|sounds good|согласен|согласна|договорились|подходит|ок)/.test(reply);
  const sellerOfferedTentativeReview = /(11:30|15:00|tomorrow|завтра|15-минут|15 minute|review call|open points|слот)/.test(seller);
  return buyerWaitingForMaterials && buyerAgreed && sellerOfferedTentativeReview;
}

// Checks if buyer explicitly agreed to a meeting/call in any session transcript entry.
function sessionHasMeetingBooked(session) {
  if (session?.meta?.meeting_booked === true) return true;
  const lang = session?.language || 'ru';
  return (session?.transcript || []).some((e) => e.role === 'bot' && detectBuyerMeetingAcceptance(e.text, lang));
}

async function listStoredSessions() {
  const raw = await storage.listSessions();
  return raw
    .map((session) => {
      try {
        return ensureBuyerStateSessionFields(session);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.finished_at || b.started_at || 0) - new Date(a.finished_at || a.started_at || 0));
}

function isAfterAnalyticsBaseline(session) {
  const ts = Date.parse(session?.finished_at || session?.started_at || 0);
  return Number.isFinite(ts) && ts >= ANALYTICS_BASELINE_RESET_AT;
}

function isHintRecordAfterAnalyticsBaseline(record) {
  const ts = Date.parse(record?.used_at || record?.created_at || 0);
  return Number.isFinite(ts) && ts >= ANALYTICS_BASELINE_RESET_AT;
}

function analyticsReasonLabel(reason = '') {
  const key = String(reason || 'unknown');
  return {
    mechanics_engaged: 'Mechanics engaged',
    economics_engaged: 'Economics engaged',
    written_step_requested: 'Written step requested',
    written_step_accepted: 'Written step accepted',
    written_step_then_call: 'Written step before call',
    review_call_ready: 'Review call ready',
    meeting_booked: 'Meeting booked',
    direct_call: 'Direct call ask landed',
    artifact_only: 'Written proof was accepted',
    artifact_then_call: 'Written proof opened a call path',
    narrow_walkthrough: 'Buyer accepted a narrow review call',
    accepts_artifact: 'Buyer asked for concrete written proof',
    accepts_slice_map: 'Buyer accepted a narrow written outline',
    accepts_cost_breakdown: 'Buyer wanted cost logic in writing',
    accepts_implementation_review: 'Buyer wanted implementation detail in writing',
    accepts_competitor_brief: 'Buyer wanted competitive comparison in writing',
    accepts_artifact_then_call: 'Buyer accepted proof and a follow-up call path',
    accepts_cost_breakdown_then_call: 'Buyer accepted cost proof plus follow-up call',
    accepts_implementation_review_then_call: 'Buyer accepted implementation review plus call',
    accepts_competitor_brief_then_call: 'Buyer accepted competitive proof plus call',
    accepts_narrow_walkthrough: 'Buyer accepted a bounded review call',
    accepts_direct_call: 'Buyer accepted the call directly',
    buyer_asked_mechanics: 'Buyer engaged with operating mechanics',
    buyer_asked_economics: 'Buyer engaged with economics and tradeoffs',
    buyer_requested_written_material: 'Buyer explicitly asked for written material',
    buyer_referenced_review_or_call: 'Buyer referenced review or live discussion',
    buyer_signaled_call_readiness: 'Buyer signaled readiness for a live review',
    buyer_explicitly_accepted_meeting: 'Buyer explicitly accepted a meeting',
    buyer_disengaged: 'Buyer disengaged',
    artifact_accepted_but_not_converted: 'Written proof did not convert',
    artifact_then_call_not_landed: 'Async proof did not turn into a call',
    walkthrough_ready_but_not_booked: 'Walkthrough interest did not become a meeting',
    no_ask_made: 'No concrete ask was made',
    premature_ask: 'Ask came too early',
    trust_deficit: 'Trust stayed too low',
    unresolved_concerns: 'Core concern stayed unresolved',
    ask_not_landed: 'Ask did not land',
    unknown: 'Unknown pattern',
  }[key] || key.replace(/_/g, ' ');
}

function analyticsReasonSummary(reason = '', { tone = 'neutral', stage = '' } = {}) {
  const key = String(reason || 'unknown');
  const summaries = {
    direct_call: 'The buyer was convinced enough to accept calendar time without needing an intermediate written step.',
    artifact_only: 'The seller created enough clarity for the buyer to ask for written proof, but not yet enough urgency for a call.',
    artifact_then_call: 'Written proof reduced uncertainty and made a follow-up call feel justified rather than premature.',
    narrow_walkthrough: 'The conversation got specific enough that a bounded review call felt worth the buyer’s time.',
    accepts_artifact: 'The buyer wanted something concrete in writing before risking a live discussion.',
    accepts_slice_map: 'The buyer responded to a narrow, scoped outline rather than a broad pitch.',
    accepts_cost_breakdown: 'The buyer needed economic proof, not more positioning, before moving forward.',
    accepts_implementation_review: 'The buyer needed implementation detail to judge fit safely.',
    accepts_competitor_brief: 'The buyer wanted a structured comparison before advancing.',
    accepts_artifact_then_call: 'The buyer was open to written proof and already saw a plausible path to a live review.',
    accepts_cost_breakdown_then_call: 'Economic proof made a follow-up call feel like the next logical step.',
    accepts_implementation_review_then_call: 'Implementation clarity reduced enough execution risk to justify a call.',
    accepts_competitor_brief_then_call: 'Comparison clarity lowered uncertainty enough to support a call.',
    accepts_narrow_walkthrough: 'The buyer accepted a tightly bounded review rather than a generic sales call.',
    accepts_direct_call: 'The buyer accepted the call directly because enough trust and relevance had already been built.',
    buyer_asked_mechanics: 'The buyer started interrogating how the workflow actually operates, which is real engagement rather than polite interest.',
    buyer_asked_economics: 'The buyer shifted into economic evaluation, meaning the conversation earned a more serious level of consideration.',
    buyer_requested_written_material: 'The buyer asked for a written artifact, which usually means the conversation cleared the first trust threshold but still needs proof.',
    buyer_referenced_review_or_call: 'The buyer referenced review or live discussion, signaling willingness to spend deeper attention on the problem.',
    buyer_signaled_call_readiness: 'The buyer gave off clear readiness for a live review, not just passive interest.',
    buyer_explicitly_accepted_meeting: 'The buyer explicitly accepted the meeting, which is the cleanest proof of forward motion.',
    meeting_booked: 'Trust, relevance, and next-step clarity were strong enough to secure calendar time.',
    buyer_disengaged: 'The conversation lost relevance or demanded too much too early, so the buyer stopped engaging.',
    artifact_accepted_but_not_converted: 'Interest stayed at the written-review layer because the seller did not convert it into a concrete live next step.',
    artifact_then_call_not_landed: 'The buyer was open to written proof, but the jump from async review to scheduled call stayed too soft or vague.',
    walkthrough_ready_but_not_booked: 'The buyer showed readiness for a bounded review, but the close never became specific enough to lock time.',
    no_ask_made: 'The seller created some movement but never converted it into an explicit next-step ask.',
    premature_ask: 'The ask arrived before enough context, trust, or proof had been earned.',
    trust_deficit: 'Claims were not credible enough yet for the buyer to risk a next step.',
    unresolved_concerns: 'A live objection stayed open, so progress stalled on unresolved risk.',
    ask_not_landed: 'There was enough conversation to ask, but the ask was weakly timed, too broad, or insufficiently tied to buyer pain.',
  };
  if (summaries[key]) return summaries[key];
  if (tone === 'win' && stage) return `This stage moved when the seller gave the buyer enough clarity and safety to progress beyond ${analyticsReasonLabel(stage).toLowerCase()}.`;
  if (tone === 'lose' && stage) return `This stage stalled because the buyer did not get enough proof or control to move beyond ${analyticsReasonLabel(stage).toLowerCase()}.`;
  return `${analyticsReasonLabel(key)} shaped the outcome in this slice.`;
}

function buildReasonListSentence(items = [], fallback = 'no clear dominant pattern yet') {
  if (!items.length) return fallback;
  return items.map((item) => item.summary || analyticsReasonLabel(item.reason || item.label || '')).join(' ');
}

function stageHistoryEntry(summary = {}, stage = '') {
  return (summary?.acceptance_stage_history || []).find((entry) => entry.stage === stage) || null;
}

function incrementCounter(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function topReasons(map = {}, limit = 5, options = {}) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, label: analyticsReasonLabel(reason), count, summary: analyticsReasonSummary(reason, options) }));
}

function mergeReasonMaps(stageReasonMaps = {}, tone = 'win', stages = []) {
  const merged = {};
  const targetStages = Array.isArray(stages) && stages.length ? stages : Object.keys(stageReasonMaps || {});
  for (const stage of targetStages) {
    const source = stageReasonMaps?.[stage]?.[tone] || {};
    for (const [reason, count] of Object.entries(source)) {
      incrementCounter(merged, reason, count);
    }
  }
  return merged;
}

function analyticsStageReasonMaps() {
  return {
    mechanics_engaged: { win: {}, lose: {} },
    economics_engaged: { win: {}, lose: {} },
    written_step_requested: { win: {}, lose: {} },
    written_step_accepted: { win: {}, lose: {} },
    written_step_then_call: { win: {}, lose: {} },
    review_call_ready: { win: {}, lose: {} },
    meeting_booked: { win: {}, lose: {} },
  };
}

function normalizedFunnelStagesReached(summary, funnelStages = []) {
  const stageRank = new Map(funnelStages.map((stage, index) => [stage, index]));
  const explicitStages = [
    ...(summary?.acceptance_stage_history || []).map((item) => item.stage),
    summary?.acceptance_stage,
  ].filter((stage) => stageRank.has(stage));
  const highestRank = explicitStages.reduce((max, stage) => Math.max(max, stageRank.get(stage)), -1);
  if (highestRank < 0) return new Set();
  return new Set(funnelStages.slice(0, highestRank + 1));
}

function sessionHasFirstBuyerReply(session) {
  const transcript = Array.isArray(session?.transcript) ? session.transcript : [];
  const firstSellerIndex = transcript.findIndex((entry) => entry.role === 'seller');
  if (firstSellerIndex === -1) return false;
  for (let index = firstSellerIndex + 1; index < transcript.length; index += 1) {
    const entry = transcript[index];
    if (entry.role === 'bot') return true;
    if (entry.role === 'seller') return false;
  }
  return false;
}

async function buildAnalyticsSummary({ limit = 100, offset = 0, personaFilter = null, outcomeFilter = null, verdictFilter = null, sideFilter = null, productFilter = null, signalTypeFilter = null, salesTypeFilter = null, instrumentFilter = null, groupFilter = null, personaModeFilter = null, aggregateBy = 'average' } = {}) {
  const sessions = await listStoredSessions();
  const baselineSessions = sessions.filter(isAfterAnalyticsBaseline);
  const finished = baselineSessions.filter((session) => session.status === 'finished');
  const positive = finished.filter(sessionHasPositiveOutcome);
  const meetingBooked = finished.filter(sessionHasMeetingBooked);
  const hintRecords = loadHintMemoryStore().filter((record) => record.was_used && isHintRecordAfterAnalyticsBaseline(record));
  const byPersona = {};
  const byDoctrine = {};
  const funnelStages = ['mechanics_engaged', 'economics_engaged', 'written_step_requested', 'written_step_accepted', 'written_step_then_call', 'review_call_ready', 'meeting_booked'];
  for (const [personaId, persona] of Object.entries(personas || {})) {
    const doctrineFamily = getDoctrineFamilyForPersonaId(personaId, persona?.archetype || '');
    byPersona[personaId] = {
      persona_id: personaId,
      persona_name: persona?.name || personaId,
      doctrine_family: doctrineFamily,
      doctrine_family_label: getDoctrineFamilyLabel(doctrineFamily),
      runs: 0,
      successful_dialogues: 0,
      success_rate: 0,
      meeting_booked_count: 0,
      meeting_booked_rate: 0,
      avg_turns: 0,
      failure_breakdown: {},
      hint_stage_breakdown: {},
      stage_ask_breakdown: {},
    };
  }

  const failureBreakdown = {};
  const stageReasonMaps = analyticsStageReasonMaps();

  for (const session of finished) {
    const scenario = inferScenarioSelection(session);
    const sourcePersonaId = session.bot_id || 'unknown';
    const personaId = getCanonicalPersonaId(sourcePersonaId);
    if (!byPersona[personaId]) {
      const doctrineFamily = getDoctrineFamilyForPersonaId(personaId, session?.bot_archetype || '');
      byPersona[personaId] = {
        persona_id: personaId,
        persona_name: personas[personaId]?.name || session.bot_name || personaId,
        doctrine_family: doctrineFamily,
        doctrine_family_label: getDoctrineFamilyLabel(doctrineFamily),
        runs: 0,
        successful_dialogues: 0,
        success_rate: 0,
        meeting_booked_count: 0,
        meeting_booked_rate: 0,
        avg_turns: 0,
        failure_breakdown: {},
        hint_stage_breakdown: {},
        stage_ask_breakdown: {},
      };
    }
    const bucket = byPersona[personaId];
    const doctrineFamily = bucket.doctrine_family || getDoctrineFamilyForPersonaId(personaId, session?.bot_archetype || '');
    if (!byDoctrine[doctrineFamily]) {
      byDoctrine[doctrineFamily] = {
        doctrine_family: doctrineFamily,
        doctrine_family_label: getDoctrineFamilyLabel(doctrineFamily),
        runs: 0,
        meeting_booked_count: 0,
        avg_turns: 0,
        personas: new Set(),
        funnel_counts: Object.fromEntries(funnelStages.map((stage) => [stage, 0])),
      };
    }
    const doctrineBucket = byDoctrine[doctrineFamily];
    if (!bucket.persona_name && session.bot_name) bucket.persona_name = session.bot_name;
    bucket.runs += 1;
    doctrineBucket.runs += 1;
    doctrineBucket.personas.add(personaId);
    if (sessionHasPositiveOutcome(session)) bucket.successful_dialogues += 1;
    if (sessionHasMeetingBooked(session)) {
      bucket.meeting_booked_count += 1;
      doctrineBucket.meeting_booked_count += 1;
    }
    const sellerTurns = sellerMessages(session).length;
    bucket.avg_turns += sellerTurns;
    doctrineBucket.avg_turns += sellerTurns;
    const failReason = session.dialogue_summary?.failure_reason || classifyMeetingFailureReason(session);
    if (!sessionHasMeetingBooked(session)) {
      bucket.failure_breakdown[failReason] = (bucket.failure_breakdown[failReason] || 0) + 1;
      failureBreakdown[failReason] = (failureBreakdown[failReason] || 0) + 1;
    }
    const summary = session.dialogue_summary || buildDialogueSummary(session);
    const reached = normalizedFunnelStagesReached(summary, funnelStages);
    for (const stage of funnelStages) {
      if (reached.has(stage)) doctrineBucket.funnel_counts[stage] += 1;
    }
    for (const stage of reached) {
      if (!stageReasonMaps[stage]) continue;
      const stageEntry = stageHistoryEntry(summary, stage);
      const stageReasons = stageEntry?.reasons?.length ? stageEntry.reasons : [];
      if (sessionHasMeetingBooked(session)) {
        if (stageReasons.length) stageReasons.forEach((reason) => incrementCounter(stageReasonMaps[stage].win, reason));
        else if (stage === 'meeting_booked') incrementCounter(stageReasonMaps[stage].win, 'buyer_explicitly_accepted_meeting');
      } else {
        if (stageReasons.length) stageReasons.forEach((reason) => incrementCounter(stageReasonMaps[stage].lose, reason));
        else incrementCounter(stageReasonMaps[stage].lose, failReason || 'unknown');
      }
    }
    // Hint stage distribution from transcript turns
    for (const entry of session.transcript || []) {
      if (entry.role === 'seller' && entry.hint_stage) {
        bucket.hint_stage_breakdown[entry.hint_stage] = (bucket.hint_stage_breakdown[entry.hint_stage] || 0) + 1;
      }
    }
    // Stage × ask-type distribution from ask events
    for (const ev of session.meta?.ask_events || []) {
      const stageKey = ev.stage || 'unknown';
      if (!bucket.stage_ask_breakdown[stageKey]) bucket.stage_ask_breakdown[stageKey] = {};
      const askKey = ev.ask_type || 'unknown';
      bucket.stage_ask_breakdown[stageKey][askKey] = (bucket.stage_ask_breakdown[stageKey][askKey] || 0) + 1;
    }
  }

  // Group hint records by persona for per-persona rate computation
  const hintRecordsByPersona = {};
  for (const record of hintRecords) {
    const pid = record.persona_id || 'unknown';
    if (!hintRecordsByPersona[pid]) hintRecordsByPersona[pid] = [];
    hintRecordsByPersona[pid].push(record);
  }

  const personaStats = Object.values(byPersona)
    .map((bucket) => {
      const meetingRate = bucket.runs ? Number((bucket.meeting_booked_count / bucket.runs).toFixed(3)) : 0;
      const pHintRecords = hintRecordsByPersona[bucket.persona_id] || [];
      const pBridgeHints = pHintRecords.filter((r) => r.hint_stage === 'bridge_step');
      const pRepairHints = pHintRecords.filter((r) => r.hint_stage === 'repair');
      const pBridgeAccepted = pBridgeHints.filter((r) => Boolean(r.accepted_next_step_type)).length;
      const pPrematureAskCount = pHintRecords.filter((r) => r.premature_ask_bool === true).length;
      const pRepairRecovered = pRepairHints.filter((r) => Number(r.buyer_progress_delta?.trust || 0) > 0 || Number(r.buyer_progress_delta?.next_step_likelihood || 0) > 0.05).length;
      return {
        ...bucket,
        success_rate: bucket.runs ? Number((bucket.successful_dialogues / bucket.runs).toFixed(3)) : 0,
        meeting_booked_rate: meetingRate,
        avg_turns: bucket.runs ? Number((bucket.avg_turns / bucket.runs).toFixed(2)) : 0,
        bridge_step_acceptance_rate: pBridgeHints.length ? Number((pBridgeAccepted / pBridgeHints.length).toFixed(3)) : 0,
        premature_ask_rate: pHintRecords.length ? Number((pPrematureAskCount / pHintRecords.length).toFixed(3)) : 0,
        repair_recovery_rate: pRepairHints.length ? Number((pRepairRecovered / pRepairHints.length).toFixed(3)) : 0,
      };
    })
    .sort((a, b) => b.meeting_booked_rate - a.meeting_booked_rate || b.runs - a.runs || String(a.persona_name || a.persona_id).localeCompare(String(b.persona_name || b.persona_id)));

  const doctrineStats = Object.values(byDoctrine)
    .map((bucket) => {
      const funnel = funnelStages.map((stage, index) => {
        const entered = bucket.funnel_counts[stage] || 0;
        const nextStage = funnelStages[index + 1] || null;
        const nextCount = nextStage ? (bucket.funnel_counts[nextStage] || 0) : null;
        return {
          stage,
          entered,
          next_stage: nextStage,
          next_count: nextCount,
          conversion_to_next: nextStage && entered ? Number((nextCount / entered).toFixed(3)) : null,
        };
      });
      return {
        doctrine_family: bucket.doctrine_family,
        doctrine_family_label: bucket.doctrine_family_label,
        persona_count: bucket.personas.size,
        runs: bucket.runs,
        meeting_booked_count: bucket.meeting_booked_count,
        meeting_booked_rate: bucket.runs ? Number((bucket.meeting_booked_count / bucket.runs).toFixed(3)) : 0,
        avg_turns: bucket.runs ? Number((bucket.avg_turns / bucket.runs).toFixed(2)) : 0,
        funnel,
      };
    })
    .sort((a, b) => b.meeting_booked_rate - a.meeting_booked_rate || b.runs - a.runs || String(a.doctrine_family_label).localeCompare(String(b.doctrine_family_label)));

  // Sort all finished sessions newest-first for slicing
  const sortedFinished = [...finished].sort((a, b) => {
    const ta = a.finished_at ? new Date(a.finished_at).getTime() : 0;
    const tb = b.finished_at ? new Date(b.finished_at).getTime() : 0;
    return tb - ta;
  });

  // Apply server-side filters
  let filteredFinished = sortedFinished;
  filteredFinished = filteredFinished.filter((session) => {
    const scenario = inferScenarioSelection(session);
    const pid = getCanonicalPersonaId(session.bot_id || 'unknown');
    if (personaFilter && pid !== personaFilter) return false;
    if (sideFilter && scenario.side !== sideFilter) return false;
    if (productFilter && scenario.product !== productFilter) return false;
    if (signalTypeFilter && signalTypeFilter !== 'general' && scenario.signal_type !== signalTypeFilter) return false;
    if (salesTypeFilter && scenario.dialogue_type !== salesTypeFilter) return false;
    if (instrumentFilter && scenario.environment !== instrumentFilter) return false;
    if (groupFilter && scenario.group !== groupFilter) return false;
    if (personaModeFilter === 'general' && (groupFilter || personaFilter)) return false;
    return true;
  });
  if (outcomeFilter === 'booked') filteredFinished = filteredFinished.filter(sessionHasMeetingBooked);
  if (outcomeFilter === 'not_booked') filteredFinished = filteredFinished.filter((s) => !sessionHasMeetingBooked(s));
  if (verdictFilter) filteredFinished = filteredFinished.filter((s) => s.assessment?.verdict === verdictFilter);

  const recentFinishedTotal = filteredFinished.length;
  const recentFinished = filteredFinished.slice(offset, offset + limit).map((session) => {
    const summary = session.dialogue_summary || buildDialogueSummary(session);
    const sourcePersonaId = session.bot_id || 'unknown';
    const canonicalPersonaId = getCanonicalPersonaId(sourcePersonaId);
    const scenario = inferScenarioSelection(session);
    // hint_stage_breakdown may be absent on sessions stored before MEL-1044; derive it fresh from transcript
    const hintStageBreakdown = summary.hint_stage_breakdown || (() => {
      const breakdown = {};
      for (const entry of session.transcript || []) {
        if (entry.role === 'seller' && entry.hint_stage) {
          breakdown[entry.hint_stage] = (breakdown[entry.hint_stage] || 0) + 1;
        }
      }
      return breakdown;
    })();
    return {
      session_id: session.session_id,
      persona_id: canonicalPersonaId,
      persona_name: personas[canonicalPersonaId]?.name || session.bot_name,
      source_persona_id: sourcePersonaId,
      source_persona_name: session.bot_name,
      doctrine_family: summary.doctrine_family || getDoctrineFamilyForPersonaId(canonicalPersonaId, personaMeta(session)?.archetype || ''),
      doctrine_family_label: summary.doctrine_family_label || getDoctrineFamilyLabel(summary.doctrine_family || getDoctrineFamilyForPersonaId(canonicalPersonaId, personaMeta(session)?.archetype || '')),
      language: summary.language || session.language || 'en',
      language_locked: summary.language_locked ?? Boolean(session?.meta?.language_locked),
      scenario_selection: scenario,
      finished_at: session.finished_at,
      dialogue_type: session.dialogue_type || 'messenger',
      signal_type: session.sde_card?.signal_type || null,
      first_buyer_reply: sessionHasFirstBuyerReply(session),
      seller_turns: sellerMessages(session).length,
      positive_outcome: sessionHasPositiveOutcome(session),
      meeting_booked: sessionHasMeetingBooked(session),
      meeting_ask_count: session.meta?.meeting_ask_count || 0,
      assessment_verdict: session.assessment?.verdict || 'N/A',
      review_verdict: session.assessment?.verdict || 'N/A',
      assessment_summary: session.assessment?.summary_for_seller || null,
      turning_point: session.assessment?.turning_point || null,
      assessment_criteria: (session.assessment?.criteria || []).map((c) => ({
        id: c.id,
        label: c.label || c.id,
        status: c.status,
        short_reason: c.short_reason || null,
      })),
      // Seller progression instrumentation (MEL-993 / MEL-1044)
      failure_reason: summary.failure_reason,
      progression_score: summary.progression_score,
      stages_reached: summary.stages_reached,
      ask_events: summary.ask_events,
      acceptance_events: summary.acceptance_events,
      acceptance_state: summary.acceptance_state,
      hint_stage_breakdown: hintStageBreakdown,
      trust_final: summary.trust_final,
      ghost_turns: summary.ghost_turns,
      resolved_concerns: summary.resolved_concerns,
    };
  });

  const filteredFailureBreakdown = {};
  const filteredStageReasonMaps = analyticsStageReasonMaps();
  const slicePersona = {};
  const sliceGroup = {};
  const sliceSignal = {};
  const sliceEnvironment = {};
  const sliceStageCounts = Object.fromEntries(funnelStages.map((stage) => [stage, 0]));

  for (const session of filteredFinished) {
    const scenario = inferScenarioSelection(session);
    const summary = session.dialogue_summary || buildDialogueSummary(session);
    const personaId = getCanonicalPersonaId(session.bot_id || 'unknown');
    const groupId = scenario.group || 'custom';
    const signalId = scenario.signal_type || 'general';
    const environmentId = scenario.environment || normalizeDialogueType(session.dialogue_type || 'messenger');
    const failReason = summary.failure_reason || classifyMeetingFailureReason(session);
    const booked = sessionHasMeetingBooked(session);
    const firstBuyerReply = sessionHasFirstBuyerReply(session);
    if (!slicePersona[personaId]) {
      slicePersona[personaId] = { persona_id: personaId, persona_name: personas[personaId]?.name || session.bot_name || personaId, runs: 0, meeting_booked_count: 0, group_id: groupId };
    }
    if (!sliceGroup[groupId]) {
      sliceGroup[groupId] = { group_id: groupId, label: doctrineConfig?.groups?.[groupId]?.label || getDoctrineFamilyLabel(groupId), runs: 0, meeting_booked_count: 0 };
    }
    if (!sliceSignal[signalId]) {
      sliceSignal[signalId] = { signal_type: signalId, label: doctrineConfig?.signal_types?.[signalId]?.label || analyticsReasonLabel(signalId), runs: 0, meeting_booked_count: 0, first_buyer_reply_count: 0 };
    }
    if (!sliceEnvironment[environmentId]) {
      sliceEnvironment[environmentId] = { environment: environmentId, label: doctrineConfig?.environments?.[environmentId]?.label || environmentId, runs: 0, meeting_booked_count: 0, first_buyer_reply_count: 0 };
    }
    slicePersona[personaId].runs += 1;
    sliceGroup[groupId].runs += 1;
    sliceSignal[signalId].runs += 1;
    sliceEnvironment[environmentId].runs += 1;
    if (firstBuyerReply) sliceSignal[signalId].first_buyer_reply_count += 1;
    if (firstBuyerReply) sliceEnvironment[environmentId].first_buyer_reply_count += 1;
    if (booked) {
      slicePersona[personaId].meeting_booked_count += 1;
      sliceGroup[groupId].meeting_booked_count += 1;
      sliceSignal[signalId].meeting_booked_count += 1;
      sliceEnvironment[environmentId].meeting_booked_count += 1;
    }
    if (!booked) incrementCounter(filteredFailureBreakdown, failReason || 'unknown');
    const reached = normalizedFunnelStagesReached(summary, funnelStages);
    for (const stage of reached) {
      if (sliceStageCounts[stage] !== undefined) sliceStageCounts[stage] += 1;
      if (!filteredStageReasonMaps[stage]) continue;
      const stageEntry = stageHistoryEntry(summary, stage);
      const stageReasons = stageEntry?.reasons?.length ? stageEntry.reasons : [];
      if (booked) {
        if (stageReasons.length) stageReasons.forEach((reason) => incrementCounter(filteredStageReasonMaps[stage].win, reason));
        else if (stage === 'meeting_booked') incrementCounter(filteredStageReasonMaps[stage].win, 'buyer_explicitly_accepted_meeting');
      } else {
        if (stageReasons.length) stageReasons.forEach((reason) => incrementCounter(filteredStageReasonMaps[stage].lose, reason));
        else incrementCounter(filteredStageReasonMaps[stage].lose, failReason || 'unknown');
      }
    }
  }

  const filteredMeetingBooked = filteredFinished.filter(sessionHasMeetingBooked);
  const filteredFirstBuyerReply = filteredFinished.filter(sessionHasFirstBuyerReply);
  const funnel = funnelStages.map((stage, index) => {
    const entered = sliceStageCounts[stage] || 0;
    const nextStage = funnelStages[index + 1] || null;
    const nextCount = nextStage ? (sliceStageCounts[nextStage] || 0) : null;
    const winReasons = topReasons(filteredStageReasonMaps[stage]?.win || {}, 3, { tone: 'win', stage });
    const loseReasons = topReasons(filteredStageReasonMaps[stage]?.lose || {}, 3, { tone: 'lose', stage });
    return {
      stage,
      entered,
      next_stage: nextStage,
      next_count: nextCount,
      conversion_to_next: nextStage && entered ? Number((nextCount / entered).toFixed(3)) : null,
      win_reasons: winReasons,
      lose_reasons: loseReasons,
      summary: entered
        ? `${analyticsReasonLabel(stage)}${nextStage ? ` moved ${(nextCount / entered * 100).toFixed(1)}% of entered runs forward` : ' marks completed wins'}. ${winReasons[0]?.summary || 'No dominant forward driver yet.'} ${loseReasons[0]?.summary || 'No dominant blocker yet.'}`
        : `${analyticsReasonLabel(stage)} has no runs in this slice yet.`,
    };
  });

  const filteredMeetingRate = filteredFinished.length ? Number((filteredMeetingBooked.length / filteredFinished.length).toFixed(3)) : 0;
  const filteredFirstBuyerReplyRate = filteredFinished.length ? Number((filteredFirstBuyerReply.length / filteredFinished.length).toFixed(3)) : 0;
  const aggregateWinReasons = mergeReasonMaps(filteredStageReasonMaps, 'win', ['written_step_requested', 'written_step_accepted', 'written_step_then_call', 'review_call_ready', 'meeting_booked']);
  const aggregateLoseReasons = mergeReasonMaps(filteredStageReasonMaps, 'lose', ['mechanics_engaged', 'economics_engaged', 'written_step_requested', 'written_step_accepted', 'written_step_then_call', 'review_call_ready']);
  const winReasonCounts = Object.keys(aggregateWinReasons).length
    ? aggregateWinReasons
    : filteredMeetingBooked.reduce((acc, session) => {
        const key = session.dialogue_summary?.acceptance_state || 'meeting_booked';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
  const loseReasonCounts = Object.keys(aggregateLoseReasons).length ? aggregateLoseReasons : filteredFailureBreakdown;
  const topWinReasons = topReasons(winReasonCounts, 5, { tone: 'win' });
  const topLoseReasons = topReasons(loseReasonCounts, 5, { tone: 'lose' });

  const analyticalBrief = {
    overall: filteredFinished.length
      ? `Across ${filteredFinished.length} finished runs, first reply rate is ${(filteredFirstBuyerReplyRate * 100).toFixed(1)}% and meeting-booked rate is ${(filteredMeetingRate * 100).toFixed(1)}%. Wins concentrate where the conversation creates enough specificity for a bounded next step: ${buildReasonListSentence(topWinReasons.slice(0, 2))} Main drop-off comes from execution gaps rather than silence alone: ${buildReasonListSentence(topLoseReasons.slice(0, 2))}`
      : 'No finished runs match the current slice yet.',
    exact_slice_note: filteredFinished.length
      ? `For this exact slice, we win when ${buildReasonListSentence(topWinReasons.slice(0, 2))}. We get refusals when ${buildReasonListSentence(topLoseReasons.slice(0, 2))}.`
      : 'No finished runs match this exact slice yet, so there is no stable win or refusal pattern to explain.',
    average_win_reasons: topWinReasons,
    average_lose_reasons: topLoseReasons,
    first_buyer_reply_rate: filteredFirstBuyerReplyRate,
    stage_summaries: funnel.map((stage) => ({
      stage: stage.stage,
      entered: stage.entered,
      conversion_to_next: stage.conversion_to_next,
      summary: stage.entered
        ? `${analyticsReasonLabel(stage.stage)} captured ${stage.entered} runs${stage.conversion_to_next !== null ? ` and moved ${(stage.conversion_to_next * 100).toFixed(1)}% forward` : ''}. ${stage.win_reasons[0]?.summary || 'No dominant forward driver yet.'} ${stage.lose_reasons[0]?.summary || 'No dominant blocker yet.'}`
        : `${analyticsReasonLabel(stage.stage)} has no runs in this slice yet.`,
      win_reasons: stage.win_reasons,
      lose_reasons: stage.lose_reasons,
    })),
  };

  const totalMeetingRate = finished.length ? Number((meetingBooked.length / finished.length).toFixed(3)) : 0;
  const bridgeHints = hintRecords.filter((r) => r.hint_stage === 'bridge_step');
  const directAskHints = hintRecords.filter((r) => r.hint_stage === 'direct_ask');
  const repairHints = hintRecords.filter((r) => r.hint_stage === 'repair');
  const bridgeAccepted = bridgeHints.filter((r) => Boolean(r.accepted_next_step_type)).length;
  const prematureAskCount = hintRecords.filter((r) => r.premature_ask_bool === true).length;
  const repairRecovered = repairHints.filter((r) => Number(r.buyer_progress_delta?.trust || 0) > 0 || Number(r.buyer_progress_delta?.next_step_likelihood || 0) > 0.05).length;

  // Total hint stage distribution from transcript turns across all finished sessions
  const totalHintStageBreakdown = {};
  for (const session of finished) {
    for (const entry of session.transcript || []) {
      if (entry.role === 'seller' && entry.hint_stage) {
        totalHintStageBreakdown[entry.hint_stage] = (totalHintStageBreakdown[entry.hint_stage] || 0) + 1;
      }
    }
  }

  return {
    generated_at: now(),
    baseline_reset_at: new Date(ANALYTICS_BASELINE_RESET_AT).toISOString(),
    totals: {
      total_sessions: baselineSessions.length,
      finished_sessions: finished.length,
      successful_dialogues: positive.length,
      success_rate: finished.length ? Number((positive.length / finished.length).toFixed(3)) : 0,
      meeting_booked_count: meetingBooked.length,
      meeting_booked_rate: totalMeetingRate,
      failure_breakdown: failureBreakdown,
      hint_stage_breakdown: totalHintStageBreakdown,
      bridge_step_acceptance_rate: bridgeHints.length ? Number((bridgeAccepted / bridgeHints.length).toFixed(3)) : 0,
      premature_ask_rate: hintRecords.length ? Number((prematureAskCount / hintRecords.length).toFixed(3)) : 0,
      repair_recovery_rate: repairHints.length ? Number((repairRecovered / repairHints.length).toFixed(3)) : 0,
      direct_ask_hint_rate: hintRecords.length ? Number((directAskHints.length / hintRecords.length).toFixed(3)) : 0,
    },
    doctrine_stats: doctrineStats,
    persona_stats: personaStats,
    slice: {
      filters: {
        side: sideFilter,
        product: productFilter,
        signal_type: signalTypeFilter,
        dialogue_type: salesTypeFilter,
        environment: instrumentFilter,
        group: groupFilter,
        persona_id: personaFilter,
        aggregate_by: aggregateBy,
      },
      totals: {
        finished_sessions: filteredFinished.length,
        first_buyer_reply_count: filteredFirstBuyerReply.length,
        first_buyer_reply_rate: filteredFirstBuyerReplyRate,
        meeting_booked_count: filteredMeetingBooked.length,
        meeting_booked_rate: filteredMeetingRate,
      },
      funnel,
      by_environment: Object.values(sliceEnvironment).map((item) => ({ ...item, first_buyer_reply_rate: item.runs ? Number((item.first_buyer_reply_count / item.runs).toFixed(3)) : 0, meeting_booked_rate: item.runs ? Number((item.meeting_booked_count / item.runs).toFixed(3)) : 0 })).sort((a, b) => b.first_buyer_reply_rate - a.first_buyer_reply_rate || b.meeting_booked_rate - a.meeting_booked_rate || b.runs - a.runs),
      by_group: Object.values(sliceGroup).map((item) => ({ ...item, meeting_booked_rate: item.runs ? Number((item.meeting_booked_count / item.runs).toFixed(3)) : 0 })).sort((a, b) => b.meeting_booked_rate - a.meeting_booked_rate || b.runs - a.runs),
      by_persona: Object.values(slicePersona).map((item) => ({ ...item, meeting_booked_rate: item.runs ? Number((item.meeting_booked_count / item.runs).toFixed(3)) : 0 })).sort((a, b) => b.meeting_booked_rate - a.meeting_booked_rate || b.runs - a.runs),
      by_signal_type: Object.values(sliceSignal).map((item) => ({ ...item, first_buyer_reply_rate: item.runs ? Number((item.first_buyer_reply_count / item.runs).toFixed(3)) : 0, meeting_booked_rate: item.runs ? Number((item.meeting_booked_count / item.runs).toFixed(3)) : 0 })).sort((a, b) => b.first_buyer_reply_rate - a.first_buyer_reply_rate || b.meeting_booked_rate - a.meeting_booked_rate || b.runs - a.runs),
      analytical_brief: analyticalBrief,
    },
    recent_finished: recentFinished,
    recent_finished_total: recentFinishedTotal,
  };
}

function loadHintMemoryStore() {
  return Array.isArray(hintMemoryCache?.data?.records) ? hintMemoryCache.data.records : [];
}

function saveHintMemoryStore(records) {
  const normalized = records
    .map((record, index) => normalizeHintMemoryRecord(record, index))
    .filter(Boolean)
    .slice(-HINT_MEMORY_MAX_RECORDS);
  hintMemoryCache = { mtimeMs: Date.now(), data: { version: HINT_MEMORY_VERSION, records: normalized } };
  if (storage.saveHintMemoryStore) {
    Promise.resolve(storage.saveHintMemoryStore({
      version: HINT_MEMORY_VERSION,
      updated_at: now(),
      records: normalized
    })).catch((err) => {
      console.error('[hint-memory] save error:', err?.message || err);
    });
  }
}

function normalizeHintText(text = '') {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s-]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

const SALES_ASSET_LIBRARY = {
  finance: {
    case_ru: [
      'Похожий finance-кейс обычно ломался не на headline rate, а после первого invoice, когда всплывали FX-сюрпризы и ручная сверка. Рабочий сдвиг происходил тогда, когда buyer заранее видел полную cost logic и incident path.',
      'В похожем кейсе buyer успокоился не после общих обещаний, а когда увидел один экран с economics, payout route и границей ответственности до первого платежа.'
    ],
    case_en: [
      'In a similar finance case, the real problem was not the headline rate but post-invoice FX surprise and manual reconciliation. The shift happened once full cost logic and the incident path were visible upfront.',
    ],
    proof_ru: 'Короткая записка на один экран: economics, scope boundary, incident path, что buyer видит заранее.',
    proof_en: 'A one-screen note: economics, scope boundary, incident path, and what the buyer sees upfront.',
    calculator_ru: 'Calculator snapshot как total-cost asset: ставка, FX, admin overhead, цена сбоя или задержки, плюс сравнение с ручным контуром.',
    calculator_en: 'A calculator snapshot as a total-cost asset: rate, FX, admin overhead, cost of delay or failure, and comparison with the manual setup.'
  },
  ops: {
    case_ru: [
      'В похожем ops-кейсе value появился не от новой платформы как таковой, а от того, что у команды исчезли chase-ups, ручные статусы и хаос на исключениях.',
      'Похожая операционная команда согласилась идти дальше только когда увидела owner model, escalation path и что именно исчезает из ручной координации.'
    ],
    case_en: [
      'In a similar ops case, the value was not a new platform as such, but fewer chase-ups, cleaner status handling, and less chaos around exceptions.',
    ],
    proof_ru: 'Короткая flow note: owner model, escalation path, scope boundary, что исчезает из ручной работы.',
    proof_en: 'A short flow note: owner model, escalation path, scope boundary, and what manual work disappears.',
    calculator_ru: 'Pilot-slice economics view: что меняется в admin overhead и сколько ручного времени возвращается команде.',
    calculator_en: 'A pilot-slice economics view: what changes in admin overhead and how much manual time returns to the team.'
  },
  transition: {
    case_ru: [
      'В похожем transition-кейсе разговор сдвигался не от общего возврата к CoR, а когда buyer видел узкий безопасный срез: кого переводим, что меняется в процессе и где остаётся контроль.',
      'В winback-кейсе следующий шаг появлялся только после того, как было ясно: это не большой replatforming, а ограниченный slice с понятной зоной ответственности и низким риском перехода.'
    ],
    case_en: [
      'In a similar transition case, the discussion moved only once the buyer saw a narrow safe slice: who moves, what changes operationally, and where control stays.',
    ],
    proof_ru: 'Короткая transition note: какой slice подходит, что меняется в процессе, где граница ответственности и почему переход безопасен.',
    proof_en: 'A short transition note: which slice fits, what changes operationally, where the responsibility boundary sits, and why the move is safe.',
    calculator_ru: 'Calculator здесь вторичен, использовать после того, как slice-fit и transition safety уже понятны.',
    calculator_en: 'Calculator is secondary here, use it only after slice fit and transition safety are already clear.'
  },
  legal: {
    case_ru: [
      'В похожем legal-trigger кейсе разговор сдвинулся только после того, как граница ответственности и audit trail стали объяснимыми без серых обещаний.',
    ],
    case_en: [
      'In a similar legal-trigger case, the discussion moved only once the responsibility boundary and audit trail became explainable without grey promises.',
    ],
    proof_ru: 'Короткий boundary memo: документы, trail, зона Mellow, что остаётся у клиента.',
    proof_en: 'A short boundary memo: documents, trail, Mellow scope, and what remains with the client.',
    calculator_ru: 'Calculator здесь вторичен, использовать только после того, как boundary и defensibility уже понятны.',
    calculator_en: 'Calculator is secondary here, use it only after boundary and defensibility are already clear.'
  }
};

function getAssetCluster(session) {
  const persona = personaMeta(session) || {};
  if (['panic_churn_ops', 'grey_pain_switcher'].includes(persona.id)) return 'ops';
  if (['cm_winback', 'direct_contract_transition'].includes(persona.id)) return 'transition';
  if (persona.archetype === 'legal') return 'legal';
  return 'finance';
}

function getRelevantSalesAssets(session, lang = 'ru') {
  const cluster = getAssetCluster(session);
  const assets = SALES_ASSET_LIBRARY[cluster] || SALES_ASSET_LIBRARY.finance;
  const buyerState = normalizeBuyerState(session?.buyer_state || buildInitialBuyerState(session), session);
  const acceptanceStage = session?.meta?.acceptance_stage || getBuyerAcceptanceStage(session);
  const sellerTurnCount = sellerMessages(session).length;
  const latestBuyer = latestBuyerReplyText(session).toLowerCase();
  const caseSnippet = pick(assets[lang === 'en' ? 'case_en' : 'case_ru']);
  const writtenProof = assets[lang === 'en' ? 'proof_en' : 'proof_ru'];
  const calculator = assets[lang === 'en' ? 'calculator_en' : 'calculator_ru'];
  const useCaseSnippet = sellerTurnCount >= 1 && ['mechanics_engaged', 'economics_engaged', 'proof'].some((x) => acceptanceStage === x || latestBuyer.includes(x));
  const useWrittenProof = sellerTurnCount >= 2 && ['economics_engaged', 'written_step_requested', 'written_step_accepted', 'review_call_ready'].includes(acceptanceStage);
  const useCalculator = sellerTurnCount >= 2 && (
    cluster !== 'legal' && (
      acceptanceStage === 'written_step_accepted'
      || acceptanceStage === 'review_call_ready'
      || buyerAskedFinanceEconomicsMath(session)
      || hasAny(latestBuyer, ['calculator', 'расч', 'экономик', 'стоимост', 'workload', 'admin overhead', 'нагрузк'])
      || Number(buyerState.clarity || 0) >= 55
    )
  );
  return {
    cluster,
    caseSnippet,
    writtenProof,
    calculator,
    useCaseSnippet,
    useWrittenProof,
    useCalculator,
  };
}

// Returns true when the seller has earned the right to propose a meeting or call.
// Guards against premature asks that tank trust before value is established.
function buyerShowsFinanceCallReadiness(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  return hasAny(lower, [
    'где заканчивается ваша ответственность', 'где ваша ответственность заканчивается', 'what exactly is included', 'where does your responsibility end',
    'как именно это выглядит', 'how exactly does this work', 'что именно входит', 'что именно вы берете на себя',
    'как это ляжет на finance', 'как это выглядит для finance', 'how this fits our finance process', 'how this fits finance',
    'давайте разберем', 'worth checking', 'имеет смысл проверить',
    'если реально созвонимся', 'если это выглядит реально созвонимся', 'if this looks real we can talk', 'if this looks real let\'s talk',
    'тогда созвонимся', 'then we can do a call', 'можем созвониться', 'we can do a call', 'созвонимся'
  ]);
}

function buyerShowsPostArtifactReviewReadiness(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  const acceptanceState = getBuyerAcceptanceState(session);
  const personaId = personaMeta(session)?.id || '';
  if (!['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState)) return false;

  if (hasAny(lower, [
    'давайте разберем', 'давайте разберём', 'имеет смысл проверить', 'worth checking',
    'похоже рабоче', 'выглядит рабоче', 'выглядит разумно', 'looks workable', 'looks grounded',
    'если материал нормальный', 'если записка нормальная', 'если это приземленно', 'если это приземлённо',
    'если это выглядит честно', 'if the note looks good', 'if this looks grounded',
    'после этого можно созвон', 'после этого можно созвониться', 'then we can do a call',
    'тогда можно созвон', 'можно коротко созвон', 'коротко созвон', 'short review works'
  ])) return true;

  if (sellerProposedBoundedReviewCall(session) && hasAny(lower, [
    'хорошо', 'ок', 'ладно', 'согласен', 'согласна', 'договорились', 'давайте',
    'присылайте', 'жду', 'посмотрю', 'works', 'fine', 'sounds good'
  ])) return true;

  if (isFinancePersonaId(personaId)) return buyerShowsFinanceCallReadiness(session);
  return false;
}

function isFinancePersonaId(personaId = '') {
  if (!personaId) return false;
  const persona = personas?.[personaId];
  return persona?.archetype === 'finance'
    || ['rate_floor_cfo', 'fx_trust_shock_finance', 'cfo_round', 'head_finance', 'andrey', 'cfo_price_pressure', 'fx_transparency_finance'].includes(personaId);
}

function buyerExplicitlyAcceptedWrittenStep(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  return hasAny(lower, [
    'договорились', 'хорошо', 'ок', 'ладно', 'согласен', 'согласна', 'присылайте', 'жду', 'посмотрю', 'скидывайте',
    'send it', 'send it over', 'works', 'fine', 'sounds good', 'deal', 'i will review', 'i\'ll review'
  ]);
}

function explicitWrittenRequest(text = '') {
  const lower = String(text || '').toLowerCase();
  return hasAny(lower, ['send', 'share', 'brief', 'memo', 'one-pager', 'пришлите', 'отправьте', 'материал', 'summary', 'записку', 'схему', 'следующий шаг только такой', 'нужен один экран', 'в одном экране', 'одним экраном', 'прозрачная схема стоимости', 'cost breakdown model', 'language of money', 'язык денег', 'занести цифры']);
}

function impliedStructuredArtifactRequest(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  const personaId = personaMeta(session)?.id || '';
  if (isFinancePersonaId(personaId)) {
    return hasAny(lower, [
      'в одном экране', 'одним экраном', 'language of money', 'язык денег',
      'занести цифры', 'разложите economics до конца', 'разложите по деньгам',
      'где ставка, где fx', 'где premium', 'где риск сбоя', 'где скрытая ручная цена',
      'где buyer видит заранее', 'видна до старта', 'прозрачная total-cost логика'
    ]);
  }
  if (['grey_pain_switcher', 'cm_winback'].includes(personaId)) {
    return hasAny(lower, [
      'занести цифры', 'по деньгам как', 'сколько', 'trial или сразу контракт',
      'без общих слов', 'конкретно'
    ]);
  }
  return false;
}

function explicitReviewReference(text = '') {
  const lower = String(text || '').toLowerCase();
  return hasAny(lower, ['review', 'walkthrough', 'созвон', 'встреч', 'call', 'meeting', '15 минут', '20 минут', '15 minute', '20 minute']);
}

function latestSellerReplyText(session) {
  const messages = sellerMessages(session);
  return String(messages[messages.length - 1]?.text || '').trim();
}

function sellerProposedBoundedReviewCall(session) {
  const lower = latestSellerReplyText(session).toLowerCase();
  return explicitReviewReference(lower)
    && hasAny(lower, ['15 минут', '20 минут', '15 minute', '20 minute', 'только', 'only'])
    && hasAny(lower, ['разбер', 'review', 'walkthrough', 'fit', 'boundary', 'economics', 'workflow', 'incident', 'slice', 'case']);
}

function canMakeAsk(session) {
  const persona = personaMeta(session) || {};
  const trust = session.meta?.trust || 1;
  const sellerTurnCount = sellerMessages(session).length;
  const missStreak = session.meta?.miss_streak || 0;
  const resolved = Object.keys(session.meta?.resolved_concerns || {}).length;
  const activeConcern = getActiveConcern(session);
  const buyerState = normalizeBuyerState(session.buyer_state || buildInitialBuyerState(session), session);
  const nextStepLikelihood = Number(buyerState.next_step_likelihood || 0);
  const acceptanceState = getBuyerAcceptanceState(session);
  const requestedArtifactType = detectRequestedArtifactType(session);
  const latestBuyerLower = latestBuyerReplyText(session).toLowerCase();
  const buyerStillAsksMechanics = buyerAskedFinanceMechanicsFlow(session);
  const buyerStillAsksEconomics = buyerAskedFinanceEconomicsMath(session);

  // Never ask on the first seller message or during an escalating miss streak
  if (sellerTurnCount < 2) return false;
  if (missStreak >= 3) return false;

  // Finance personas should earn the call, but once the buyer has explicitly tied the written step
  // to a follow-up review, the system must convert instead of looping on more material.
  if (isFinancePersonaId(persona.id)) {
    const artifactAccepted = buyerExplicitlyAcceptedWrittenStep(session);
    if ((buyerStillAsksMechanics || buyerStillAsksEconomics) && !(artifactAccepted && ['artifact_only', 'artifact_then_call'].includes(acceptanceState))) return false;
    if (acceptanceState === 'artifact_then_call') return trust >= 1.02;
    if (acceptanceState === 'artifact_only') {
      return trust >= 1.02
        && ['cost_breakdown', 'calculator_snapshot', 'competitor_brief', 'generic_artifact', 'implementation_memo', 'investor_readiness_memo', 'control_cost_memo'].includes(requestedArtifactType)
        && (buyerShowsFinanceCallReadiness(session) || artifactAccepted);
    }
    if (acceptanceState === 'narrow_walkthrough') return trust >= 1.04;
  }

  if (['internal_legal', 'external_legal', 'olga'].includes(persona.id)) {
    const artifactAccepted = buyerExplicitlyAcceptedWrittenStep(session);
    if (acceptanceState === 'artifact_then_call') return trust >= 1.0;
    if (acceptanceState === 'artifact_only') {
      return trust >= 0.98 && artifactAccepted;
    }
    if (acceptanceState === 'narrow_walkthrough') return trust >= 1.0;
  }

  // Once the buyer has already accepted a bounded artifact or post-artifact call contour,
  // the next move should be conversion, not more proving.
  if (['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState)) {
    if (buyerStillAsksMechanics || buyerStillAsksEconomics) return false;
    return trust >= 1.05;
  }

  // Trust must be meaningfully above baseline (baseline ~1.0)
  if (trust < 1.3) return false;
  // All concerns resolved and minimal trust established
  if (!activeConcern) return trust >= 1.2;
  // At least one concern addressed and buyer state trending toward next step
  if (resolved >= 1 && nextStepLikelihood >= 0.32) return true;
  // Do not allow Sandler-breaking premature asks purely from model enthusiasm.
  // A next step must be earned through at least one resolved concern or accepted bounded artifact path.
  return false;
}

function detectMeetingAskText(text = '') {
  const lower = String(text || '').toLowerCase();
  const patterns = [
    /\bcall\b/i,
    /\bmeeting\b/i,
    /\bwalkthrough\b/i,
    /\b(?:15|20)\s*[- ]?minute\b/i,
    /(^|[\s,;:!?()«»"'\-])созвон(?:иться|имся)?(?=$|[\s,;:!?()«»"'\-])/i,
    /(^|[\s,;:!?()«»"'\-])встреч[а-я]*(?=$|[\s,;:!?()«»"'\-])/i,
    /\b(?:15|20)\s*минут\b/i,
    /(возьм[её]м|найд[её]м|зафиксируем|поставим)\s+(?:коротк[а-я]*\s+)?(?:созвон|встреч|review)/i,
    /(когда\s+удобно|какой\s+слот|какой\s+слот\s+удобен|what\s+time\s+works|what\s+slot\s+works)/i,
  ];
  return patterns.some((pattern) => pattern.test(lower))
    || (/(?:15|20)\s*минут|(?:15|20)\s*[- ]?minute/i.test(lower) && /(когда\s+удобно|какой\s+слот|what\s+time\s+works|what\s+slot\s+works)/i.test(lower));
}

function latestBuyerReplyText(session) {
  const replies = (session?.transcript || []).filter((entry) => entry.role === 'bot');
  return replies.length ? String(replies[replies.length - 1].text || '') : '';
}

function buyerRequestedWrittenFirst(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  return hasAny(lower, [
    'send this in writing', 'send a brief', 'send a short summary', 'send a memo', 'send the flow', 'send it in writing',
    'пришлите', 'отправьте', 'в письменном виде', 'сначала материал', 'сначала документ', 'пришли brief', 'пришли summary',
    'в одном экране', 'одним экраном', 'language of money', 'язык денег', 'занести цифры'
  ]) || impliedStructuredArtifactRequest(session);
}

function buyerNeedsImplementationReview(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  return hasAny(lower, [
    'api', 'mcp', 'integration', 'integrate', 'workflow', 'implementation team', 'implementation', 'onboarding team',
    'enterprise', 'contractor administration', 'vendor management', 'zero cost', 'pilot',
    'апи', 'интеграц', 'воркфло', 'внедрен', 'команда внедрения', 'enterprise', 'администрирование подрядчиков', 'zero cost', 'без затрат на старт', 'пилот'
  ]);
}

function buyerNeedsConcreteFinanceProof(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  const personaId = personaMeta(session)?.id;
  if (!isFinancePersonaId(personaId)) return false;
  return hasAny(lower, [
    'что именно', 'по шагам', 'где именно', 'в чем именно', 'какая разница в economics', 'разница в economics', 'правильные слова не аргумент',
    'разложите', 'разложи', 'покажите механику', 'покажите математику', 'покажите логику', 'что у вас входит', 'что остается на нашей стороне',
    'manual load', 'hidden cost', 'effective cost', 'cost of delay', 'where exactly', 'what exactly', 'show me the math', 'show the logic'
  ]);
}

function buyerAskedFinanceMechanicsFlow(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  return hasAny(lower, [
    'по шагам', 'механик', 'что именно делает mellow', 'что именно делает', 'что остается на нашей стороне', 'что у вас входит', 'как это работает',
    'документ', 'платежн', 'платёжн', 'payment flow', 'payout flow', 'инцидент', 'scope пока размыт', 'схема пока размыта', 'граница ответственности'
  ]);
}

function buyerAskedFinanceEconomicsMath(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  return hasAny(lower, [
    'разница в economics', 'где разница', 'в чем разница', 'правильные слова не аргумент', 'покажите математику', 'покажите логику', 'почему дороже',
    'разложите premium на язык денег', 'язык денег', 'за что конкретно я плачу', 'effective cost', 'total-cost', 'полная стоимость', 'прозрачная total-cost логика', 'до invoicing', 'до платежа', 'где buyer заранее видит', 'предсказуемая математика',
    'show me the math', 'show the logic', 'where exactly', 'what exactly is the difference'
  ]);
}

function detectRequestedArtifactType(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  const persona = personaMeta(session) || {};
  const explicitSendRequest = explicitWrittenRequest(lower) || impliedStructuredArtifactRequest(session);
  const explicitReviewRequest = explicitReviewReference(lower);
  if (hasAny(lower, ['calculator', 'snapshot', 'cost model', 'hourly cost', 'admin overhead', 'workload', 'калькулятор', 'снимок расчета', 'снимок расчёта', 'нагрузк', 'расч']) && (explicitSendRequest || explicitReviewRequest)) {
    return 'calculator_snapshot';
  }
  if (hasAny(lower, ['cost breakdown', 'total-cost', 'effective cost', 'pricing logic', 'math upfront', 'стоимост', 'цена', 'стоимость', 'effective cost', 'математ', 'экономик']) && (explicitSendRequest || explicitReviewRequest)) {
    if (['panic_churn_ops', 'grey_pain_switcher', 'cm_winback', 'direct_contract_transition'].includes(persona.id)) {
      return null;
    }
    return 'cost_breakdown';
  }
  if (hasAny(lower, ['competitor', 'compare', 'why you over cheaper', 'cheaper option', 'конкурент', 'дешевле', 'сравн', 'почему дороже']) && (explicitSendRequest || explicitReviewRequest)) {
    return 'competitor_brief';
  }
  if (hasAny(lower, ['implementation', 'integration', 'api', 'mcp', 'workflow', 'onboarding', 'pilot', 'внедрен', 'интеграц', 'api', 'mcp', 'воркфло', 'пилот']) && (explicitSendRequest || explicitReviewRequest)) {
    return 'implementation_memo';
  }
  if (hasAny(lower, ['slice', 'scope', 'who exactly', 'which use case', 'кого именно', 'какой срез', 'какой кейс', 'какой кусок']) && (explicitSendRequest || explicitReviewRequest)) {
    return 'slice_map';
  }
  if (explicitSendRequest) {
    return 'generic_artifact';
  }
  return null;
}

function getBuyerAcceptanceState(session) {
  if (session?.meta?.meeting_booked === true || sessionHasMeetingBooked(session)) return 'direct_call';
  const previousState = session?.meta?.acceptance_state || 'not_ready';
  const lower = latestBuyerReplyText(session).toLowerCase();
  const persona = personaMeta(session) || {};
  if (!lower) return previousState;

  let currentState = 'not_ready';
  if (detectBuyerMeetingAcceptance(lower, session?.language || 'ru')) {
    currentState = 'direct_call';
  } else if (
    ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(previousState)
    && sellerProposedBoundedReviewCall(session)
    && hasAny(lower, ['договорились', 'хорошо', 'ок', 'ладно', 'согласен', 'согласна', 'присылайте', 'жду', 'посмотрю', 'давайте'])
  ) {
    currentState = 'direct_call';
  } else if (
    previousState === 'artifact_only'
    && ['panic_churn_ops', 'grey_pain_switcher', 'cm_winback', 'direct_contract_transition'].includes(persona.id)
    && hasAny(lower, ['cost', 'price', 'pricing', 'trial', 'pilot', 'setup', 'team time', 'implementation', 'стоим', 'цена', 'пилот', 'переход', 'время команды'])
  ) {
    currentState = 'narrow_walkthrough';
  } else if (/(созвон|встреч|call|meeting|walkthrough|review call)/i.test(lower) && /(потом|после|then|after|if|если)/i.test(lower)) {
    currentState = 'artifact_then_call';
  } else if (/(walkthrough|review|15 минут|15-минут|15 minute|20 minute|созвон)/i.test(lower) && !buyerRequestedWrittenFirst(session)) {
    currentState = 'narrow_walkthrough';
  } else if (buyerRequestedWrittenFirst(session) || detectRequestedArtifactType(session)) {
    currentState = 'artifact_only';
  }

  if (currentState === 'not_ready' && ['artifact_only', 'artifact_then_call', 'narrow_walkthrough', 'direct_call'].includes(previousState)) {
    return previousState;
  }
  return currentState;
}

function getBuyerAcceptanceStage(session) {
  if (session?.meta?.meeting_booked === true || sessionHasMeetingBooked(session)) return 'meeting_booked';
  const lower = latestBuyerReplyText(session).toLowerCase();
  const acceptanceState = getBuyerAcceptanceState(session);
  const buyerState = normalizeBuyerState(session?.buyer_state || buildInitialBuyerState(session), session);
  const personaId = personaMeta(session)?.id || '';

  if (acceptanceState === 'narrow_walkthrough' || buyerShowsFinanceCallReadiness(session)) return 'review_call_ready';
  if (acceptanceState === 'artifact_then_call') return 'written_step_then_call';
  if (acceptanceState === 'artifact_only') return 'written_step_accepted';
  if (explicitWrittenRequest(lower)) return 'written_step_requested';
  if (isFinancePersonaId(personaId) && (buyerAskedFinanceEconomicsMath(session) || Number(buyerState.clarity || 0) >= 55)) return 'economics_engaged';
  if (buyerAskedFinanceMechanicsFlow(session) || Number(buyerState.clarity || 0) >= 40) return 'mechanics_engaged';
  return 'not_ready';
}

function getBuyerAcceptanceStageReasons(session) {
  const lower = latestBuyerReplyText(session).toLowerCase();
  const reasons = [];
  if (buyerAskedFinanceMechanicsFlow(session)) reasons.push('buyer_asked_mechanics');
  if (buyerAskedFinanceEconomicsMath(session)) reasons.push('buyer_asked_economics');
  if (explicitWrittenRequest(lower)) reasons.push('buyer_requested_written_material');
  if (explicitReviewReference(lower)) reasons.push('buyer_referenced_review_or_call');
  if (buyerShowsFinanceCallReadiness(session)) reasons.push('buyer_signaled_call_readiness');
  if (detectBuyerMeetingAcceptance(lower, session?.language || 'ru')) reasons.push('buyer_explicitly_accepted_meeting');
  return reasons;
}

function getAcceptanceEventType(session) {
  const state = getBuyerAcceptanceState(session);
  const artifactType = detectRequestedArtifactType(session);
  if (state === 'direct_call') return 'accepts_direct_call';
  if (state === 'narrow_walkthrough') return 'accepts_narrow_walkthrough';
  if (state === 'artifact_then_call') {
    if (artifactType === 'cost_breakdown') return 'accepts_cost_breakdown_then_call';
    if (artifactType === 'implementation_memo') return 'accepts_implementation_review_then_call';
    if (artifactType === 'competitor_brief') return 'accepts_competitor_brief_then_call';
    return 'accepts_artifact_then_call';
  }
  if (state === 'artifact_only') {
    if (artifactType === 'cost_breakdown') return 'accepts_cost_breakdown';
    if (artifactType === 'implementation_memo') return 'accepts_implementation_review';
    if (artifactType === 'competitor_brief') return 'accepts_competitor_brief';
    if (artifactType === 'slice_map') return 'accepts_slice_map';
    return 'accepts_artifact';
  }
  return null;
}

function getPersonaAcceptanceBias(session) {
  const persona = personaMeta(session) || {};
  if (persona.archetype === 'finance') return 'cost_breakdown_first';
  if (['panic_churn_ops', 'grey_pain_switcher'].includes(persona.id)) return 'workflow_review_first';
  if (['cm_winback', 'direct_contract_transition'].includes(persona.id)) return 'transition_review_first';
  if (persona.archetype === 'ops') return 'workflow_review_first';
  if (persona.archetype === 'legal') return 'artifact_before_call';
  if (['panic_churn_ops', 'fx_trust_shock_finance', 'cm_winback'].includes(persona.id)) return 'trust_repair_before_direct_call';
  return 'default';
}

const PERSONA_SELLING_POLICY = {
  rate_floor_cfo: {
    proof_focus: ['cost_predictability', 'defendable_structure', 'incident_ownership', 'clarity_of_scheme'],
    bridge_asset: 'cost_breakdown',
    bridge_label: 'short premium logic breakdown with boundary and incident path',
  },
  fx_trust_shock_finance: {
    proof_focus: ['cost_predictability', 'clarity_of_scheme', 'defendable_structure', 'recovery_visibility', 'incident_ownership'],
    bridge_asset: 'cost_breakdown',
    bridge_label: 'short total-cost breakdown with visible FX and incident path',
  },
  cfo_round: {
    proof_focus: ['cost_predictability', 'defendable_structure', 'clarity_of_scheme', 'incident_ownership'],
    bridge_asset: 'investor_readiness_memo',
    bridge_label: 'short investor-readiness economics memo with control boundary',
  },
  head_finance: {
    proof_focus: ['cost_predictability', 'clarity_of_scheme', 'defendable_structure', 'incident_ownership'],
    bridge_asset: 'control_cost_memo',
    bridge_label: 'short control-cost memo with manual-load reduction and audit trail',
  },
  cm_winback: {
    proof_focus: ['clarity_of_scheme', 'defendable_structure', 'slice_specific_fit'],
    bridge_asset: 'slice_map',
    bridge_label: 'narrow slice-fit map',
  },
  grey_pain_switcher: {
    proof_focus: ['incident_ownership', 'defendable_structure', 'clarity_of_scheme'],
    bridge_asset: 'incident_boundary_memo',
    bridge_label: 'incident-owner + responsibility-boundary note',
  },
  direct_contract_transition: {
    proof_focus: ['defendable_structure', 'slice_specific_fit', 'clarity_of_scheme'],
    bridge_asset: 'slice_map',
    bridge_label: 'narrow transition slice map',
  },
  panic_churn_ops: {
    proof_focus: ['incident_ownership', 'defendable_structure', 'recovery_visibility', 'clarity_of_scheme'],
    bridge_asset: 'recovery_plan',
    bridge_label: 'short recovery and escalation plan',
  },
};

function getPersonaSellingPolicy(session) {
  const persona = personaMeta(session) || {};
  const focus = PERSONA_SELLING_POLICY[persona.id] || {};
  return {
    proof_focus: focus.proof_focus || ['defendable_structure', 'clarity_of_scheme'],
    bridge_asset: focus.bridge_asset || 'memo',
    bridge_label: focus.bridge_label || 'short written brief',
  };
}

function getPersonaValueFrameSummary(session) {
  const labels = {
    defendable_structure: 'defendable structure',
    incident_ownership: 'incident ownership',
    clarity_of_scheme: 'clarity of scheme',
    cost_predictability: 'cost predictability',
    recovery_visibility: 'recovery visibility',
    slice_specific_fit: 'slice-specific fit',
  };
  return getPersonaSellingPolicy(session).proof_focus.map((key) => labels[key] || key).join(', ');
}

function getAskIntent(session) {
  const artifactType = detectRequestedArtifactType(session);
  const askType = getPersonaAskType(session);
  const acceptanceState = getBuyerAcceptanceState(session);

  // Once the buyer already accepted a bridge artifact, the ask intent must convert to a call,
  // not repeat another artifact review loop.
  if (['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState)) {
    if (askType === 'narrow_walkthrough') return 'narrow_feasibility_call';
    if (askType === 'direct_call') return 'direct_call';
  }

  if (artifactType === 'cost_breakdown') return 'cost_breakdown_review';
  if (artifactType === 'competitor_brief') return 'competitor_proof_brief';
  if (artifactType === 'implementation_memo') return askType === 'written_first' ? 'implementation_memo' : 'workflow_fit_review';
  if (artifactType === 'slice_map') return 'slice_map_review';
  if (askType === 'narrow_walkthrough') return 'narrow_feasibility_call';
  if (askType === 'direct_call') return 'direct_call';
  return 'artifact_then_call';
}

function detectBuyerWinPattern(session) {
  const persona = personaMeta(session) || {};
  const lower = latestBuyerReplyText(session).toLowerCase();
  const wholeTranscript = ((session?.transcript || [])
    .filter((entry) => entry.role === 'bot')
    .map((entry) => String(entry.text || '').toLowerCase())
    .join(' '));

  if (hasAny(lower, [
    'only option', 'no other option', 'the only solution', 'only working', 'the only company',
    'нет других вариантов', 'других вариантов нет', 'единственный вариант', 'единственное решение', 'только вы можете',
    'russia', 'belarus', 'rubles', 'рубл', 'росси', 'беларус', 'банк перестал', 'bank stopped', 'can\'t pay'
  ])) {
    return 'only_working_option';
  }

  if (hasAny(wholeTranscript, [
    'competitor', 'cheaper', 'lower rate', '3%', '2.5%', '3.5%', 'easystaff', '4dev', 'deel', 'remote', 'garnu', 'stape',
    'конкурент', 'дешев', 'дешевле', 'ставк', 'процент', 'easystaff', '4dev', 'deel', 'remote', 'garnu', 'stape',
    'reliable', 'reliability', 'sanctions-safe', 'hard geo', 'cis', 'pakistan', 'india', 'africa', 'latam', 'asia',
    'надежн', 'надежност', 'санкц', 'тяжел', 'снг', 'пакистан', 'инд', 'африк', 'латам', 'ази'
  ]) || ['rate_floor_cfo'].includes(persona.id)) {
    return 'competitive_reliability';
  }

  if (buyerNeedsImplementationReview(session) || hasAny(wholeTranscript, [
    'find and select', 'contract and pay', 'implementation team', 'workflow embedding', 'contractor administration',
    'найти и выбрать', 'оформить сделку', 'оплатить фрилансера', 'команда внедрения', 'встроить в процессы', 'администрирование подрядчиков'
  ])) {
    return 'enterprise_embedding';
  }

  if (hasAny(wholeTranscript, [
    'audit', 'due diligence', 'misclassification', 'investor', 'lawyer', 'legal team',
    'аудит', 'дью дилидженс', 'misclassification', 'инвест', 'юрист', 'legal'
  ]) || ['grey_pain_switcher', 'panic_churn_ops'].includes(persona.id)) {
    return 'compliance_trigger';
  }

  if (hasAny(wholeTranscript, [
    'crypto', 'cryptocurrency', 'informal', 'off-books', 'off the books',
    'крипт', 'неформаль', 'в серую', 'серую схему'
  ])) {
    return 'crypto_replacement';
  }

  if (hasAny(wholeTranscript, [
    'one invoice', 'single invoice', 'admin', 'manual', 'status chasing', 'reconciliation',
    'один инвойс', 'ручн', 'сверк', 'статус', 'админ'
  ])) {
    return 'operational_simplicity';
  }

  return null;
}

// Detect when trust has been meaningfully damaged and needs explicit repair before asking.
// Repair is needed when: miss streak active AND trust hasn't recovered to ask threshold yet.
function needsTrustRepair(session) {
  const trust = session.meta?.trust || 1;
  const missStreak = session.meta?.miss_streak || 0;
  const sellerTurnCount = sellerMessages(session).length;
  if (sellerTurnCount < 1) return false;
  return missStreak >= 1 && trust >= 0.7 && trust < 1.3;
}

// Determine the right ask type based on persona + current buyer state.
// 'written_first'    — send artifact (brief, memo, 1-pager) before committing to a call
// 'direct_call'      — trust and clarity are high enough to propose call directly
// 'narrow_walkthrough' — damaged trust or residual skepticism: narrow-scope walkthrough, not a full call
function getPersonaAskType(session) {
  const persona = personaMeta(session);
  const buyerState = normalizeBuyerState(session.buyer_state || buildInitialBuyerState(session), session);
  const clarity = Number(buyerState.clarity || 50);
  const trust = Number(buyerState.trust || 50);
  const nextStepLikelihood = Number(buyerState.next_step_likelihood || 0);
  const missStreak = session.meta?.miss_streak || 0;
  const acceptanceState = getBuyerAcceptanceState(session);

  // After the buyer already accepted the written bridge, the next move must be a call-close,
  // not another written-first loop.
  if (['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState)) {
    if (['cm_winback', 'grey_pain_switcher', 'panic_churn_ops', 'direct_contract_transition'].includes(persona?.id)) {
      return 'narrow_walkthrough';
    }
    if (persona?.archetype === 'finance') return 'narrow_walkthrough';
    return 'direct_call';
  }

  if (buyerRequestedWrittenFirst(session)) return 'written_first';
  if (buyerNeedsImplementationReview(session)) return clarity >= 58 ? 'narrow_walkthrough' : 'written_first';
  // Legal personas always want written review first — they need to assess before committing
  if (persona?.archetype === 'legal') return 'written_first';
  if (persona?.id === 'panic_churn_ops') {
    if (clarity < 68 || trust < 64 || nextStepLikelihood < 0.5) return 'written_first';
    return nextStepLikelihood >= 0.62 ? 'narrow_walkthrough' : 'written_first';
  }
  if (persona?.id === 'grey_pain_switcher') {
    if (clarity < 66 || trust < 62 || nextStepLikelihood < 0.48) return 'written_first';
    return nextStepLikelihood >= 0.58 ? 'narrow_walkthrough' : 'written_first';
  }
  if (persona?.id === 'cm_winback') {
    if (clarity < 64 || trust < 60 || nextStepLikelihood < 0.48) return 'written_first';
    return nextStepLikelihood >= 0.6 ? 'narrow_walkthrough' : 'written_first';
  }
  if (persona?.id === 'direct_contract_transition') {
    if (clarity < 62 || trust < 58 || nextStepLikelihood < 0.46) return 'written_first';
    return nextStepLikelihood >= 0.58 ? 'narrow_walkthrough' : 'written_first';
  }
  if (persona?.id === 'fx_trust_shock_finance') {
    if (clarity < 72 || trust < 62) return 'written_first';
    return nextStepLikelihood >= 0.64 ? 'narrow_walkthrough' : 'written_first';
  }
  if (persona?.id === 'cfo_round') {
    if (clarity < 66 || trust < 58 || nextStepLikelihood < 0.54) return 'written_first';
    return nextStepLikelihood >= 0.68 ? 'narrow_walkthrough' : 'written_first';
  }
  if (persona?.id === 'head_finance') {
    if (clarity < 64 || trust < 58 || nextStepLikelihood < 0.52) return 'written_first';
    return nextStepLikelihood >= 0.66 ? 'narrow_walkthrough' : 'written_first';
  }
  if (persona?.id === 'rate_floor_cfo') {
    if (['artifact_only', 'artifact_then_call'].includes(acceptanceState)) return 'written_first';
    if (clarity < 72 || trust < 64 || nextStepLikelihood < 0.66) return 'written_first';
    return nextStepLikelihood >= 0.78 ? 'narrow_walkthrough' : 'written_first';
  }
  // Trust was damaged (miss streak happened during follow-up) — offer a narrow scope walk
  if (missStreak >= 1) return 'narrow_walkthrough';
  // High buyer momentum — go direct
  if (nextStepLikelihood >= 0.6) return 'direct_call';
  // Finance with low clarity — send artifact first, then call
  if (persona?.archetype === 'finance' && clarity < 55) return 'written_first';
  // Ops personas are speed-driven — direct call by default
  if (persona?.archetype === 'ops') return 'direct_call';
  return 'written_first';
}

// Six-stage seller progression model:
//   opening → diagnosis → proof → trust_repair → pre_ask → closing
// Replaces the previous three-stage model (opening / follow_up / closing).
function getSellerProgressionStage(session) {
  const sellerTurnCount = sellerMessages(session).length;
  const buyerTurnCount = (session?.transcript || []).filter((entry) => entry.role === 'bot').length;
  if (sellerTurnCount === 0) return 'opening';
  if (canMakeAsk(session)) return 'closing';
  if (needsTrustRepair(session)) return 'trust_repair';
  const trust = session.meta?.trust || 1;
  const resolvedCount = Object.keys(session.meta?.resolved_concerns || {}).length;
  const buyerState = normalizeBuyerState(session.buyer_state || buildInitialBuyerState(session), session);
  const nextStepLikelihood = Number(buyerState.next_step_likelihood || 0);
  // Pre-ask: trust is building, at least one concern addressed, buyer trending toward next step
  if (trust >= 1.2 && nextStepLikelihood >= 0.25 && resolvedCount >= 1) return 'pre_ask';
  // Proof should begin as soon as the buyer has replied once and exposed the first concern.
  // Otherwise the simulator over-stays in diagnosis and keeps asking instead of answering.
  if (resolvedCount >= 1 || (sellerTurnCount >= 1 && buyerTurnCount >= 1)) return 'proof';
  return 'diagnosis';
}

function getHintPolicyContext(session) {
  const progressionStage = getSellerProgressionStage(session);
  const askAllowed = canMakeAsk(session);
  const repairState = needsTrustRepair(session);
  const askType = getPersonaAskType(session);
  const askIntent = getAskIntent(session);
  const acceptanceState = getBuyerAcceptanceState(session);
  const requestedArtifactType = detectRequestedArtifactType(session);
  const buyerAskedForMaterial = buyerRequestedWrittenFirst(session);
  const buyerAskedForImplementation = buyerNeedsImplementationReview(session);
  const buyerState = normalizeBuyerState(session.buyer_state || buildInitialBuyerState(session), session);
  const trust = Number(buyerState.trust || 0);
  const clarity = Number(buyerState.clarity || 0);
  const resolvedCount = Object.keys(session.meta?.resolved_concerns || {}).length;
  const buyerNeedsConcreteFinanceMechanics = buyerNeedsConcreteFinanceProof(session);
  const buyerNeedsFinanceMath = buyerAskedFinanceEconomicsMath(session);

  let hintStage = 'proof';
  if (sellerMessages(session).length === 0 || progressionStage === 'opening' || progressionStage === 'diagnosis') {
    hintStage = 'diagnosis';
  } else if (repairState || progressionStage === 'trust_repair') {
    // Hard rule: repair state blocks all asks — no direct_ask, no bridge_step push
    hintStage = 'repair';
  } else if (askAllowed || progressionStage === 'closing') {
    // Mandatory bridge-step layer: direct_ask requires a prior bridge_step in recent history,
    // unless buyer is already signalling high next-step readiness (>= 0.6).
    const nextStepLikelihood = Number(buyerState.next_step_likelihood || 0);
    if (nextStepLikelihood < 0.6 && !hasBridgeStepInRecentHistory(session)) {
      hintStage = 'bridge_step';
    } else {
      hintStage = 'direct_ask';
    }
  } else if (progressionStage === 'pre_ask' && resolvedCount >= 1 && trust >= 50) {
    hintStage = 'bridge_step';
  } else {
    hintStage = buyerNeedsConcreteFinanceMechanics && sellerMessages(session).length >= 2 ? 'bridge_step' : 'proof';
  }

  if (buyerNeedsFinanceMath && sellerMessages(session).length >= 2 && !repairState) {
    hintStage = 'bridge_step';
  }

  // When the buyer explicitly asks for written material or implementation shape,
  // move out of proof mode. But keep the pressure calibrated:
  // - most personas: artifact_only => bounded bridge step (send artifact + light upfront contract)
  // - artifact_then_call / narrow_walkthrough => direct ask is now earned
  // - ops / transition / recovery cluster: once the buyer accepts the bounded written step,
  //   the conversion move is to lock the review slot now, not keep re-offering the same memo.
  if ((buyerAskedForMaterial || buyerAskedForImplementation || requestedArtifactType || ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState)) && sellerMessages(session).length >= 2 && !repairState) {
    const personaId = personaMeta(session)?.id;
    const financeConversionPersona = isFinancePersonaId(personaId);
    const legalConversionPersona = ['internal_legal', 'external_legal', 'olga'].includes(personaId);
    const forceDirectAfterArtifact = financeConversionPersona && ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState);
    const forceConversionDirectAsk = ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState) && ['panic_churn_ops', 'grey_pain_switcher', 'cm_winback', 'direct_contract_transition'].includes(personaId);
    const forceLegalDirectAsk = legalConversionPersona && ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState);
    hintStage = (acceptanceState === 'artifact_only' && !forceDirectAfterArtifact && !forceConversionDirectAsk && !forceLegalDirectAsk) ? 'bridge_step' : 'direct_ask';
  }

  // Constrained retry paths: prevent infinite looping at bridge_step or direct_ask
  hintStage = getConstrainedHintStage(session, hintStage);

  return {
    progressionStage,
    hintStage,
    askAllowed,
    repairState,
    askType,
    askIntent,
    acceptanceState,
    requestedArtifactType,
    buyerState,
    activeConcern: getActiveConcern(session),
  };
}

// MEL-1043: Strict stage-bound hint doctrine.
// Five and only five allowed hint modes. Any generated hint must classify into exactly one.
const ALLOWED_HINT_MODES = ['diagnosis', 'proof', 'repair', 'bridge_step', 'direct_ask'];

function getSpinLane(session, policy = null) {
  const p = policy || getHintPolicyContext(session);
  if (p.hintStage === 'diagnosis') {
    return sellerMessages(session).length === 0 ? 'situation' : 'problem';
  }
  if (p.hintStage === 'proof') return 'implication';
  if (p.hintStage === 'repair') return 'problem';
  return 'need_payoff';
}

function getSpinInstruction(session, policy = null) {
  const lane = getSpinLane(session, policy);
  if (lane === 'situation') {
    return 'SPIN = Situation. Anchor in one concrete observable context fact, then ask one narrow diagnostic question. Do not pitch.';
  }
  if (lane === 'problem') {
    return 'SPIN = Problem. Surface the friction, risk, or blockage explicitly. Ask one focused question that reveals what is hard or unstable now.';
  }
  if (lane === 'implication') {
    return 'SPIN = Implication. Make the business consequence sharper: what breaks, costs more, slows down, or becomes risky if the problem stays unresolved.';
  }
  return 'SPIN = Need-payoff. Translate momentum into a concrete next-step benefit. Show why a short call helps the buyer verify fit faster than more abstract discussion.';
}

function getSandlerInstruction(session, policy = null) {
  const p = policy || getHintPolicyContext(session);
  if (p.hintStage === 'diagnosis') {
    return 'Sandler = pain-first qualification. Keep control of the conversation by asking one focused question, not pitching. Earn the right to continue before proposing anything.';
  }
  if (p.hintStage === 'proof') {
    return 'Sandler = deepen pain before solution breadth. Tie the answer to the buyer\'s pain and business cost. No premature demo, no generic product tour.';
  }
  if (p.hintStage === 'repair') {
    return 'Sandler = lower pressure and re-establish trust. Acknowledge friction, narrow the scope, and regain permission to continue.';
  }
  if (p.hintStage === 'bridge_step') {
    return 'Sandler = upfront contract for the next micro-step. Offer one low-pressure, bounded next step with a clear purpose, scope, and expected outcome.';
  }
  return 'Sandler = clear upfront contract for the call. State the exact purpose, narrow scope, and why this next step is worth the buyer\'s time. No broad pitch.';
}

// computeHintSchema: produces the internal hint doctrine packet for a turn.
// Schema fields:
//   hint_stage           — which of the 5 allowed modes applies this turn
//   buyer_state_summary  — compact human-readable state snapshot
//   obstacle_to_progress — what is blocking advancement to the next stage
//   missing_condition    — the single condition that must be met to progress
//   recommended_action   — what the hint must accomplish this turn
//   forbidden_action     — what the hint must NOT do this turn
function computeHintSchema(session, policy) {
  const p = policy || getHintPolicyContext(session);
  const spinLane = getSpinLane(session, p);
  const spinInstruction = getSpinInstruction(session, p);
  const sandlerInstruction = getSandlerInstruction(session, p);
  const bs = p.buyerState || {};
  const trust = Number(bs.trust || 0);
  const clarity = Number(bs.clarity || 0);
  const nextStep = Number(bs.next_step_likelihood || 0);
  const concern = p.activeConcern || null;
  const resolvedCount = Object.keys(session.meta?.resolved_concerns || {}).length;
  const missStreak = session.meta?.miss_streak || 0;
  const personaPolicy = getPersonaSellingPolicy(session);
  const personaFocus = getPersonaValueFrameSummary(session);

  const buyer_state_summary = [
    `trust:${trust}`,
    `clarity:${clarity}`,
    `next_step_likelihood:${nextStep}`,
    missStreak > 0 ? `miss_streak:${missStreak}` : null,
    concern ? `active_concern:${concern}` : `concerns_resolved:${resolvedCount}`,
  ].filter(Boolean).join(', ');

  const schemas = {
    diagnosis: {
      obstacle_to_progress: concern
        ? `Active concern not yet surfaced: ${concern}`
        : 'Buyer motivation and main pain point not yet identified',
      missing_condition: "Identify the buyer's primary concern or pain point",
      recommended_action: 'Ask one focused pain-first question to surface the next missing condition and earn permission to continue',
      forbidden_action: 'No meeting ask, no pitch, no multi-part question',
    },
    proof: {
      obstacle_to_progress: concern
        ? `Concern not yet resolved with concrete mechanism: ${concern}`
        : 'No active concern to resolve',
      missing_condition: `Resolve active concern with one concrete Mellow mechanism (${concern || 'scope'})`,
      recommended_action: `Address the concern with one specific proof point or mechanism, tie it to buyer pain and implication, then ask one follow-up if needed`,
      forbidden_action: 'No meeting ask, no broad pitch, no multiple proof points at once',
    },
    repair: {
      obstacle_to_progress: `Trust damaged — miss_streak:${missStreak}, trust:${trust}/100`,
      missing_condition: 'Trust must recover above threshold before an ask is valid',
      recommended_action: 'Narrow to one specific point that addresses what caused trust drop, without overclaiming',
      forbidden_action: 'No meeting ask, no broad pitch, no repetition of the same point that caused the drop',
    },
    bridge_step: {
      obstacle_to_progress: `Not yet ask-ready — trust:${trust}/100, clarity:${clarity}/100, next_step:${nextStep}`,
      missing_condition: 'Buyer needs one bounded intermediate commitment before a direct ask is credible',
      recommended_action: `Offer exactly one low-pressure upfront contract matching ask type: ${p.askType || 'written_first'} using the preferred bridge asset (${personaPolicy.bridge_label}), with clear scope and outcome`,
      forbidden_action: 'No direct meeting ask, no broad call proposal, no multiple options at once',
    },
    direct_ask: {
      obstacle_to_progress: 'None — ask conditions are met',
      missing_condition: 'Explicit buyer agreement to a call or meeting',
      recommended_action: `Propose the next step directly using ask type: ${p.askType || 'written_first'}, with a clear upfront contract on purpose, scope, and expected outcome`,
      forbidden_action: 'No diagnosis, no proof, no additional qualification — commit to the ask',
    },
  };

  const s = schemas[p.hintStage] || schemas.proof;
  return {
    hint_stage: p.hintStage,
    spin_lane: spinLane,
    spin_instruction: spinInstruction,
    sandler_instruction: sandlerInstruction,
    buyer_state_summary,
    obstacle_to_progress: s.obstacle_to_progress,
    missing_condition: s.missing_condition,
    recommended_action: s.recommended_action,
    forbidden_action: s.forbidden_action,
  };
}

// getHintVariant: detect retry state for the current hint stage.
// Returns 'first_attempt' if this is the first try at this stage (or if prior turn made progress).
// Returns 'retry_N' (N ≥ 1) if N consecutive hints at this stage showed no buyer progress.
function getHintVariant(session, currentHintStage) {
  const sellerEntries = (session?.transcript || []).filter((e) => e.role === 'seller');
  if (sellerEntries.length === 0) return 'first_attempt';

  let retryCount = 0;
  for (let i = sellerEntries.length - 1; i >= 0; i -= 1) {
    const entry = sellerEntries[i];
    if (entry.hint_stage !== currentHintStage) break;
    const delta = entry.buyer_state_transition?.predicted_delta || {};
    const trustDelta = Number(delta.trust || 0);
    const clarityDelta = Number(delta.clarity || 0);
    const metricsBefore = entry.buyer_state_transition?.derived_metrics_before || {};
    const metricsAfter = entry.buyer_state_transition?.derived_metrics_after || {};
    const nextStepDelta = Number(metricsAfter.next_step_likelihood || 0) - Number(metricsBefore.next_step_likelihood || 0);
    const madeProgress = trustDelta > 2 || clarityDelta > 2 || nextStepDelta > 0.05;
    if (madeProgress) break;
    retryCount += 1;
  }

  return retryCount === 0 ? 'first_attempt' : `retry_${retryCount}`;
}

// Returns true if the seller gave a bridge_step hint within the last `lookback` seller turns.
// Used to enforce the mandatory bridge-step layer before a direct_ask is allowed.
function hasBridgeStepInRecentHistory(session, lookback = 6) {
  const sellerEntries = (session?.transcript || []).filter((e) => e.role === 'seller');
  const recent = sellerEntries.slice(-lookback);
  return recent.some((e) => e.hint_stage === 'bridge_step');
}

// Enforces constrained retry paths after failed asks:
//   - direct_ask with no progress on first retry → narrow to bridge_step
//   - bridge_step with no progress after 2 retries → step back to proof or diagnosis
function getConstrainedHintStage(session, baseHintStage) {
  const personaId = personaMeta(session)?.id;
  const acceptanceState = getBuyerAcceptanceState(session);
  const forceConversionPersistence = baseHintStage === 'direct_ask'
    && ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState)
    && ['panic_churn_ops', 'grey_pain_switcher', 'cm_winback', 'direct_contract_transition', 'rate_floor_cfo', 'fx_trust_shock_finance', 'cfo_round', 'head_finance'].includes(personaId);

  if (baseHintStage === 'direct_ask') {
    if (forceConversionPersistence) return 'direct_ask';
    const variant = getHintVariant(session, 'direct_ask');
    const retryNum = parseInt(variant.replace('retry_', ''), 10) || 0;
    if (retryNum >= 1) return 'bridge_step';
  }
  if (baseHintStage === 'bridge_step') {
    const variant = getHintVariant(session, 'bridge_step');
    const retryNum = parseInt(variant.replace('retry_', ''), 10) || 0;
    if (retryNum >= 2) {
      return getActiveConcern(session) ? 'proof' : 'diagnosis';
    }
  }
  return baseHintStage;
}

// validateMixedMode: runtime check that a generated hint stays in one mode.
// A hint is mixed when it triggers patterns from mutually exclusive mode families.
// Returns { valid: boolean, violation: string | null }
function validateMixedMode(hintText, hintStage) {
  const lower = String(hintText || '').toLowerCase();

  const hasMeetingAsk = /\b(call|meeting|созвон|созвониться|встреч|walkthrough|calendar|слот|когда удобно|what time|schedule|20 min|15 min|20 минут|15 минут)\b/.test(lower);
  const hasDiagnosisQuestion = /\b(what|where|which|how|why|что|где|какой|как|почему|what's|что за)\b/.test(lower) && lower.includes('?');
  const hasProofClaim = /\b(mellow|kyc|audit|docs|payment|compliance|payout|мелло|документ|аудит|kpi)\b/.test(lower);

  if ((hintStage === 'diagnosis' || hintStage === 'proof' || hintStage === 'repair') && hasMeetingAsk) {
    return { valid: false, violation: `${hintStage} hint must not contain a meeting ask` };
  }
  if (hintStage === 'bridge_step' && hasDiagnosisQuestion && hasProofClaim && hasMeetingAsk) {
    return { valid: false, violation: 'bridge_step hint mixes diagnosis + proof + meeting ask simultaneously' };
  }
  if (hintStage === 'direct_ask' && hasDiagnosisQuestion && hasProofClaim && hasMeetingAsk) {
    return { valid: false, violation: 'direct_ask hint is too broad — mixes diagnosis + proof + ask in one turn' };
  }

  return { valid: true, violation: null };
}

function buildStageBoundSuggestion(session, lang = 'ru') {
  const persona = personaMeta(session);
  const policy = getHintPolicyContext(session);
  const assets = getRelevantSalesAssets(session, lang);
  const concern = policy.activeConcern || 'scope';
  const askType = policy.askType;
  const winPattern = detectBuyerWinPattern(session);
  const sellerTurnCount = sellerMessages(session).length;
  const latestBuyer = latestBuyerReplyText(session).toLowerCase();
  const legalPersona = ['internal_legal', 'external_legal', 'olga'].includes(persona?.id);
  const asksScopeBoundary = /where.*scope|scope.*end|границ[аы].*ответствен|зона контроля|what exactly mellow control|what exactly does mellow control|what sits within mellow|где у mellow заканчивается|что именно mellow контролирует|что именно mellow берет|what is in your scope|what's in your scope|первый вопрос.*где у mellow|first question.*where does mellow|where does mellow end|where mellow ends|где заканчивается зона контроля|где заканчивается ваша зона|boundary/.test(latestBuyer);
  const asksOpsOwner = /owner|кто owner|manual coordination|ручн.*координац|что именно меняется в процессе|what exactly changes|incident|когда что-то ломается|what comes out of manual coordination|mechanic|механик/.test(latestBuyer);

  const asksForArtifactNow = /пришлите|присылайте|жду письмо|жду материалы|workflow note|boundary note|one-screen|одним экраном|коротк.*записк|коротк.*note|send.*note|send.*memo|send it|waiting for your email|waiting for the materials|когда скинете|when will you send|когда отправите|посмотрю|review call|короткий review call/.test(latestBuyer);

  if (isEmailMode(session) && sellerTurnCount === 1 && legalPersona) {
    if (lang === 'en') {
      return `Concretely, Mellow takes KYC, contractor documents, the payout chain, and the audit trail on that chain. What stays on your side is legal judgment, policy, and any misclassification decision. If useful, I can send this as a one-screen boundary note for review.`;
    }
    return `Конкретно: Mellow берёт на себя KYC, contractor documents, payout chain и audit trail по этой цепочке. На вашей стороне остаются legal judgment, policy и любые misclassification decisions. Если полезно, я могу прислать это одним экраном как boundary note для review.`;
  }

  if (isEmailMode(session) && sellerTurnCount >= 2 && asksForArtifactNow) {
    if (legalPersona) {
      return lang === 'en'
        ? `One-screen version: Mellow owns KYC, contractor documents, the payout chain, and the audit trail on that chain, while your side keeps legal judgment, policy, and any misclassification decision. If that boundary reads clean, we can use a short 15-minute review only for open points.`
        : `Версия в одном экране: Mellow ведёт KYC, contractor documents, payout chain и audit trail по этой цепочке, а на вашей стороне остаются legal judgment, policy и любые misclassification decisions. Если такая граница выглядит чисто, дальше можно взять короткий 15-минутный review только по open points.`;
    }
    if ((persona?.archetype || '') === 'ops') {
      return lang === 'en'
        ? `Short workflow note: status chasing and incident bouncing come out, one Mellow owner takes payout operations and incident path, and your team keeps approval and prioritization. If that looks grounded, we can use a short 15-minute workflow review on your case.`
        : `Короткая workflow note: из процесса уходят chase за статусами и плавающий owner при сбое, один owner со стороны Mellow ведёт payout operations и incident path, а у вашей команды остаются approval и приоритизация. Если это выглядит приземлённо, дальше можно взять короткий 15-минутный workflow review на вашем кейсе.`;
    }
    if (['cm_winback', 'direct_contract_transition', 'grey_pain_switcher', 'panic_churn_ops'].includes(persona?.id)) {
      return lang === 'en'
        ? `Here is the narrow written version. The fit is not a broad restart, but one bounded slice: a smaller contractor contour, clearer owner model, and a safer path for exceptions than before. If that logic looks clean, the next step can be a short 15-minute review only on that slice.`
        : `Вот узкая письменная версия. Fit здесь не в широком перезапуске, а в одном bounded slice: меньший contractor contour, более ясная owner-модель и более безопасный путь для исключений, чем раньше. Если эта логика выглядит чисто, следующим шагом может быть короткий 15-минутный review только по этому slice.`;
    }
    return lang === 'en'
      ? `Here is the short written version. Mellow covers the control boundary, the document path, and the payment chain mechanics in one accountable contour, while your side keeps approval and policy decisions. If that reads clean, the next step can be a short 15-minute review on open points only.`
      : `Вот короткая письменная версия. Mellow собирает в один accountable contour границу контроля, документный путь и механику payment chain, а на вашей стороне остаются approval и policy decisions. Если это выглядит чисто, следующим шагом может быть короткий 15-минутный review только по open points.`;
  }

  if (isEmailMode(session) && sellerTurnCount >= 1 && asksScopeBoundary) {
    if (lang === 'en') {
      return legalPersona
        ? `Concretely, Mellow takes KYC, contractor documents, the payout chain, and the audit trail on that chain. What stays on your side is legal judgment, policy, and any misclassification decision. If useful, I can send this as a one-screen boundary note for review.`
        : `Concretely, Mellow owns KYC, contractor documents, the payout chain itself, incident handling on that chain, and the audit trail around it. What stays on your side is approval, budget, and internal legal or policy decisions. If useful, I can send this as a one-screen boundary note for your review.`;
    }
    return legalPersona
      ? `Конкретно: Mellow берёт на себя KYC, contractor documents, payout chain и audit trail по этой цепочке. На вашей стороне остаются legal judgment, policy и любые misclassification decisions. Если полезно, я могу прислать это одним экраном как boundary note для review.`
      : `Конкретно: Mellow ведёт KYC, contractor documents, саму payout chain, incident handling на этой цепочке и audit trail вокруг неё. На вашей стороне остаются approval, budget и внутренние legal / policy decisions. Если полезно, я могу прислать это одним экраном как boundary note для review.`;
  }

  if (isEmailMode(session) && sellerTurnCount >= 1 && asksOpsOwner) {
    if (lang === 'en') {
      return `What comes out of manual coordination is status chasing, fragmented handoffs, and incident ownership floating between teams. With Mellow, one owner sits on payout operations, contractor communication, and the incident path when something breaks. If useful, I can send a short workflow map for your exact case.`;
    }
    return `Из ручной координации уходит chase за статусами, кусочная передача между командами и плавающий owner при сбое. С Mellow один owner сидит на payout operations, contractor communication и incident path, если что-то ломается. Если полезно, я могу прислать короткую workflow map именно под ваш кейс.`;
  }

  if (legalPersona && ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(policy.acceptanceState)) {
    const asksForSendTiming = /when will you send|when can you send|когда пришл[её]те|когда отправите|waiting for the materials|waiting for your email|жду материалы|жду письмо|присылайте|посмотрю/.test(latestBuyer);
    const conditionallyOpenToReview = /if it'?s clean|if the logic holds|if it works|найд[её]м 15 минут|можно созвониться|if.*review call|если.*созвон|если.*review call|найд[её]м время/.test(latestBuyer);
    if (asksForSendTiming || conditionallyOpenToReview) {
      if (lang === 'en') {
        return `I'll send the one-page memo today with scope boundary, documents, safeguards, and one incident-path example. If it reads clean on your side, let's tentatively hold 15 minutes tomorrow just for open points, and you can confirm or move it after review. Would 11:30 or 15:00 work better?`;
      }
      return `Я пришлю одностраничный memo сегодня: зона контроля, документы, safeguards и один incident-path example. Если по формулировкам всё чисто, давайте сразу подержим 15 минут завтра только под open points, а после review вы либо подтвердите слот, либо сдвинем. Вам удобнее 11:30 или 15:00?`;
    }
  }

  const deterministicFinancePersona = ['rate_floor_cfo', 'fx_trust_shock_finance', 'cfo_round', 'head_finance'].includes(persona?.id);
  if (deterministicFinancePersona && lang !== 'en') {
    const asksMechanics = buyerAskedFinanceMechanicsFlow(session);
    const asksEconomics = buyerAskedFinanceEconomicsMath(session);
    const acceptanceState = policy.acceptanceState;

    if (sellerTurnCount >= 3 && ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState)) {
      if (persona.id === 'rate_floor_cfo') {
        return `Тогда так: я пришлю короткую записку по полной экономике и границе ответственности сегодня, при необходимости добавлю calculator snapshot по полной стоимости, а потом коротко созвонимся на 15 минут только на finance review вашего кейса. Какой слот удобен?`;
      }
      if (persona.id === 'fx_trust_shock_finance') {
        return `Тогда так: я пришлю короткий breakdown по ставке, FX, payout path и failure path, при необходимости добавлю calculator snapshot по effective cost, а потом коротко созвонимся на 15 минут только на economics review вашего кейса. Когда удобно?`;
      }
      if (persona.id === 'cfo_round') {
        return `Тогда так: я пришлю короткую investor-readiness note по prep cost, boundary и incident path, а потом коротко созвонимся на 15 минут только на readiness review. Какой слот удобен?`;
      }
      if (persona.id === 'head_finance') {
        return `Тогда так: я пришлю короткую control-cost note по ручной сверке, audit trail и границе ответственности, а потом коротко созвонимся на 15 минут только на control review. Когда удобно?`;
      }
    }

    if (sellerTurnCount >= 2 && asksEconomics) {
      if (persona.id === 'rate_floor_cfo') {
        return `По экономике здесь обычно три строки: цена ручной координации, цена платежного сбоя и цена непрозрачной полной стоимости до invoicing. ${assets.useCaseSnippet ? assets.caseSnippet + ' ' : ''}Если полезно, я сведу это в один короткий finance note по вашему кейсу.`;
      }
      if (persona.id === 'fx_trust_shock_finance') {
        return `Если совсем по слоям, buyer должен видеть четыре вещи до старта: базовую ставку, FX-логику по нужной валютной паре, payout route и что происходит если платёж или банк даёт сбой. ${assets.useCaseSnippet ? assets.caseSnippet + ' ' : ''}То есть не post-factum сюрприз, а прозрачную total-cost схему заранее. Если полезно, я сведу это в короткий breakdown по вашему кейсу.`;
      }
      if (persona.id === 'cfo_round') {
        return `Здесь economics of readiness обычно в трёх местах: ручная подготовка к diligence, explainability для инвестора и цена сбоя, если что-то всплывает поздно. Если полезно, я сведу это в одну короткую note.`;
      }
      if (persona.id === 'head_finance') {
        return `Здесь control economics обычно в трёх местах: ручная сверка, разбор исключений и видимость полной картины до invoicing. Если полезно, я сведу это в одну короткую note по вашему контуру.`;
      }
    }

    if (sellerTurnCount >= 1 && asksMechanics) {
      if (persona.id === 'fx_trust_shock_finance') {
        return `Если совсем по шагам, Mellow берёт на себя contractor KYC и payout data, сам payment flow и статусную видимость по этой цепочке, а если выплата идёт не так, то incident path и contractor-facing support тоже у нас. На вашей стороне остаются approval, бюджет и policy decisions. То есть buyer заранее видит, где наша зона, где ваша, и где именно возникает или не возникает FX / bank-side эффект.`;
      }
      return `Если совсем по шагам, Mellow берёт на себя contractor KYC и payout data, сам payment flow, incident path если выплата идёт не так, и contractor-facing support / SLA на этой цепочке. На вашей стороне остаются approval, бюджет и внутренние policy decisions.`;
    }
  }

  const lines = {
    ru: {
      diagnosis: {
        finance: [
          `Что для вас сейчас критичнее всего в contractor-схеме: границы ответственности, audit trail или ручная сверка?`,
          `Где сейчас слабое место: документы, payout flow или контроль статусов?`,
        ],
        legal: [
          `Какая серая зона в текущей contractor-схеме для вас сейчас самая рискованная?`,
          `Что вам важнее всего проверить первым: control zone, документы или audit trail?`,
        ],
        ops: [
          `Что у команды сейчас съедает больше всего ручной работы: статусы, эскалации или сверка?`,
          `Где процесс ломается чаще всего: payout status, follow-ups или incidents?`,
        ],
      },
      proof: {
        default: [
          `Конкретно по ${concern}: Mellow берёт на себя KYC, документы и payment chain с audit trail на нашей стороне. Где вам нужно больше конкретики?`,
          `Здесь важен не pitch, а механизм: KYC, contractor docs, payout flow, incident trail. Какой элемент вам важнее разобрать?`,
        ],
      },
      repair: {
        default: [
          `Давайте без общего pitch. Возьмём один узкий вопрос, который сейчас мешает доверию, и разберём его конкретно. Что именно нужно закрыть первым?`,
          `Похоже, я недожал конкретику. Давайте сузим разговор до одного пункта и разберём его без лишних обещаний. Что критичнее всего?`,
        ],
      },
      bridge_step: {
        written_first: [
          `Следующий шаг без давления: я пришлю короткий one-pager по вашему кейсу, а если там будет конкретика, тогда созвон. Ок?`,
          `Могу сначала отправить короткий summary по flow, scope и SLA, чтобы вы посмотрели без звонка. Подходит?`,
        ],
        narrow_walkthrough: [
          `Давайте не в широкий звонок, а в узкий walkthrough на 15 минут только по самому острому месту. Такой формат ок?`,
          `Предлагаю узкий следующий шаг: 15 минут только по проблемному участку, без общего pitch. Подходит?`,
        ],
        direct_call: [
          `Похоже, база уже есть. Имеет смысл коротко созвониться на 15 минут и пройти именно ваш кейс. Подходит?`,
          `Тут уже можно не переписываться дальше, а коротко пройти ваш сценарий голосом. Найдём 15 минут?`,
        ],
      },
      direct_ask: {
        written_first: [
          `Я пришлю короткий memo по вашему кейсу сегодня, и если логика ок, давайте сразу поставим короткий созвон на 20 минут. Когда удобно?`,
          `Предлагаю следующий шаг: one-pager сегодня и короткий review call после него. Какой слот вам удобен?`,
        ],
        narrow_walkthrough: [
          `Давайте поставим 15-минутный узкий walkthrough только по этой проблеме, без широкого pitch. Когда удобно?`,
          `Имеет смысл зафиксировать короткий созвон на 15 минут именно по этому узкому вопросу. Когда вам ок?`,
        ],
        direct_call: [
          `Предлагаю короткий созвон на 20 минут и разберём ваш сценарий без воды. Когда удобно?`,
          `Давайте не растягивать и поставим короткий call на 20 минут по вашему кейсу. Какой слот подходит?`,
        ],
      },
    },
    en: {
      diagnosis: {
        finance: [
          `What is most critical for you right now in the contractor setup: scope boundary, audit trail, or manual reconciliation?`,
          `Where is the weakest point today: documents, payout flow, or status control?`,
        ],
        legal: [
          `Which grey zone in the current contractor setup feels most risky to you right now?`,
          `What do you need to test first: control zone, documentation, or audit trail?`,
        ],
        ops: [
          `What is creating the most manual work right now: statuses, escalations, or reconciliation?`,
          `Where does the process break most often today: payout status, follow-ups, or incidents?`,
        ],
      },
      proof: {
        default: [
          `Specifically on ${concern}, Mellow covers KYC, contractor docs, and the payment chain with audit trail on our side. Which part do you want more precision on?`,
          `The point here is the mechanism, not the pitch: KYC, contractor docs, payout flow, incident trail. Which piece matters most in your case?`,
        ],
      },
      repair: {
        default: [
          `Let me keep this tighter. We can take one narrow point that is blocking trust and address it directly. What needs to be cleared first?`,
          `I think I was too broad there. Let's narrow this to one concrete point and deal with it without overclaiming. What matters most first?`,
        ],
      },
      bridge_step: {
        written_first: [
          `Low-pressure next step: I can send a short one-pager for your case, and if it is concrete enough, then we can talk. Does that work?`,
          `I can send a short summary on flow, scope, and SLA first so you can review it without a call. Would that help?`,
        ],
        narrow_walkthrough: [
          `Rather than a broad call, we can do a narrow 15-minute walkthrough just on the acute issue. Would that work?`,
          `The clean next step may be a short 15-minute walkthrough on the problem area only, without a broad pitch. Does that work?`,
        ],
        direct_call: [
          `It feels like the basics are in place. A short 15-minute call on your exact case may be the cleanest next step. Would that work?`,
          `At this point it may be easier to cover your scenario live in 15 minutes than keep threading messages. Open to that?`,
        ],
      },
      direct_ask: {
        written_first: [
          `I'll send a short memo for your case today, and if the logic holds, let's put a short review call on the calendar. What time works?`,
          `Next step: one-pager today and a short review call right after. What slot works for you?`,
        ],
        narrow_walkthrough: [
          `Let's put a narrow 15-minute walkthrough on the calendar just for this issue, without a broad pitch. What time works?`,
          `It makes sense to schedule a short 15-minute call just on this narrow point. What works on your side?`,
        ],
        direct_call: [
          `Let's schedule a short 20-minute call and go through your case directly. What time works?`,
          `Rather than stretch this further, let's put a short 20-minute call on the calendar for your scenario. What slot works?`,
        ],
      },
    },
  };

  const patternLines = {
    ru: {
      diagnosis: {
        only_working_option: {
          finance: [
            `Что у вас сейчас реально не работает без Mellow: выплаты в РФ/РБ, рублёвый payout или защитимость схемы для finance/legal?`,
            `Если убрать общие слова про цену, где именно тупик: нет рабочего канала выплат, нет предсказуемой рублёвой суммы или нет defendable flow?`,
          ],
          ops: [
            `Где у вас сейчас реальный operational тупик: сами выплаты, коммуникация с contractor-ами или ручная сборка обходного процесса?`,
            `Что сейчас ломается первым: payout path, спокойствие contractor-ов или внутренняя управляемость процесса?`,
          ],
        },
        compliance_trigger: {
          finance: [
            `Что у вас сейчас более живое: риск misclassification / audit или то, что текущая схема просто плохо защищается внутри finance/legal?`,
            `Какой именно trigger вас двигает: инвесторский review, legal discomfort или страх, что текущая схема не переживёт проверку?`,
          ],
          legal: [
            `Что именно нужно выдержать: audit trail, разделение ответственности или defensibility схемы перед юристами/инвесторами?`,
            `Какая часть текущей схемы выглядит самой слабой при legal review: документы, границы ответственности или сама цепочка выплат?`,
          ],
        },
      },
      proof: {
        only_working_option: {
          default: [
            `Если у вас сейчас нет рабочего payout path в РФ/РБ, разговор не про абстрактный premium, а про working option. Mellow закрывает docs, KYC и payout chain так, чтобы схема реально работала, а не выглядела красиво на словах. Где нужна конкретика?`,
            `Здесь лучший proof не “мы качественнее”, а “это реально работает в вашем контуре”. Если альтернатива не проводит нужный payout flow, дешевле не значит полезнее. Какой кусок механики вам важнее проверить?`,
          ],
        },
        competitive_reliability: {
          default: [
            `Если конкурент дешевле, вопрос не в headline rate, а в том, кто реально выдерживает тяжёлые гео без серых зон и внезапных сбоев. Mellow дороже не “за бренд”, а за sanction-safe operability, устойчивый payout chain и defendable execution в СНГ, РФ/РБ и других hard geos. Что вам важнее доказать первым: reliability, controllability или downside cheaper option?`,
            `Здесь premium нужно защищать не словами “лучший сервис”, а конкретной разницей: кто проведёт выплаты стабильно в tough geos, кто даст audit trail, кто не развалится при scrutiny, и кто возьмёт на себя внедрение, а не оставит клиента с tool-only experience. Какой из этих proof layers критичнее для вас?`,
          ],
        },
        enterprise_embedding: {
          default: [
            `Если у вас enterprise-контур, value не только в самом payout, а в том, что Mellow можно встроить в процесс “найти и выбрать” и “оформить сделку и оплатить фрилансера” через APIs и MCP, плюс наша команда внедрения берёт на себя реальную интеграцию в contractor admin workflow. Где вам важнее увидеть proof: implementation ownership, process embedding или zero-cost-to-start contour?`,
            `Это не просто кастомизация. Здесь Mellow продаётся как managed implementation layer: наша команда внедрения подстраивает flow под ваш vendor/contractor process, а старт для клиента можно сделать без upfront cost. Что вам важнее разобрать первым: integration shape, operating model или start-without-commitment logic?`,
          ],
        },
        compliance_trigger: {
          default: [
            `Если trigger уже legal/audit, ценность не в лозунге compliance, а в defendable structure: документы, KYC, payout chain и audit trail по нашей зоне ответственности. Какой элемент нужно разобрать первым?`,
            `Когда на столе misclassification, audit или investor review, рабочий ответ это не “мы safer”, а понятная граница ответственности и trail. Что вам критичнее: boundary, docs или payment evidence?`,
          ],
        },
        crypto_replacement: {
          default: [
            `Если текущий путь держится на crypto или полуформальной схеме, главный value здесь не маркетинг, а замена хрупкого контура на defendable payout flow. Что вам важнее: legal defensibility или предсказуемость самих выплат?`,
            `Здесь Mellow нужен не как “ещё один vendor”, а как выход из серого и нестабильного payment path. Где вам важнее конкретика: документы, payout flow или audit trail?`,
          ],
        },
        operational_simplicity: {
          default: [
            `Если боль в ручной сборке процесса, value здесь в одном контуре: one invoice, docs, KYC и payout ops у Mellow вместо кусочной координации. Где у вас сейчас больше всего ручного трения?`,
            `Здесь важна не общая “платформа”, а снятие конкретного admin overhead: один invoice, меньше chase-up и более чистый flow. Какой кусок боли у вас самый дорогой?`,
          ],
        },
      },
      bridge_step: {
        only_working_option: {
          written_first: [
            `Следующий шаг без давления: я пришлю короткую карту рабочего payout flow именно под ваш кейс, чтобы было видно, где Mellow решает тупик, а потом уже созвон. Ок?`,
          ],
          direct_call: [
            `Похоже, здесь уже важнее не переписка, а короткая проверка вашего payout scenario голосом. Давайте 15 минут только на working path. Подходит?`,
          ],
        },
        competitive_reliability: {
          written_first: [
            `Могу сначала прислать короткий competitor-proof brief: где cheaper option выглядит дешевле, а где у него реально больше failure risk в hard geos, и как Mellow это закрывает. Если логика сойдётся, тогда созвон. Подходит?`,
          ],
          narrow_walkthrough: [
            `Давайте короткий walkthrough на 15 минут только по competitive comparison: reliability, sanctions-safe operability и what breaks in cheaper setups. Такой формат ок?`,
          ],
          direct_call: [
            `Похоже, спор уже не про цену, а про reliability under pressure. Есть смысл коротко созвониться на 15 минут и пройти именно competitor trade-off. Подходит?`,
          ],
        },
        enterprise_embedding: {
          written_first: [
            `Следующий шаг без давления: пришлю короткий implementation brief, как Mellow встраивается в ваш contractor workflow через APIs/MCP и что наша команда внедрения берёт на себя, при zero cost to start. Если логика ок, тогда созвон. Подходит?`,
          ],
          narrow_walkthrough: [
            `Предлагаю узкий walkthrough на 15 минут только по implementation contour: team, APIs/MCP, workflow embedding и zero-cost start. Такой формат ок?`,
          ],
          direct_call: [
            `Похоже, здесь уже полезнее коротко пройти implementation shape голосом, чем переписываться. Найдём 15 минут на workflow-fit review?`,
          ],
        },
        compliance_trigger: {
          written_first: [
            `Могу сначала прислать короткий memo по boundary, docs и audit trail под ваш кейс, чтобы finance/legal посмотрели без звонка. Подходит?`,
          ],
          narrow_walkthrough: [
            `Давайте не в общий звонок, а в короткий walkthrough только по legal / audit contour вашего кейса. Такой формат ок?`,
          ],
        },
      },
      direct_ask: {
        only_working_option: {
          direct_call: [
            `Предлагаю короткий созвон на 20 минут и быстро пройдём ваш payout scenario, чтобы понять, где Mellow реально закрывает тупик. Когда удобно?`,
          ],
          written_first: [
            `Я пришлю короткую схему payout flow под ваш кейс сегодня, и если логика сходится, сразу поставим короткий созвон. Какой слот потом вам удобен?`,
          ],
        },
        competitive_reliability: {
          written_first: [
            `Я пришлю короткий competitive brief сегодня: почему Mellow не cheapest, но strongest по reliability в hard geos и где cheaper option создаёт hidden downside. Если логика ок, сразу поставим короткий созвон. Какой слот удобен?`,
          ],
          narrow_walkthrough: [
            `Давайте поставим короткий 15-минутный созвон только по competitor trade-off и reliability proof, без общего pitch. Когда удобно?`,
          ],
          direct_call: [
            `Предлагаю короткий созвон на 20 минут и пройдём именно конкурентную развилку: почему Mellow выигрывает не ценой, а надёжностью и controllability в hard geos. Когда удобно?`,
          ],
        },
        enterprise_embedding: {
          written_first: [
            `Я пришлю implementation memo сегодня: team, APIs/MCP, workflow embedding и zero-cost start. Если это попадает в ваш enterprise contour, сразу поставим короткий review call. Какой слот удобен?`,
          ],
          narrow_walkthrough: [
            `Давайте поставим короткий созвон на 15 минут только по enterprise implementation contour, без product theatre. Когда удобно?`,
          ],
          direct_call: [
            `Предлагаю 20-минутный call и быстро пройдём, как Mellow встроится в ваш contractor process с нашей командой внедрения и без upfront start cost. Когда удобно?`,
          ],
        },
        compliance_trigger: {
          written_first: [
            `Предлагаю следующий шаг: короткий memo по defendable structure сегодня и затем review call с теми, кто смотрит legal/finance часть. Какой формат вам удобнее?`,
          ],
          narrow_walkthrough: [
            `Давайте поставим короткий созвон только по legal / audit contour и проверим, выдерживает ли схема ваш review. Когда удобно?`,
          ],
        },
      },
    },
    en: {
      diagnosis: {
        only_working_option: {
          finance: [
            `What is actually broken today without Mellow: payments into RU/BY, ruble payout predictability, or the fact that the setup is not defensible for finance/legal?`,
            `If we strip out generic price talk, where is the real dead end: no working payout route, no predictable ruble amount, or no defensible flow?`,
          ],
          ops: [
            `Where is the real operational dead end today: the payout path itself, contractor communication, or the manual workaround around it?`,
            `What breaks first in the current setup: payout execution, contractor calm, or internal control of the process?`,
          ],
        },
        compliance_trigger: {
          finance: [
            `What is more live for you right now: misclassification / audit risk, or the fact that the current setup is hard to defend internally?`,
            `What is the actual trigger here: investor review, legal discomfort, or a sense that the current setup will not survive scrutiny?`,
          ],
          legal: [
            `What exactly needs to hold up: audit trail, scope boundary, or the defensibility of the structure in front of legal / investors?`,
            `Which part of the current setup looks weakest in legal review: documentation, boundary of responsibility, or the payment chain itself?`,
          ],
        },
      },
      proof: {
        only_working_option: {
          default: [
            `If there is no working payout path into RU/BY today, this is not really a premium-vs-cheap conversation. It is a working-option conversation. Mellow covers docs, KYC, and the payout chain so the setup actually works. Which part needs more precision?`,
            `The strongest proof here is not “we are better”, but “this works in your contour.” If the alternative cannot execute the payout path you need, cheaper is not the real benchmark. Which mechanism do you want to test first?`,
          ],
        },
        competitive_reliability: {
          default: [
            `If the competitor is cheaper, the real question is not headline rate. It is who actually stays reliable in hard geos without grey zones or surprise breakdowns. Mellow is more expensive not for branding, but for sanctions-safe operability, durable payout rails, and defensible execution across CIS, RU/BY, and other hard geographies. Which proof matters more first: reliability, controllability, or the downside of the cheaper option?`,
            `The premium case here should not sound like “better service.” It should sound like specific superiority: stable payouts in tough geos, audit trail, resilience under scrutiny, and an implementation team that embeds the flow instead of leaving the client with tool-only adoption. Which proof layer matters most in your case?`,
          ],
        },
        enterprise_embedding: {
          default: [
            `If your contour is enterprise, the value is not only payout execution. It is that Mellow can be embedded into the client's “find and select” and “contract / pay freelancer” workflows via APIs and MCP, with our implementation team owning the actual rollout. Where do you want proof first: implementation ownership, workflow embedding, or the zero-cost-to-start contour?`,
            `This is more than customization. Mellow can be sold as a managed implementation layer: our team shapes the flow around your contractor admin process, and the client can start without upfront implementation cost. What matters most first: integration shape, operating model, or start-without-commitment logic?`,
          ],
        },
        compliance_trigger: {
          default: [
            `If the trigger is already legal / audit, the value is not a compliance slogan. It is a defendable structure: documentation, KYC, payout chain, and audit trail within our scope. Which piece should we unpack first?`,
            `When misclassification, audit, or investor review is on the table, the answer is not “we are safer” but a clear responsibility boundary plus trail. What matters most first: boundary, docs, or payment evidence?`,
          ],
        },
        crypto_replacement: {
          default: [
            `If the current path depends on crypto or informal payments, the value here is replacing a fragile setup with a defensible payout flow. What matters more in your case: legal defensibility or payout predictability?`,
            `This is not about adding another vendor. It is about getting out of a grey and unstable payment path. Where do you need specificity first: docs, payout flow, or audit trail?`,
          ],
        },
        operational_simplicity: {
          default: [
            `If the pain is the manual patchwork around the process, the value is one contour: one invoice, docs, KYC, and payout ops with Mellow instead of fragmented coordination. Where is the biggest manual drag today?`,
            `The point here is not “platform” in the abstract. It is removing specific admin overhead: one invoice, less chasing, and a cleaner flow. Which pain is costing you the most right now?`,
          ],
        },
      },
      bridge_step: {
        only_working_option: {
          written_first: [
            `Low-pressure next step: I can send a short map of the working payout flow for your exact case, so you can see where Mellow resolves the dead end before we talk. Would that help?`,
          ],
          direct_call: [
            `It may be more useful to pressure-test your payout scenario live for 15 minutes than keep this abstract. Open to a short call just on the working path?`,
          ],
        },
        competitive_reliability: {
          written_first: [
            `I can first send a short competitor-proof brief showing where the cheaper option looks cheaper and where it creates more failure risk in hard geos, plus how Mellow closes that gap. If the logic holds, we can talk right after. Would that help?`,
          ],
          narrow_walkthrough: [
            `We can do a short 15-minute walkthrough just on the competitive trade-off: reliability, sanctions-safe operability, and what breaks in cheaper setups. Would that help?`,
          ],
          direct_call: [
            `It looks like the real argument is no longer price but reliability under pressure. A short 15-minute call just on that competitor trade-off may be the cleanest next step. Open to that?`,
          ],
        },
        enterprise_embedding: {
          written_first: [
            `Low-pressure next step: I can send a short implementation brief showing how Mellow fits into your contractor workflow via APIs/MCP, what our implementation team owns, and how the client starts at zero cost. If it fits, we can talk right after. Would that help?`,
          ],
          narrow_walkthrough: [
            `We can do a short 15-minute walkthrough just on the implementation contour: team, APIs/MCP, workflow embedding, and zero-cost start. Would that work?`,
          ],
          direct_call: [
            `It may be more useful to walk through the implementation shape live than keep this abstract in messages. Open to a short workflow-fit review?`,
          ],
        },
        compliance_trigger: {
          written_first: [
            `I can send a short memo on boundary, docs, and audit trail for your case first, so finance/legal can review it without a call. Would that help?`,
          ],
          narrow_walkthrough: [
            `Rather than a broad call, we can do a short walkthrough just on the legal / audit contour of your case. Would that work?`,
          ],
        },
      },
      direct_ask: {
        only_working_option: {
          direct_call: [
            `Let's put a short 20-minute call on the calendar and pressure-test your payout scenario directly, so we can see where Mellow actually resolves the dead end. What time works?`,
          ],
          written_first: [
            `I'll send a short payout-flow map for your case today, and if the logic holds, let's put a short call on the calendar right after. What slot works?`,
          ],
        },
        competitive_reliability: {
          written_first: [
            `I'll send a short competitive brief today on why Mellow is not the cheapest but the strongest on reliability in hard geos, and where the cheaper option creates hidden downside. If the logic holds, let's put a short call on the calendar right after. What slot works?`,
          ],
          narrow_walkthrough: [
            `Let's schedule a short 15-minute call just on the competitor trade-off and reliability proof, without a broad pitch. What time works?`,
          ],
          direct_call: [
            `Let's schedule a short 20-minute call and go through the competitive fork directly: why Mellow wins not on price but on reliability and controllability in hard geos. What time works?`,
          ],
        },
        enterprise_embedding: {
          written_first: [
            `I'll send an implementation memo today covering team, APIs/MCP, workflow embedding, and zero-cost start. If it fits your enterprise contour, let's put a short review call on the calendar right after. What slot works?`,
          ],
          narrow_walkthrough: [
            `Let's schedule a short 15-minute call just on the enterprise implementation contour, without product theatre. What time works?`,
          ],
          direct_call: [
            `Let's put a short 20-minute call on the calendar and walk through how Mellow would fit your contractor process with our implementation team and no upfront start cost. What time works?`,
          ],
        },
        compliance_trigger: {
          written_first: [
            `Next step: short memo on the defendable structure today, then a review call with whoever owns the legal / finance check. Which format works better for you?`,
          ],
          narrow_walkthrough: [
            `Let's schedule a short call just on the legal / audit contour and test whether the structure really clears your review bar. What time works?`,
          ],
        },
      },
    },
  };

  const personaSpecificLines = {
    ru: {
      proof: {
        rate_floor_cfo: [
          `Если убрать общие слова, экономика разницы обычно в трёх местах: где не остаётся ручной разбор сбоя внутри finance, где заранее видна полная стоимость, и где не возникает новый хвост из согласований. Если хотите, разложу это коротко по вашему кейсу.`,
        ],
        fx_trust_shock_finance: [
          `Здесь разница не в обещании “будет прозрачнее”, а в том, что заранее видны ставка, FX, маршрут выплаты и что происходит, если платёж уходит не идеально. Если полезно, разложу это коротко по вашему кейсу без общих слов.`,
        ],
        cfo_round: [
          `Перед diligence разница обычно не в самой структуре, а в цене готовности к проверке: сколько ручной подготовки остаётся внутри команды, где потом всплывают вопросы инвестора и что можно сделать объяснимым заранее. Если хотите, разложу это коротко по вашему кейсу.`,
        ],
        head_finance: [
          `Для Head of Finance разница обычно в трёх вещах: сколько ручной сверки и координации остаётся внутри команды, что видно заранее для контроля и где не появляется новый серый слой. Если полезно, разложу это коротко по вашему кейсу.`,
        ],
      },
      bridge_step: {
        rate_floor_cfo: {
          written_first: [`Если совсем коротко, higher rate обычно окупается не “надежностью вообще”, а там, где с finance снимается разбор сбоев, заранее видна полная математика и не растёт хвост ручной координации. Могу прислать это одной короткой запиской под ваш кейс, а потом за 15 минут проверить на созвоне, сходится ли логика. Подходит?`],
        },
        fx_trust_shock_finance: {
          written_first: [`Следующий шаг без давления: пришлю короткую записку по вашему кейсу, где отдельно разложены ставка, FX, маршрут выплаты и поведение при сбое. Если математика выглядит честно, потом возьмём 15 минут только на economics и fit. Ок?`],
        },
        cfo_round: {
          written_first: [`Могу сначала прислать короткую записку по investor-readiness: где у вас сейчас остаётся скрытая цена подготовки к diligence, что можно сделать объяснимым заранее и где проходит граница ответственности. Если логика выглядит приземлённо, потом возьмём 15 минут только на readiness и fit. Подходит?`],
        },
        head_finance: {
          written_first: [`Следующий шаг без давления: пришлю короткую записку под ваш кейс, где видно, что уходит из ручной сверки, что становится заранее видно для контроля и где не появляется новый серый слой. Если логика выглядит честно, потом возьмём 15 минут только на control economics и fit. Ок?`],
        },
      },
      direct_ask: {
        rate_floor_cfo: {
          narrow_walkthrough: [`Раз структура уже выглядит разумно, давайте не растягивать. Предлагаю короткий 15-минутный finance review call, чтобы пройти boundary, incident path и решить, есть ли fit. Какой слот вам удобен?`],
          direct_call: [`Если логика сходится, следующий шаг простой: короткий finance review call на 15 минут, без общего pitch, только boundary, incident path и fit. Когда удобно?`],
          written_first: [`Я пришлю короткую записку сегодня: зона ответственности, платежная цепочка, SLA при сбое и полная логика стоимости. Если это выглядит приземлённо, потом возьмём короткий finance review на 15 минут. Какой слот удобен?`],
        },
        fx_trust_shock_finance: {
          narrow_walkthrough: [`Раз cost logic уже понятна, предлагаю короткий 15-минутный cost review call, чтобы быстро проверить FX, payout path и failure contour на вашем кейсе. Когда удобно?`],
          direct_call: [`Если математика выглядит честно, давайте сразу короткий cost review call на 15 минут, без широкого демо, только economics и fit. Какой слот удобен?`],
          written_first: [`Я пришлю короткую записку сегодня: ставка, FX, платежная цепочка и что видно до платежа. Если математика честная, потом возьмём короткий review call на 15 минут. Когда удобно?`],
        },
        cfo_round: {
          narrow_walkthrough: [`Раз investor-readiness logic уже выглядит разумно, предлагаю короткий 15-минутный diligence review call, чтобы быстро пройти prep cost, boundary и incident path на вашем кейсе. Когда удобно?`],
          direct_call: [`Если readiness economics сходятся, давайте сразу короткий 15-минутный diligence review call, без широкого pitch, только investor-facing logic и fit. Какой слот удобен?`],
          written_first: [`Я пришлю короткую записку сегодня: hidden prep cost, зона ответственности, платежная цепочка и incident path перед diligence. Если логика выглядит приземлённо, потом возьмём короткий review call на 15 минут. Когда удобно?`],
        },
        head_finance: {
          narrow_walkthrough: [`Раз control logic уже выглядит приземлённо, предлагаю короткий 15-минутный finance control review call, чтобы пройти manual-load reduction, audit trail и boundary на вашем кейсе. Когда удобно?`],
          direct_call: [`Если control economics выглядят честно, давайте сразу короткий 15-минутный finance control review call, без широкого демо, только reconciliation load, audit trail и fit. Какой слот удобен?`],
          written_first: [`Я пришлю короткую записку сегодня: что уходит из ручной сверки, где появляется audit trail, как выглядит платежная цепочка и где проходит boundary. Если логика приземлённая, потом возьмём короткий review call на 15 минут. Когда удобно?`],
        },
        cm_winback: {
          narrow_walkthrough: [`Раз slice уже понятен, следующий шаг лучше узкий: короткий 15-минутный structure-fit call только по вашему non-RU/BY contour, без возврата в старый общий CoR разговор. Когда удобно?`],
        },
        grey_pain_switcher: {
          narrow_walkthrough: [`Если boundary и incident ownership уже выглядят рабочими, давайте короткий 15-минутный risk-fit call, чтобы пройти спорные места и понять, есть ли смысл двигаться дальше. Какой слот вам удобен?`],
        },
        direct_contract_transition: {
          narrow_walkthrough: [`Раз transition contour уже выглядит fit, предлагаю короткий 15-минутный implementation-fit call только по direct-contract slice: кто входит, какой workflow и где граница ответственности. Когда удобно?`],
        },
        panic_churn_ops: {
          narrow_walkthrough: [`Если recovery contour уже кажется рабочим, давайте короткий 15-минутный recovery-fit call, чтобы пройти escalation path и понять, подходит ли это вам как реальный operating setup. Когда удобно?`],
        },
      },
    },
    en: {
      proof: {
        rate_floor_cfo: [
          `For a CFO, premium only works if the economics hold, not just the wording: where the higher headline rate pays back through lower hidden cost, a clear responsibility boundary, and a credible incident path. Which do you want to test first: effective cost, boundary, or failure path?`,
        ],
        fx_trust_shock_finance: [
          `The value here is not “more transparency” in the abstract. It is visible total-cost logic up front: rate, FX, payout chain, and what happens if something slips. Which layer of that math do you want to see first?`,
        ],
        cfo_round: [
          `For a CFO heading into diligence, proof is not a neat structure by itself. It is the economics of readiness: how much manual investor-prep and surprise risk stays without Mellow, and what becomes predictable up front. Which do you want to test first: hidden prep cost, control boundary, or failure path?`,
        ],
        head_finance: [
          `For a Head of Finance, the value is not the phrase “audit-ready.” It is control economics: how much manual reconciliation and reporting noise comes out, what becomes visible up front, and where a new grey layer does not appear. Which do you want to unpack first: manual-load reduction, audit trail, or boundary?`,
        ],
        panic_churn_ops: [
          `For an ops team coming out of a trust break, proof is not “better compliance.” It is a recovery path people can actually rely on: who owns the incident, who informs contractors first, and what changes before panic starts. Which piece matters most to test first: owner, comms path, or escalation timing?`,
        ],
        grey_pain_switcher: [
          `After a grey-provider burn, the proof is not a cleaner slogan. It is a bounded operating model: who owns documents and payout checks, how a bank or incident question is handled, and where Mellow's responsibility stops. Which part do you want to pressure-test first: boundary, incident path, or transition load?`,
        ],
        cm_winback: [
          `For a win-back like this, the proof is not “we improved.” It is whether there is now a narrow slice where CM gives a safer operating model than the old setup: direct-contract visibility, cleaner docs, and less manual coordination for the non-RU/BY layer. Which point should we test first: slice fit, workflow, or owner model?`,
        ],
        direct_contract_transition: [
          `For a direct-contract transition, the value is not a broad relaunch. It is a safe narrow move: which slice moves first, what workflow changes for that slice, and who owns documents, payouts, and exceptions during the switch. Which piece should we unpack first: slice choice, workflow, or transition risk?`,
        ],
      },
      bridge_step: {
        rate_floor_cfo: { written_first: [`I can first send a short premium-logic breakdown for finance: where the higher rate pays back or does not, which cost layers are visible up front, and separately Mellow's boundary and incident path. Would that help?`] },
        fx_trust_shock_finance: { written_first: [`Low-pressure next step: I can send a short total-cost breakdown for your case showing rate, FX, payout chain, and the failure path up front. Would that help?`] },
        cfo_round: { written_first: [`I can first send a short investor-readiness breakdown for finance: where hidden diligence-prep cost still sits today, what becomes explainable up front, and separately Mellow's boundary and incident path. Would that help?`] },
        head_finance: { written_first: [`Low-pressure next step: I can send a short control-cost memo for your case showing what comes out of manual reconciliation, what audit trail becomes visible up front, and where the boundary sits without adding a grey layer. Would that help?`] },
        panic_churn_ops: { written_first: [`Low-pressure next step: I can send a short recovery note for your case, covering who owns incidents, how contractor comms work before and during a disruption, and where Mellow's boundary sits. Would that help?`] },
        grey_pain_switcher: { written_first: [`I can send a short incident-boundary note for your case: ownership, bank/question path, and exactly where Mellow's scope stops. Would that be the easiest way to test fit first?`] },
        cm_winback: { written_first: [`I can send a short slice map first: which non-RU/BY or direct-contract layer looks relevant now, what changes operationally, and why this is not a return to the old CoR story. Would that help?`] },
        direct_contract_transition: { written_first: [`I can send a short transition slice map first: who would move, what workflow changes for that slice, and where responsibility sits during the switch. Would that help?`] },
      },
      direct_ask: {
        rate_floor_cfo: {
          narrow_walkthrough: [`If the structure already looks grounded, let's not stretch this. I suggest a short 15-minute finance review call to pressure-test boundary, incident path, and real fit. What slot works for you?`],
          direct_call: [`If the logic holds, the next step is simple: a short 15-minute finance review call, no broad pitch, just boundary, incident path, and fit. What time works?`],
          written_first: [`I'll send the short structure memo today, covering responsibility boundary, incident path, and the defendable finance logic. If it looks grounded, let's put a short review call on the calendar right after. What slot works?`],
        },
        fx_trust_shock_finance: {
          narrow_walkthrough: [`If the cost logic already looks clear, I suggest a short 15-minute cost review call to test FX, payout path, and failure contour on your case. What time works?`],
          direct_call: [`If the math feels honest, let's do a short 15-minute cost review call, no broad demo, just economics and fit. What slot works?`],
          written_first: [`I'll send the short total-cost breakdown today, covering rate, FX, payout chain, and what the buyer sees before payment. If the math feels honest, let's put a short review call on the calendar right after. What time works?`],
        },
        cfo_round: {
          narrow_walkthrough: [`If the investor-readiness logic already looks grounded, I suggest a short 15-minute diligence review call to test prep cost, boundary, and failure path on your case. What time works?`],
          direct_call: [`If the readiness economics hold, let's do a short 15-minute diligence review call, no broad pitch, just investor-facing logic and fit. What slot works?`],
          written_first: [`I'll send the short investor-readiness memo today, covering hidden prep cost, responsibility boundary, and incident path ahead of diligence. If it looks grounded, let's put a short review call on the calendar right after. What time works?`],
        },
        head_finance: {
          narrow_walkthrough: [`If the control logic already looks grounded, I suggest a short 15-minute finance control review call to test manual-load reduction, audit trail, and boundary on your case. What time works?`],
          direct_call: [`If the control economics feel honest, let's do a short 15-minute finance control review call, no broad demo, just reconciliation load, audit trail, and fit. What slot works?`],
          written_first: [`I'll send the short control-cost memo today, covering what comes out of manual reconciliation, where audit trail appears, and where the boundary sits. If it looks grounded, let's put a short review call on the calendar right after. What time works?`],
        },
        cm_winback: {
          narrow_walkthrough: [`If the slice already looks relevant, the next step should stay narrow: a short 15-minute structure-fit call only on your non-RU/BY contour, not a return to the old broad CoR conversation. What slot works?`],
        },
        grey_pain_switcher: {
          narrow_walkthrough: [`If boundary and incident ownership already look workable, let's do a short 15-minute risk-fit call to test the open points and see whether there is real fit. What time works?`],
        },
        direct_contract_transition: {
          narrow_walkthrough: [`If the transition contour already looks like a fit, I suggest a short 15-minute implementation-fit call just on the direct-contract slice: who sits inside it, what workflow changes, and where responsibility sits. What time works?`],
        },
        panic_churn_ops: {
          narrow_walkthrough: [`If the recovery contour already feels workable, let's do a short 15-minute recovery-fit call to walk the escalation path and see if this holds as a real operating setup. What slot works?`],
        },
      },
    },
  };

  const langBank = lines[lang === 'en' ? 'en' : 'ru'];
  const patternBank = patternLines[lang === 'en' ? 'en' : 'ru'];
  const personaStageBank = personaSpecificLines[lang === 'en' ? 'en' : 'ru']?.[policy.hintStage]?.[persona?.id] || null;
  const archetype = persona?.archetype || 'finance';
  const stagePatternBank = patternBank?.[policy.hintStage]?.[winPattern] || null;
  const latestBuyerLower = latestBuyerReplyText(session).toLowerCase();
  const financePersona = ['rate_floor_cfo', 'fx_trust_shock_finance', 'cfo_round', 'head_finance'].includes(persona?.id);

  if (financePersona && ['proof', 'bridge_step'].includes(policy.hintStage)) {
    if (buyerAskedFinanceMechanicsFlow(session)) {
      const mechanicsReply = lang === 'en'
        ? `In simple terms, Mellow owns four concrete layers: contractor KYC and payout data handling, the payout route itself, the incident path when a payment goes wrong, and the contractor-facing support / SLA on that route. Your team keeps approval, budget, and internal policy decisions. If useful, I can send this as a one-page flow for your case.`
        : `Если совсем по шагам, у Mellow четыре конкретных слоя: contractor KYC и payout данные, сама платёжная цепочка, incident path если выплата идёт не так, и contractor-facing support / SLA на этой цепочке. На вашей стороне остаются approval, бюджет и внутренние решения. Если полезно, могу прислать это одной страницей под ваш кейс.`;
      return mechanicsReply;
    }
    if (buyerAskedFinanceEconomicsMath(session)) {
      if (persona?.id === 'fx_trust_shock_finance') {
        return lang === 'en'
          ? `The economic difference is usually visible in four lines: headline rate, FX spread, payout-route reliability, and the cost of a failed or delayed payment. Cheap options often look better only in the first line. I can lay those four lines out for your case in one short note.`
          : `Экономическая разница здесь обычно видна в четырёх строках: ставка, FX spread, надёжность payout route и цена ошибки или задержки. Дешёвый вариант часто выглядит лучше только в первой строке. Могу разложить эти четыре строки одной короткой запиской под ваш кейс.`;
      }
      if (persona?.id === 'head_finance') {
        return lang === 'en'
          ? `For finance control, the difference is usually not the headline rate alone. It is manual reconciliation load, exception handling time, visibility before invoicing, and whether a new grey layer appears. I can break that down in one short note for your setup.`
          : `Для finance control разница обычно не только в ставке. Она в ручной сверке, времени на разбор исключений, видимости до invoicing и в том, появляется ли новый серый слой. Могу разложить это одной короткой запиской под ваш контур.`;
      }
      if (persona?.id === 'cfo_round') {
        return lang === 'en'
          ? `Ahead of diligence, the difference is usually in preparation cost: how much manual clean-up stays inside the team, how explainable the setup is to investors, and who owns failures when something slips. I can put that into a short readiness note for your case.`
          : `Перед diligence разница обычно в цене подготовки: сколько ручной сборки остаётся внутри команды, насколько схему можно объяснить инвестору и кто держит сбой, если что-то идет не так. Могу собрать это в короткую readiness note под ваш кейс.`;
      }
      return lang === 'en'
        ? `For a CFO, the difference usually sits in three lines: hidden coordination cost, who carries the cost of payment incidents under SLA, and how predictable the all-in economics are before invoicing. I can map those three lines for your case in one short note.`
        : `Для CFO разница обычно сидит в трёх строках: скрытая цена координации, кто несёт стоимость платежного сбоя по SLA и насколько предсказуема полная экономика до invoicing. Могу разложить эти три строки одной короткой запиской под ваш кейс.`;
    }
  }

  if (personaStageBank) {
    if (policy.hintStage === 'proof') return pick(personaStageBank);
    const personaAskPool = personaStageBank[askType] || personaStageBank.written_first || personaStageBank.direct_call || null;
    if (personaAskPool?.length) return pick(personaAskPool);
  }

  if (policy.hintStage === 'diagnosis') {
    const pool = stagePatternBank?.[archetype] || stagePatternBank?.finance || langBank.diagnosis[archetype] || langBank.diagnosis.finance;
    return pick(pool);
  }
  if (policy.hintStage === 'proof') {
    const financeCostPool = lang === 'en'
      ? [
          `For finance, the proof is not a slogan. It is the economic mechanism: what the cheaper option still leaves exposed, what Mellow makes predictable, and where hidden cost or failure risk usually shows up later. Which part of that economic logic should we unpack first?`,
          `If premium is the issue, the clean answer is concrete: reliable execution in hard geos, audit trail, fewer surprise breaks, and clearer total-cost visibility. Which piece of that do you need made explicit first?`,
        ]
      : [
          `Для finance proof не в лозунге, а в экономической механике: что у дешёвого варианта остаётся неуправляемым, что Mellow делает предсказуемым и где потом обычно всплывает hidden cost или failure risk. Какой кусок этой логики вам важнее раскрыть первым?`,
          `Если вопрос в premium, чистый ответ должен быть конкретным: надёжное исполнение в hard geos, audit trail, меньше сюрпризов на payout path и лучше видимая total-cost логика. Что из этого вам нужно сделать явным первым?`,
        ];
    const pool = (concern === 'cost' && archetype === 'finance' ? financeCostPool : null) || stagePatternBank?.default || langBank.proof.default;
    return pick(pool);
  }
  if (policy.hintStage === 'repair') return pick(langBank.repair.default);
  const bank = langBank[policy.hintStage] || langBank.bridge_step;
  const patternStageBank = stagePatternBank || {};
  const acceptanceAwarePools = (() => {
    const ru = lang !== 'en';
    const personaId = persona?.id || personaMeta(session)?.id;
    const requestedArtifactType = policy.requestedArtifactType || detectRequestedArtifactType(session);
    const acceptanceState = policy.acceptanceState;
    const artifactOnly = acceptanceState === 'artifact_only';
    const artifactThenCall = acceptanceState === 'artifact_then_call';
    const callReady = artifactThenCall || acceptanceState === 'narrow_walkthrough';

    if ((artifactOnly || artifactThenCall) && ['panic_churn_ops', 'grey_pain_switcher', 'cm_winback', 'direct_contract_transition'].includes(personaId)) {
      if (personaId === 'panic_churn_ops') {
        return ru
          ? [
              `Ок, короткий recovery note по вашему кейсу пришлю сегодня. Чтобы не оставлять это на переписке, давайте сразу зафиксируем 15 минут только на escalation path, owner model и fit. Какой слот вам удобен?`,
            ]
          : [
              `Understood. I'll send the short recovery note for your case today. Rather than leave this in messages, let's lock 15 minutes just on escalation path, owner model, and fit. What slot works for you?`,
            ];
      }
      if (personaId === 'grey_pain_switcher') {
        return ru
          ? [
              `Ок, короткий incident-boundary note по вашему кейсу пришлю сегодня. И чтобы сразу проверить спорные места, давайте зафиксируем 15 минут только на boundary, incident path и fit. Какой слот вам удобен?`,
            ]
          : [
              `Understood. I'll send the short incident-boundary note for your case today. To pressure-test the risky points right away, let's lock 15 minutes only on boundary, incident path, and fit. What slot works for you?`,
            ];
      }
      if (personaId === 'cm_winback') {
        return ru
          ? [
              `Ок, короткий slice map по вашему non-RU/BY contour пришлю сегодня. И чтобы не вернуться в общий CoR разговор, давайте сразу зафиксируем 15 минут только на slice fit, workflow и owner model. Когда вам удобно?`,
            ]
          : [
              `Understood. I'll send the short slice map for your non-RU/BY contour today. To avoid drifting back into a broad CoR discussion, let's lock 15 minutes only on slice fit, workflow, and owner model. What time works?`,
            ];
      }
      if (personaId === 'direct_contract_transition') {
        return ru
          ? [
              `Ок, короткий transition slice map пришлю сегодня. И чтобы сразу проверить переход на живом кейсе, давайте зафиксируем 15 минут только на slice, workflow и boundary during switch. Какой слот вам удобен?`,
            ]
          : [
              `Understood. I'll send the short transition slice map today. To test the switch on a real case right away, let's lock 15 minutes only on slice, workflow, and boundary during the switch. What slot works for you?`,
            ];
      }
    }

    if (personaId === 'cfo_round' && (artifactOnly || artifactThenCall) && requestedArtifactType === 'generic_artifact') {
      return ru
        ? [
            `Ок, investor-readiness memo пришлю сегодня. И чтобы не растягивать это перед diligence, давайте сразу зафиксируем короткий 15-минутный review call только по prep cost, boundary и incident path. Какой слот вам удобен?`,
            `Хорошо, короткий investor-readiness outline отправлю сегодня, а следующим шагом сразу возьмём 15 минут только на readiness logic и fit. Когда вам удобно?`,
          ]
        : [
            `Understood. I'll send the investor-readiness memo today. To keep this moving ahead of diligence, let's also lock a short 15-minute review call only on prep cost, boundary, and incident path. What slot works for you?`,
            `Sounds good. I'll send the short investor-readiness outline today, and the next step can be a focused 15-minute call only on readiness logic and fit. What time works for you?`,
          ];
    }

    if ((artifactOnly || artifactThenCall) && requestedArtifactType === 'cost_breakdown') {
      return artifactOnly
        ? (ru
          ? [
              `Ок, пришлю короткий cost breakdown по вашему кейсу сегодня. Если логика сойдётся, следующим шагом возьмём короткий 15-минутный review call только по rate, FX и payout path. Подходит?`,
              `Тогда сделаем так: я отправлю короткую математику по rate, FX и payout path, без общего pitch. Если картина будет сходиться, сразу перейдём к короткому 15-минутному review call. Ок?`,
            ]
          : [
              `Understood. I'll send the short cost breakdown for your case today. If the logic holds, the next step can be a short 15-minute review call only on rate, FX, and payout path. Does that work?`,
              `Then let's do it this way: I'll send the short math on rate, FX, and payout path, with no broad pitch. If it looks grounded, we can move straight to a short 15-minute review call. Does that work?`,
            ])
        : (ru
          ? [
              `Ок, пришлю короткий cost breakdown по вашему кейсу сегодня, а потом сразу возьмём 15 минут только на review rate, FX и payout path. Какой слот вам удобен?`,
              `Тогда следующий шаг такой: с моей стороны короткая математика по rate, FX и payout path, а затем короткий call на 15 минут, чтобы быстро проверить fit. Когда вам удобно?`,
            ]
          : [
              `Understood. I'll send the short cost breakdown for your case today, then we can take 15 minutes just to review rate, FX, and payout path. What slot works for you?`,
              `Then the next step is simple: short math from my side on rate, FX, and payout path, followed by a 15-minute call to test fit quickly. What time works?`,
            ]);
    }
    if ((artifactOnly || artifactThenCall) && requestedArtifactType === 'implementation_memo') {
      return artifactOnly
        ? (ru
          ? [
              `Ок, пришлю короткий implementation memo по вашему workflow. Если contour будет выглядеть рабочим, следующим шагом возьмём 15 минут только на review fit, workflow и границу ответственности. Подходит?`,
              `Тогда так: я отправлю короткую схему по slice, workflow и границе ответственности. Если это ляжет на ваш кейс, сразу перейдём к узкому 15-минутному review call. Ок?`,
            ]
          : [
              `Understood. I'll send a short implementation memo for your workflow. If the contour looks workable, the next step can be a 15-minute review only on fit, workflow, and responsibility boundary. Does that work?`,
              `Then let's do it this way: I'll send the short slice, workflow, and responsibility-boundary outline. If it fits your case, we can move straight to a narrow 15-minute review call. Does that work?`,
            ])
        : (ru
          ? [
              `Ок, пришлю короткий implementation memo по вашему workflow, и потом коротко созвонимся на 15 минут только по этому контуру. Какой слот вам подходит?`,
              `Тогда сделаем так: я отправлю короткую схему по slice, workflow и границе ответственности, а потом коротко созвонимся на 15 минут только по этому контуру. Когда удобно?`,
            ]
          : [
              `Understood. I'll send a short implementation memo for your workflow, then we can do a focused 15-minute call just on that contour. What slot works for you?`,
              `Then let's do it this way: I'll send the short slice, workflow, and responsibility-boundary outline, then we can do a focused 15-minute call just on that contour. What time works?`,
            ]);
    }
    if ((artifactOnly || artifactThenCall) && requestedArtifactType === 'competitor_brief') {
      return artifactOnly
        ? (ru
          ? [`Ок, пришлю короткий competitor brief по вашему сравнению. Если логика на вашем кейсе сойдётся, следующим шагом возьмём 15 минут только на cheaper option vs Mellow без общего pitch. Подходит?`]
          : [`Understood. I'll send the short competitor brief for your comparison. If the logic holds on your case, the next step can be 15 minutes only on cheaper option vs Mellow, with no broad pitch. Does that work?`])
        : (ru
          ? [`Ок, пришлю короткий competitor brief по вашему сравнению, а потом коротко созвонимся на 15 минут, чтобы на вашем кейсе пройти cheaper option vs Mellow без общего pitch. Когда удобно?`]
          : [`Understood. I'll send the short competitor brief for your comparison, then we can do a 15-minute call to walk cheaper option vs Mellow on your case, with no broad pitch. What time works?`]);
    }
    if ((artifactOnly || artifactThenCall) && (requestedArtifactType === 'slice_map' || requestedArtifactType === 'generic_artifact' || policy.askType === 'narrow_walkthrough')) {
      return artifactOnly
        ? (ru
          ? [
              `Ок, пришлю короткий материал именно по вашему узкому сценарию. Если увидим fit, следующим шагом возьмём короткий 15-минутный review call только на спорные места. Подходит?`,
              `Давайте так: сначала короткий written outline по вашему кейсу, а если логика сойдётся, потом 15 минут голосом только на открытые вопросы и fit. Ок?`,
            ]
          : [
              `Understood. I'll send a short note for your narrow scenario. If we see fit, the next step can be a short 15-minute review call only on the open points. Does that work?`,
              `Let's do it this way: short written outline for your case first, and if the logic holds, then 15 minutes live just on the open points and fit. Does that work?`,
            ])
        : (ru
          ? [
              `Ок, пришлю короткий материал именно по вашему узкому сценарию, и потом зафиксируем короткий 15-минутный review call только на спорные места и fit. Какой слот вам удобен?`,
              `Давайте так: сначала короткий written outline по вашему кейсу, а потом 15 минут голосом только на спорные места и fit. Когда вам удобно?`,
            ]
          : [
              `Understood. I'll send a short note for your narrow scenario, then let's lock a short 15-minute review call only on the open points and fit. What slot works for you?`,
              `Let's do it this way: short written outline for your case first, then 15 minutes live just on the open points and fit. What time works?`,
            ]);
    }
    if (callReady) return null;
    return null;
  })();
  if (acceptanceAwarePools?.length) return pick(acceptanceAwarePools);
  return pick(patternStageBank[askType] || patternStageBank.written_first || bank[askType] || bank.written_first || bank.default);
}

function hintTurnStage(session) {
  return getSellerProgressionStage(session);
}

// Track stage + ask metadata on a seller entry. Call after pushing entry to transcript.
function trackSellerTurnMetadata(session, sellerEntry, sellerText) {
  const stage = hintTurnStage(session);
  const policy = getHintPolicyContext(session);
  sellerEntry.turn_stage = stage;
  sellerEntry.hint_stage = policy.hintStage;
  sellerEntry.acceptance_state_before = policy.acceptanceState;
  sellerEntry.ask_allowed_at_hint_time = policy.askAllowed;
  sellerEntry.repair_state_bool = policy.repairState;
  sellerEntry.bridge_step_type = (policy.hintStage === 'bridge_step' || policy.hintStage === 'direct_ask') ? policy.askType : null;
  sellerEntry.ask_intent = policy.askIntent;
  sellerEntry.persona_acceptance_bias = getPersonaAcceptanceBias(session);
  sellerEntry.hint_variant = getHintVariant(session, policy.hintStage);
  sellerEntry.hint_schema = computeHintSchema(session, policy);
  const mixedModeCheck = validateMixedMode(sellerText, policy.hintStage);
  sellerEntry.mixed_mode_violation = mixedModeCheck.violation || null;

  const isMeetingAsk = detectMeetingAskText(sellerText);
  if (isMeetingAsk) {
    session.meta.meeting_ask_count = (session.meta.meeting_ask_count || 0) + 1;
    if (!session.meta.ask_events) session.meta.ask_events = [];
    const acceptanceDrivenClose = ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(policy.acceptanceState)
      && (policy.hintStage === 'bridge_step' || policy.hintStage === 'direct_ask');
    const askType = stage === 'closing' || acceptanceDrivenClose ? policy.askIntent : 'premature_ask';
    session.meta.ask_events.push({ turn: sellerMessages(session).length, stage, ask_type: askType, hint_stage: policy.hintStage, acceptance_state_before: policy.acceptanceState });
    sellerEntry.ask_type = askType;
    sellerEntry.premature_ask_bool = askType === 'premature_ask';
  } else {
    sellerEntry.premature_ask_bool = false;
  }
}

function applyBuyerAcceptanceOutcome(session, sellerEntry, reply) {
  if (!reply) return;
  const acceptanceState = getBuyerAcceptanceState(session);
  const acceptanceEvent = getAcceptanceEventType(session);
  const acceptanceStage = getBuyerAcceptanceStage(session);
  const stageReasons = getBuyerAcceptanceStageReasons(session);
  sellerEntry.acceptance_state_after = acceptanceState;
  sellerEntry.acceptance_event = acceptanceEvent;
  sellerEntry.acceptance_stage_after = acceptanceStage;
  sellerEntry.acceptance_stage_reasons = stageReasons;
  session.meta.acceptance_state = acceptanceState;
  session.meta.acceptance_stage = acceptanceStage;
  if (!session.meta.acceptance_events) session.meta.acceptance_events = [];
  if (!session.meta.acceptance_stage_history) session.meta.acceptance_stage_history = [];
  if (acceptanceEvent) {
    session.meta.acceptance_events.push({
      turn: sellerMessages(session).length,
      event: acceptanceEvent,
      acceptance_state: acceptanceState,
      acceptance_stage: acceptanceStage,
      reasons: stageReasons,
      ask_intent: sellerEntry.ask_intent || null,
    });
  }
  const lastStage = session.meta.acceptance_stage_history.length
    ? session.meta.acceptance_stage_history[session.meta.acceptance_stage_history.length - 1].stage
    : null;
  if (acceptanceStage && acceptanceStage !== lastStage) {
    session.meta.acceptance_stage_history.push({
      turn: sellerMessages(session).length,
      stage: acceptanceStage,
      reasons: stageReasons,
      seller_text: sellerEntry.text,
      buyer_text: reply,
    });
  }
}

// Classify why a finished dialogue failed to book a meeting.
function classifyMeetingFailureReason(session) {
  if (sessionHasMeetingBooked(session)) return 'meeting_booked';
  const askCount = session.meta?.meeting_ask_count || 0;
  const askEvents = session.meta?.ask_events || [];
  const acceptanceState = session.meta?.acceptance_state || 'not_ready';
  const ghostTurns = session.meta?.ghost_turns || 0;
  const trust = session.meta?.trust || 1;
  const resolvedCount = Object.keys(session.meta?.resolved_concerns || {}).length;
  const activeConcern = getActiveConcern(session);
  if (ghostTurns >= 2) return 'buyer_disengaged';
  if (acceptanceState === 'artifact_only') return 'artifact_accepted_but_not_converted';
  if (acceptanceState === 'artifact_then_call') return 'artifact_then_call_not_landed';
  if (acceptanceState === 'narrow_walkthrough') return 'walkthrough_ready_but_not_booked';
  if (askCount === 0) return 'no_ask_made';
  if (!askEvents.some((e) => e.ask_type && e.ask_type !== 'premature_ask')) return 'premature_ask';
  if (trust < 1.2) return 'trust_deficit';
  if (activeConcern && resolvedCount === 0) return 'unresolved_concerns';
  return 'ask_not_landed';
}

// Build a compact dialogue card summary for the review surface.
function buildDialogueSummary(session) {
  const rawAskEvents = session.meta?.ask_events || [];
  const acceptanceEvents = session.meta?.acceptance_events || [];
  const acceptanceStageHistory = session.meta?.acceptance_stage_history || [];
  const meetingBooked = sessionHasMeetingBooked(session);
  const failureReason = classifyMeetingFailureReason(session);
  const resolvedConcerns = Object.keys(session.meta?.resolved_concerns || {});
  const ghostTurns = session.meta?.ghost_turns || 0;
  const trust = Number((session.meta?.trust || 1).toFixed(2));
  const acceptanceState = session.meta?.acceptance_state || getBuyerAcceptanceState(session);
  const acceptanceStage = session.meta?.acceptance_stage || getBuyerAcceptanceStage(session);
  const latestAcceptanceEvent = acceptanceEvents.length ? acceptanceEvents[acceptanceEvents.length - 1].event : null;

  // Derive ordered stages reached and hint_stage_breakdown from transcript
  const stagesSeen = new Set();
  const stagesReached = [];
  const hintStageBreakdown = {};
  const sellerEntries = [];
  for (const entry of session.transcript || []) {
    if (entry.role !== 'seller') continue;
    if (entry.turn_stage && !stagesSeen.has(entry.turn_stage)) {
      stagesSeen.add(entry.turn_stage);
      stagesReached.push(entry.turn_stage);
    }
    if (entry.hint_stage) {
      hintStageBreakdown[entry.hint_stage] = (hintStageBreakdown[entry.hint_stage] || 0) + 1;
    }
    sellerEntries.push(entry);
  }

  // Backfill hint_stage on ask_events for sessions recorded before MEL-1044
  const askEvents = rawAskEvents.map((ev) => {
    if (ev.hint_stage) return ev;
    const entry = sellerEntries[ev.turn - 1];
    return entry?.hint_stage ? { ...ev, hint_stage: entry.hint_stage } : ev;
  });

  // Progression score 0–1: how far seller advanced
  let progressionScore = 0;
  if (sellerMessages(session).length >= 1) progressionScore = 0.1;
  if (resolvedConcerns.length >= 1) progressionScore = 0.4;
  if (askEvents.length >= 1) progressionScore = 0.6;
  if (askEvents.some((e) => e.stage === 'closing')) progressionScore = 0.8;
  if (meetingBooked) progressionScore = 1.0;

  return {
    seller_turns: sellerMessages(session).length,
    doctrine_family: getDoctrineFamilyForPersonaId(session?.bot_id || '', personaMeta(session)?.archetype || ''),
    doctrine_family_label: getDoctrineFamilyLabel(getDoctrineFamilyForPersonaId(session?.bot_id || '', personaMeta(session)?.archetype || '')),
    language: session?.language || 'ru',
    language_locked: Boolean(session?.meta?.language_locked),
    stages_reached: stagesReached,
    ask_events: askEvents,
    acceptance_events: acceptanceEvents,
    acceptance_state: acceptanceState,
    acceptance_event: latestAcceptanceEvent,
    acceptance_stage: acceptanceStage,
    acceptance_stage_history: acceptanceStageHistory,
    hint_stage_breakdown: hintStageBreakdown,
    failure_reason: failureReason,
    meeting_booked: meetingBooked,
    progression_score: Number(progressionScore.toFixed(2)),
    trust_final: trust,
    ghost_turns: ghostTurns,
    resolved_concerns: resolvedConcerns,
  };
}

const HINT_MEMORY_METRIC_KEYS = [
  'reply_likelihood',
  'next_step_likelihood',
  'disengagement_risk',
];

function normalizeHintMetricSnapshot(metrics = {}) {
  if (!metrics || typeof metrics !== 'object') return {};
  const normalized = {};
  for (const key of HINT_MEMORY_METRIC_KEYS) {
    const value = Number(metrics?.[key]);
    if (!Number.isFinite(value)) continue;
    normalized[key] = Number(value.toFixed(2));
  }
  return normalized;
}

function hintMetricSnapshotFromBuyerState(state = {}) {
  return normalizeHintMetricSnapshot({
    reply_likelihood: state?.reply_likelihood,
    next_step_likelihood: state?.next_step_likelihood,
    disengagement_risk: state?.disengagement_risk,
  });
}

function inferBuyerStateBefore(buyerStateAfter = {}, buyerStateDeltas = {}) {
  const inferred = {};
  for (const key of BUYER_STATE_DIMENSIONS) {
    const after = Number(buyerStateAfter?.[key]);
    const delta = Number(buyerStateDeltas?.[key]);
    if (!Number.isFinite(after) && !Number.isFinite(delta)) continue;
    inferred[key] = roundMetric((Number.isFinite(after) ? after : 0) - (Number.isFinite(delta) ? delta : 0));
  }
  return inferred;
}

function buildHintTurnDeltas({
  explicitTurnDeltas = null,
  buyerStateBefore = {},
  buyerStateAfter = {},
  buyerMetricsBefore = {},
  buyerMetricsAfter = {},
  fallbackBuyerStateDeltas = {},
}) {
  const normalized = {
    buyer_state: {},
    buyer_metrics: {},
  };
  const explicitState = explicitTurnDeltas?.buyer_state && typeof explicitTurnDeltas.buyer_state === 'object'
    ? explicitTurnDeltas.buyer_state
    : {};
  const explicitMetrics = explicitTurnDeltas?.buyer_metrics && typeof explicitTurnDeltas.buyer_metrics === 'object'
    ? explicitTurnDeltas.buyer_metrics
    : {};

  for (const key of BUYER_STATE_DIMENSIONS) {
    const explicitValue = Number(explicitState?.[key]);
    if (Number.isFinite(explicitValue)) {
      normalized.buyer_state[key] = roundMetric(explicitValue);
      continue;
    }
    const before = Number(buyerStateBefore?.[key]);
    const after = Number(buyerStateAfter?.[key]);
    if (Number.isFinite(before) && Number.isFinite(after)) {
      normalized.buyer_state[key] = roundMetric(after - before);
      continue;
    }
    const fallback = Number(fallbackBuyerStateDeltas?.[key]);
    if (Number.isFinite(fallback)) normalized.buyer_state[key] = roundMetric(fallback);
  }

  for (const key of HINT_MEMORY_METRIC_KEYS) {
    const explicitValue = Number(explicitMetrics?.[key]);
    if (Number.isFinite(explicitValue)) {
      normalized.buyer_metrics[key] = Number(explicitValue.toFixed(2));
      continue;
    }
    const before = Number(buyerMetricsBefore?.[key]);
    const after = Number(buyerMetricsAfter?.[key]);
    if (Number.isFinite(before) && Number.isFinite(after)) {
      normalized.buyer_metrics[key] = Number((after - before).toFixed(2));
    }
  }

  return normalized;
}

function buildHintFailureFlags({
  riskFlags = [],
  failureFlags = [],
  replyOutcome = null,
  turnDeltas = {},
}) {
  const flags = new Set([
    ...((Array.isArray(riskFlags) ? riskFlags : []).map(String).filter(Boolean)),
    ...((Array.isArray(failureFlags) ? failureFlags : []).map(String).filter(Boolean)),
  ]);
  const stateDelta = turnDeltas?.buyer_state || {};
  const metricDelta = turnDeltas?.buyer_metrics || {};

  if (replyOutcome === 'silent') flags.add('silent_reply');
  if (Number(stateDelta?.trust || 0) < 0) flags.add('trust_drop');
  if (Number(stateDelta?.clarity || 0) < 0) flags.add('clarity_drop');
  if (Number(stateDelta?.conversation_capacity || 0) < 0 && Number(stateDelta?.interest || 0) <= 0) {
    flags.add('capacity_loss');
  }
  if (Number(metricDelta?.disengagement_risk || 0) > 0.08) flags.add('disengagement_increase');

  return [...flags];
}

// Detects semantic negative patterns from hint text and behavioral failure signals.
// Produces the 8 labels required by Step 3 of the learning loop rebuild.
function buildNegativeFlags(hintText = '', failureFlags = [], turnDeltas = {}, sellerTurnIndex = 1) {
  const lower = String(hintText).toLowerCase().trim();
  const stateDelta = turnDeltas?.buyer_state || {};
  const flags = new Set();

  // Behavioral flags mapped from outcome signals
  if (failureFlags.includes('overclaim_scope')) flags.add('overclaim');
  if (failureFlags.includes('trust_drop')) flags.add('trust_drop');
  if (failureFlags.includes('silent_reply')) flags.add('no_reply_trigger');
  if (failureFlags.includes('capacity_loss')) flags.add('blocked_conversation');
  if (failureFlags.includes('clarity_drop') || Number(stateDelta?.clarity || 0) < -0.1) {
    flags.add('low_clarity');
  }

  // Text-based pattern detection
  if (hasAny(lower, ['guarantee', 'guaranteed', '10x', 'always works', 'never fail', 'best in class',
    'market leader', 'outperform', 'dramatically reduce', 'eliminate all', 'completely remove'])) {
    flags.add('overclaim');
  }
  if (hasAny(lower, ['platform', 'solution', 'innovative', 'seamless', 'cutting-edge',
    'state-of-the-art', 'next-generation', 'revolutionize', 'transform your', 'game-changer',
    'end-to-end', 'world-class', 'industry-leading'])) {
    flags.add('vague_value');
  }
  // Early CTA: asking for meeting or demo in the opening turn
  const hasCta = hasAny(lower, ['schedule a call', 'book a call', 'book a meeting', 'hop on a call',
    'let\'s connect', 'quick call', 'jump on', 'demo', '15-minute', '20-minute', '30-minute',
    'let me know if you\'d like to connect']);
  if (hasCta && sellerTurnIndex <= 1) flags.add('early_cta');
  if (hasAny(lower, ['hope this finds you', 'hope you\'re doing well', 'just wanted to reach out',
    'touching base', 'following up with you', 'checking in', 'i noticed your profile',
    'congrats on your recent', 'quick question for you', 'my name is'])) {
    flags.add('generic_opener');
  }

  return [...flags];
}

// Scores a hint on 7 structural dimensions (0.0–1.0 each).
// Higher = more of that quality present. pressure_level is an exception:
// high means more pushy, so it ranks as a "bad" pattern when elevated.
function buildPatternProfile(hintText = '', failureFlags = [], sellerTurnIndex = 1) {
  const lower = String(hintText).toLowerCase().trim();
  const wordCount = lower.split(/\s+/).filter(Boolean).length;

  // specificity — concrete numbers, named mechanisms, explicit timeframes
  const specificitySignals = [
    /\b\d+\s*%/, /\b\d+\s*(hour|day|week|minute|min)\b/, /\b(kyc|sla|aml|api|saas|b2b|roi|arr|mrr)\b/i,
    /\b(contractor|freelancer|invoice|payment|compliance|audit|document|onboard)\b/i,
    /\b(exactly|specifically|in particular|for instance|for example|such as)\b/i,
  ];
  const specificityHits = specificitySignals.filter((rx) => rx.test(lower)).length;
  const specificity = clampNumber(specificityHits / 3, 0, 1);

  // proof — evidence, outcomes, case references, real metrics
  const proofSignals = [
    /\b\d+\s*%/, /\b(case study|we helped|one client|a client|a customer|our client|proved|results show)\b/i,
    /\b\d+\s*(hour|day|week)\b/, /\b(reduce|saved|increased|cut|improved|went from|down to|up to)\b.*\b\d+/i,
    /\b(example|for instance|in practice|in our experience|based on data)\b/i,
  ];
  const proofHits = proofSignals.filter((rx) => rx.test(lower)).length;
  const proof = clampNumber(proofHits / 3, 0, 1);

  // scope_clarity — explicit scope/boundary language
  const scopeSignals = [
    /\b(we (don't|do not|won't|will not|can't|cannot)|outside (our |the )?scope|not responsible|limited to|focused (on|around)|only handle|specifically for)\b/i,
    /\b(boundaries|responsibility|remit|coverage|included|excluded)\b/i,
    /\b(what we (do|don't|cover|handle|include))\b/i,
  ];
  const scopeHits = scopeSignals.filter((rx) => rx.test(lower)).length;
  const scopeClarity = clampNumber(scopeHits / 2, 0, 1);

  // compliance_safety — inverse of overclaim markers; starts high, drops on red flags
  const overclaim = [
    /\b(guarantee|guaranteed|always works|never fails?|100%|best in class|market leader|outperform|eliminate all)\b/i,
    /\b(dramatically|revolutionize|transform(ation)?|game.?changer|cutting.?edge|state.of.the.art|world.?class)\b/i,
    /\b(industry.?leading|next.?generation|unmatched|unparalleled|unprecedented)\b/i,
  ];
  const overclaims = overclaim.filter((rx) => rx.test(lower)).length
    + (failureFlags.includes('overclaim_scope') ? 2 : 0);
  const complianceSafety = clampNumber(1 - overclaims / 3, 0, 1);

  // next_step_ask — clear call to action for a meeting, call, or next step
  const nextStepSignals = [
    /\b(schedule|book|set up|arrange|organize)\b.{0,30}(call|meeting|chat|demo|walkthrough|session)\b/i,
    /\b(quick call|15.?min|20.?min|30.?min|next step|hop on|let's (talk|connect|meet))\b/i,
    /\b(would you be open|happy to|worth a|worth exploring|let me know if)\b/i,
    /\b(созвон|встреча|пообщаемся|предлагаю|обсудим)\b/i,
  ];
  const nextStepHits = nextStepSignals.filter((rx) => rx.test(lower)).length;
  const nextStepAsk = clampNumber(nextStepHits / 2, 0, 1);

  // pressure_level — how pushy/urgent the hint feels (high = problematic)
  const pressureSignals = [
    /\b(now|today|immediately|urgent|asap|don't miss|limited time|act now|last chance)\b/i,
    /\b(you need to|you should|you must|you have to|strongly recommend|i insist)\b/i,
  ];
  // early CTA also inflates pressure
  const pressureHits = pressureSignals.filter((rx) => rx.test(lower)).length
    + (nextStepHits >= 1 && sellerTurnIndex <= 1 ? 1 : 0);
  const pressureLevel = clampNumber(pressureHits / 2, 0, 1);

  // personalization_depth — hints tailored to buyer context
  const personalizationSignals = [
    /\b(your (team|company|business|workflow|process|situation|role|industry|challenge|pain|goal))\b/i,
    /\b(based on what you|given (your|what you)|for (your|companies like yours))\b/i,
    /\b(i noticed|i saw|you mentioned|sounds like|it seems like you)\b/i,
    /\b(freelancer|contractor|crypto|legal|compliance|fintech|startup|agency|marketplace)\b/i,
  ];
  const personalizationHits = personalizationSignals.filter((rx) => rx.test(lower)).length;
  // Short hints (<12 words) can't be deeply personalized
  const personalizationDepth = wordCount < 12
    ? clampNumber(personalizationHits / 3 * 0.5, 0, 1)
    : clampNumber(personalizationHits / 3, 0, 1);

  return {
    specificity: Number(specificity.toFixed(3)),
    proof: Number(proof.toFixed(3)),
    scope_clarity: Number(scopeClarity.toFixed(3)),
    compliance_safety: Number(complianceSafety.toFixed(3)),
    next_step_ask: Number(nextStepAsk.toFixed(3)),
    pressure_level: Number(pressureLevel.toFixed(3)),
    personalization_depth: Number(personalizationDepth.toFixed(3)),
  };
}

function computeHintNormalizedScore({
  turnDeltas = {},
  meetingProgress = false,
  replyOutcome = null,
  failureFlags = [],
}) {
  const stateDelta = turnDeltas?.buyer_state || {};
  const metricDelta = turnDeltas?.buyer_metrics || {};
  let rawScore = 0;

  rawScore += Number(stateDelta?.patience || 0) * 0.35;
  rawScore += Number(stateDelta?.interest || 0) * 1.2;
  rawScore += Number(stateDelta?.perceived_value || 0) * 1.3;
  rawScore += Number(stateDelta?.trust || 0) * 1.25;
  rawScore += Number(stateDelta?.clarity || 0) * 1.15;
  rawScore += Number(stateDelta?.conversation_capacity || 0) * 8;

  rawScore += Number(metricDelta?.reply_likelihood || 0) * 24;
  rawScore += Number(metricDelta?.next_step_likelihood || 0) * 32;
  rawScore -= Number(metricDelta?.disengagement_risk || 0) * 28;

  if (meetingProgress) rawScore += 12;
  if (replyOutcome === 'replied') rawScore += 3;
  if (replyOutcome === 'silent') rawScore -= 8;

  const penalties = {
    overclaim_scope: 16,
    low_trust: 8,
    low_clarity: 7,
    near_disengagement: 10,
    silent_reply: 4,
    trust_drop: 4,
    clarity_drop: 4,
    capacity_loss: 4,
    disengagement_increase: 6,
  };
  for (const flag of Array.isArray(failureFlags) ? failureFlags : []) {
    rawScore -= penalties[flag] ?? 3;
  }

  return Number(clampNumber(Math.tanh(rawScore / 45), -1, 1).toFixed(4));
}

function classifyHintOutcome(score = 0, failureFlags = [], meetingProgress = false, isPending = false) {
  if (isPending) return 'pending';
  if (meetingProgress) return 'meeting_progress';
  if ((Array.isArray(failureFlags) ? failureFlags : []).includes('overclaim_scope') || score <= -0.55) {
    return 'failed';
  }
  if (score <= -0.18) return 'weak';
  if (score < 0.4) return 'neutral';
  return 'positive';
}

function normalizeHintMemoryRecord(record, index = 0) {
  if (!record || typeof record !== 'object') return null;
  const buyerStateDeltas = record.buyer_state_deltas && typeof record.buyer_state_deltas === 'object'
    ? record.buyer_state_deltas
    : {};
  const buyerStateAfter = record.buyer_state_after && typeof record.buyer_state_after === 'object'
    ? record.buyer_state_after
    : {};
  const buyerStateBefore = record.buyer_state_before && typeof record.buyer_state_before === 'object'
    ? record.buyer_state_before
    : inferBuyerStateBefore(buyerStateAfter, buyerStateDeltas);
  const buyerMetricsBefore = record.buyer_metrics_before && typeof record.buyer_metrics_before === 'object'
    ? record.buyer_metrics_before
    : normalizeHintMetricSnapshot(record?.retrieval_context?.context?.buyer_metrics || {});
  const buyerMetricsAfter = record.buyer_metrics_after && typeof record.buyer_metrics_after === 'object'
    ? record.buyer_metrics_after
    : {};
  const turnDeltas = buildHintTurnDeltas({
    explicitTurnDeltas: record.turn_deltas,
    buyerStateBefore,
    buyerStateAfter,
    buyerMetricsBefore,
    buyerMetricsAfter,
    fallbackBuyerStateDeltas: buyerStateDeltas,
  });
  const meetingProgress = record.meeting_progress === true;
  const finalMeetingSignal = record.final_meeting_signal === true;
  const buyerReplyOutcome = record.buyer_reply_outcome ? String(record.buyer_reply_outcome) : null;
  const failureFlags = buildHintFailureFlags({
    riskFlags: record.risk_flags,
    failureFlags: record.failure_flags,
    replyOutcome: buyerReplyOutcome,
    turnDeltas,
  });
  const isPending = record.outcome_label === 'pending'
    && record.was_used !== true
    && !record.used_at
    && !Object.keys(buyerStateAfter).length
    && !Object.keys(turnDeltas.buyer_state || {}).length
    && !Object.keys(turnDeltas.buyer_metrics || {}).length
    && !buyerReplyOutcome;
  const finalNormalizedScore = Number.isFinite(Number(record.final_normalized_score))
    ? Number(clampNumber(Number(record.final_normalized_score), -1, 1).toFixed(4))
    : computeHintNormalizedScore({
      turnDeltas,
      meetingProgress,
      replyOutcome: buyerReplyOutcome,
      failureFlags,
    });
  const turnStage = String(record.turn_stage || record.stage || 'follow_up');
  const hintStage = String(record.hint_stage || record.context?.hint_stage || turnStage || 'proof');
  const hintText = String(record.hint_text || record.used_hint_text || record.generated_hint || '').trim();

  const normalized = {
    id: String(record.id || `hint_memory_${index}`),
    version: String(record.version || HINT_MEMORY_VERSION),
    created_at: String(record.created_at || now()),
    used_at: record.used_at ? String(record.used_at) : null,
    session_id: String(record.session_id || ''),
    persona_id: String(record.persona_id || ''),
    persona_archetype: String(record.persona_archetype || ''),
    persona: record.persona && typeof record.persona === 'object'
      ? record.persona
      : {
        id: String(record.persona_id || ''),
        archetype: String(record.persona_archetype || ''),
      },
    dialogue_type: normalizeDialogueType(record.dialogue_type),
    seller_turn_index: Number(record.seller_turn_index || 0),
    turn_stage: turnStage,
    stage: turnStage,
    active_concern: record.active_concern ? String(record.active_concern) : null,
    signal_type: record.signal_type ? String(record.signal_type) : null,
    seller_message_context: String(record.seller_message_context || ''),
    context: {
      ...((record.context && typeof record.context === 'object') ? record.context : {}),
      seller_message_context: String(record.context?.seller_message_context || record.seller_message_context || ''),
      active_concern: record.context?.active_concern ? String(record.context.active_concern) : (record.active_concern ? String(record.active_concern) : null),
      signal_type: record.context?.signal_type ? String(record.context.signal_type) : (record.signal_type ? String(record.signal_type) : null),
      dialogue_type: normalizeDialogueType(record.context?.dialogue_type || record.dialogue_type),
      seller_turn_index: Number(record.context?.seller_turn_index || record.seller_turn_index || 0),
      hint_stage: hintStage,
      ask_allowed_at_hint_time: record.ask_allowed_at_hint_time === true,
      repair_state_bool: record.repair_state_bool === true,
      bridge_step_type: record.bridge_step_type ? String(record.bridge_step_type) : null,
      source: String(record.context?.source || record.source || 'hint'),
    },
    hint_stage: hintStage,
    generated_hint: String(record.generated_hint || '').trim(),
    used_hint_text: String(record.used_hint_text || '').trim(),
    hint_text: hintText,
    was_used: record.was_used === true,
    source: String(record.source || 'hint'),
    hint_language: record.hint_language === 'ru' ? 'ru' : 'en',
    ask_allowed_at_hint_time: record.ask_allowed_at_hint_time === true,
    repair_state_bool: record.repair_state_bool === true,
    bridge_step_type: record.bridge_step_type ? String(record.bridge_step_type) : null,
    accepted_next_step_type: record.accepted_next_step_type ? String(record.accepted_next_step_type) : null,
    premature_ask_bool: record.premature_ask_bool === true,
    retrieval_context: record.retrieval_context && typeof record.retrieval_context === 'object'
      ? record.retrieval_context
      : null,
    buyer_state_before: buyerStateBefore,
    buyer_state_deltas: turnDeltas.buyer_state,
    buyer_state_after: buyerStateAfter,
    buyer_metrics_before: buyerMetricsBefore,
    buyer_metrics_after: buyerMetricsAfter,
    turn_deltas: turnDeltas,
    buyer_reply_outcome: buyerReplyOutcome,
    outcome_label: classifyHintOutcome(
      finalNormalizedScore,
      failureFlags,
      meetingProgress,
      isPending
    ),
    meeting_progress: meetingProgress,
    final_meeting_signal: finalMeetingSignal,
    notes: String(record.notes || '').trim(),
    risk_flags: Array.isArray(record.risk_flags) ? record.risk_flags.map(String).filter(Boolean) : [],
    failure_flags: failureFlags,
    negative_flags: Array.isArray(record.negative_flags)
      ? record.negative_flags.map(String).filter(Boolean)
      : buildNegativeFlags(hintText, failureFlags, turnDeltas, Number(record.seller_turn_index || 0)),
    pattern_profile: record.pattern_profile && typeof record.pattern_profile === 'object'
      ? {
        specificity: Number(record.pattern_profile.specificity ?? 0),
        proof: Number(record.pattern_profile.proof ?? 0),
        scope_clarity: Number(record.pattern_profile.scope_clarity ?? 0),
        compliance_safety: Number(record.pattern_profile.compliance_safety ?? 0),
        next_step_ask: Number(record.pattern_profile.next_step_ask ?? 0),
        pressure_level: Number(record.pattern_profile.pressure_level ?? 0),
        personalization_depth: Number(record.pattern_profile.personalization_depth ?? 0),
      }
      : buildPatternProfile(hintText, failureFlags, Number(record.seller_turn_index || 0)),
    coaching_notes: Array.isArray(record.coaching_notes) ? record.coaching_notes.map(String).filter(Boolean) : [],
    patterns: Array.isArray(record.patterns) ? record.patterns.map(String).filter(Boolean) : hintPatterns(record.generated_hint || ''),
    final_verdict: record.final_verdict ? String(record.final_verdict) : null,
    assessment_id: record.assessment_id ? String(record.assessment_id) : null,
    final_normalized_score: finalNormalizedScore,
    effect_score: finalNormalizedScore,
    buyer_progress_delta: record.buyer_progress_delta && typeof record.buyer_progress_delta === 'object'
      ? record.buyer_progress_delta
      : {
        trust: Number(turnDeltas?.buyer_state?.trust || 0),
        clarity: Number(turnDeltas?.buyer_state?.clarity || 0),
        next_step_likelihood: Number(turnDeltas?.buyer_metrics?.next_step_likelihood || 0),
      },
    exploration_strategy: record.exploration_strategy
      ? String(record.exploration_strategy)
      : null,
    retrieval_count: Number(record.retrieval_count || 0),
  };
  return normalized;
}

function hintPatterns(text = '') {
  const lower = normalizeHintText(text);
  const patterns = new Set();
  const checks = [
    ['signal_led_open', ['legal review', 'investor', 'audit', 'wise', 'crypto', 'manual', 'stuck', 'review', 'contractor']],
    ['scope_boundary', ['scope', 'boundary', 'responsib', 'misclassification', 'not take', 'do not', 'won\'t']],
    ['mechanism_specificity', ['kyc', 'document', 'audit trail', 'payment chain', 'status', 'sla', 'incident']],
    ['proof_or_numbers', ['18 hour', '20 minute', '15 minute', '80%', 'case', 'hours', 'days', 'week']],
    ['ops_value', ['manual', 'follow-up', 'statuses', 'auto-pay', 'predictable', 'time']],
    ['next_step_ask', ['call', 'meeting', 'walkthrough', 'memo', 'review', 'this week']],
    ['marketing_heavy', ['platform', 'solution', 'best-in-class', 'market leader', 'innovative', 'seamless']],
  ];
  for (const [label, markers] of checks) {
    if (markers.some((marker) => lower.includes(marker))) patterns.add(label);
  }
  return [...patterns];
}

function meetingProgressSignals(session = {}, transition = {}, sellerText = '') {
  const lower = String(sellerText || '').toLowerCase();
  const lang = session?.language || 'ru';
  const nextStepCriterion = session?.assessment?.criteria?.find((criterion) => criterion.id === 'K5');
  const nextStepBefore = Number(transition?.derived_metrics_before?.next_step_likelihood || 0);
  const nextStepAfter = Number(transition?.derived_metrics_after?.next_step_likelihood || 0);
  const askSignal = hasAny(lower, ['call', 'meeting', '15 minute', '20 minute', 'review', 'memo', 'walkthrough', 'созвон', '15 минут', '20 минут', 'материал']);
  const harmfulTurn = (transition?.risk_flags || []).includes('overclaim_scope')
    || nextStepAfter < nextStepBefore
    || Number(transition?.derived_metrics_after?.disengagement_risk || 0) >= 0.7;
  const turnSignal = !harmfulTurn && (
    nextStepAfter >= 0.45
      || (askSignal && nextStepAfter >= nextStepBefore)
  );
  // Check if the most recent buyer reply contains explicit meeting acceptance
  const recentBotReplies = (session?.transcript || []).filter((e) => e.role === 'bot').slice(-1);
  const buyerAccepted = recentBotReplies.some((e) => detectBuyerMeetingAcceptance(e.text, lang));
  const finalSignal = buyerAccepted
    || nextStepCriterion?.status === 'PASS'
    || Number(session?.buyer_state?.next_step_likelihood || 0) >= 0.55
    || session?.meta?.meeting_booked === true;
  return { turnSignal: turnSignal || buyerAccepted, finalSignal };
}

function assessHintEffect(transition = {}, session = {}, replyOutcome = null, sellerText = '') {
  const buyerStateBefore = transition?.state_before && typeof transition.state_before === 'object'
    ? transition.state_before
    : {};
  const buyerStateAfter = transition?.state_after && typeof transition.state_after === 'object'
    ? transition.state_after
    : {};
  const buyerMetricsBefore = normalizeHintMetricSnapshot(transition?.derived_metrics_before || {});
  const buyerMetricsAfter = normalizeHintMetricSnapshot(transition?.derived_metrics_after || {});
  const turnDeltas = buildHintTurnDeltas({
    explicitTurnDeltas: {
      buyer_state: transition?.predicted_delta || {},
      buyer_metrics: transition?.derived_metrics_delta || {},
    },
    buyerStateBefore,
    buyerStateAfter,
    buyerMetricsBefore,
    buyerMetricsAfter,
    fallbackBuyerStateDeltas: transition?.predicted_delta || {},
  });
  const meetingSignals = meetingProgressSignals(session, transition, sellerText);
  const meetingProgress = meetingSignals.turnSignal || meetingSignals.finalSignal;
  const failureFlags = buildHintFailureFlags({
    riskFlags: transition?.risk_flags || [],
    replyOutcome,
    turnDeltas,
  });
  const finalNormalizedScore = computeHintNormalizedScore({
    turnDeltas,
    meetingProgress,
    replyOutcome,
    failureFlags,
  });
  return {
    turnDeltas,
    meetingProgress,
    failureFlags,
    finalNormalizedScore,
    label: classifyHintOutcome(finalNormalizedScore, failureFlags, meetingProgress, false),
  };
}

function summarizeHintMemoryRecord(record) {
  return {
    id: record.id,
    outcome_label: record.outcome_label,
    seller_turn_index: record.seller_turn_index,
    turn_stage: record.turn_stage,
    active_concern: record.active_concern,
    signal_type: record.signal_type,
    generated_hint: record.generated_hint,
    hint_text: record.hint_text,
    buyer_state_before: record.buyer_state_before,
    buyer_state_deltas: record.buyer_state_deltas,
    buyer_state_after: record.buyer_state_after,
    turn_deltas: record.turn_deltas,
    buyer_metrics_after: record.buyer_metrics_after,
    meeting_progress: record.meeting_progress,
    final_meeting_signal: record.final_meeting_signal,
    failure_flags: record.failure_flags,
    negative_flags: record.negative_flags || [],
    pattern_profile: record.pattern_profile || null,
    notes: record.notes,
    risk_flags: record.risk_flags,
    final_normalized_score: record.final_normalized_score,
    score: memoryRecordScore(record),
  };
}

function buildHintRetrievalContext(session, lang = null) {
  const policy = getHintPolicyContext(session);
  const persona = personaMeta(session) || {};
  const sellerTurnIndex = sellerMessages(session).length + 1;
  return {
    persona_id: session.bot_id,
    persona_archetype: persona.archetype || '',
    dialogue_type: normalizeDialogueType(session.dialogue_type),
    seller_turn_index: sellerTurnIndex,
    turn_stage: hintTurnStage(session),
    hint_stage: policy.hintStage,
    ask_allowed_at_hint_time: policy.askAllowed,
    repair_state_bool: policy.repairState,
    bridge_step_type: policy.hintStage === 'bridge_step' || policy.hintStage === 'direct_ask' ? policy.askType : null,
    active_concern: getActiveConcern(session),
    signal_type: session?.sde_card?.signal_type || null,
    hint_language: lang === 'ru' ? 'ru' : 'en',
    buyer_state: buyerStateSnapshot(session?.buyer_state || buildInitialBuyerState(session)),
    buyer_metrics: {
      reply_likelihood: Number(session?.buyer_state?.reply_likelihood || 0),
      next_step_likelihood: Number(session?.buyer_state?.next_step_likelihood || 0),
      disengagement_risk: Number(session?.buyer_state?.disengagement_risk || 0),
    }
  };
}

function memoryRecordScore(record, context = null, totalRetrievals = 0) {
  const effectScore = Number(record?.final_normalized_score || record?.effect_score || 0) * 100;

  let ucbBonus = 0;
  if (UCB_C > 0 && totalRetrievals >= 1) {
    const recordRetrievals = Math.max(1, record.retrieval_count || 0);
    ucbBonus = UCB_C * Math.sqrt(Math.log(totalRetrievals) / recordRetrievals);
  }

  if (!context) return effectScore + ucbBonus;

  let relevance = 0;
  if (record.persona_id === context.persona_id) relevance += 40;
  else if (record.persona_archetype && record.persona_archetype === context.persona_archetype) relevance += 14;
  if (record.dialogue_type === context.dialogue_type) relevance += 12;
  if (record.turn_stage === context.turn_stage) relevance += 10;
  if (record.signal_type && record.signal_type === context.signal_type) relevance += 10;
  if (record.active_concern && context.active_concern && record.active_concern === context.active_concern) relevance += 16;
  if (!record.active_concern && !context.active_concern) relevance += 4;
  if (record.was_used) relevance += 6;
  return effectScore + relevance + ucbBonus;
}

function computeHintEffectScore(record) {
  return computeHintNormalizedScore({
    turnDeltas: record?.turn_deltas || {
      buyer_state: record?.buyer_state_deltas || {},
      buyer_metrics: {},
    },
    meetingProgress: record?.meeting_progress,
    replyOutcome: record?.buyer_reply_outcome || null,
    failureFlags: record?.failure_flags || record?.risk_flags || [],
  });
}

function retrieveRelevantHintMemories(session, lang = null) {
  const context = buildHintRetrievalContext(session, lang);
  const allRecords = loadHintMemoryStore();
  const totalRetrievals = Math.max(1, allRecords.reduce((sum, r) => sum + (r.retrieval_count || 0), 0));
  const ranked = allRecords
    .filter((record) => record.was_used && record.session_id !== session.session_id && record.outcome_label !== 'pending')
    .map((record) => ({ record, score: memoryRecordScore(record, context, totalRetrievals) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, HINT_MEMORY_RETRIEVAL_WINDOW);

  const successful = ranked
    .filter((item) => item.record.final_normalized_score >= 0.15 || item.record.meeting_progress)
    .slice(0, HINT_MEMORY_MAX_SUCCESS)
    .map((item) => ({ ...summarizeHintMemoryRecord(item.record), score: item.score }));

  const unsuccessful = ranked
    .filter((item) => item.record.final_normalized_score <= -0.12 || ['weak', 'failed'].includes(item.record.outcome_label))
    .slice(0, HINT_MEMORY_MAX_FAILURE)
    .map((item) => ({ ...summarizeHintMemoryRecord(item.record), score: item.score }));

  const avoidPatternCounts = new Map();
  for (const item of unsuccessful) {
    for (const flag of item.negative_flags || []) {
      avoidPatternCounts.set(flag, (avoidPatternCounts.get(flag) || 0) + 1);
    }
  }
  const avoid_patterns = [...avoidPatternCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([flag, count]) => ({ flag, count }));

  // Aggregate pattern_profile scores across successful vs unsuccessful windows
  // to rank which structural dimensions separate good hints from bad ones.
  const PROFILE_KEYS = ['specificity', 'proof', 'scope_clarity', 'compliance_safety',
    'next_step_ask', 'pressure_level', 'personalization_depth'];

  function aggregateProfiles(items) {
    if (!items.length) return null;
    const sums = Object.fromEntries(PROFILE_KEYS.map((k) => [k, 0]));
    let count = 0;
    for (const item of items) {
      const pp = item.pattern_profile;
      if (!pp) continue;
      for (const k of PROFILE_KEYS) sums[k] += Number(pp[k] ?? 0);
      count++;
    }
    if (!count) return null;
    return Object.fromEntries(PROFILE_KEYS.map((k) => [k, Number((sums[k] / count).toFixed(3))]));
  }

  const successfulProfiles = aggregateProfiles(successful);
  const unsuccessfulProfiles = aggregateProfiles(unsuccessful);

  // winning_patterns: dimensions where successful hints score significantly higher
  // bad_patterns: dimensions where unsuccessful hints score higher (incl. pressure_level)
  const winning_patterns = [];
  const bad_patterns = [];
  if (successfulProfiles && unsuccessfulProfiles) {
    for (const k of PROFILE_KEYS) {
      const diff = successfulProfiles[k] - unsuccessfulProfiles[k];
      if (diff >= 0.15) winning_patterns.push({ dimension: k, avg_score: successfulProfiles[k], delta: Number(diff.toFixed(3)) });
      if (diff <= -0.15) bad_patterns.push({ dimension: k, avg_score: unsuccessfulProfiles[k], delta: Number(Math.abs(diff).toFixed(3)) });
    }
    // pressure_level is inherently a bad pattern when elevated, regardless of delta
    if (unsuccessfulProfiles.pressure_level >= 0.4
      && !bad_patterns.find((p) => p.dimension === 'pressure_level')) {
      bad_patterns.push({ dimension: 'pressure_level', avg_score: unsuccessfulProfiles.pressure_level, delta: 0 });
    }
    winning_patterns.sort((a, b) => b.delta - a.delta);
    bad_patterns.sort((a, b) => b.delta - a.delta);
  }

  // Increment retrieval_count on selected records for UCB tracking
  const selectedIds = new Set([
    ...successful.map((r) => r.id),
    ...unsuccessful.map((r) => r.id),
  ]);
  if (selectedIds.size > 0) {
    const storeRecords = loadHintMemoryStore();
    let changed = false;
    for (const r of storeRecords) {
      if (selectedIds.has(r.id)) {
        r.retrieval_count = (r.retrieval_count || 0) + 1;
        changed = true;
      }
    }
    if (changed) saveHintMemoryStore(storeRecords);
  }

  return {
    context,
    successful,
    unsuccessful,
    avoid_patterns,
    winning_patterns,
    bad_patterns,
    pattern_profiles: {
      successful: successfulProfiles,
      unsuccessful: unsuccessfulProfiles,
    },
    counts: {
      total_records: ranked.length,
      successful: successful.length,
      unsuccessful: unsuccessful.length,
    }
  };
}

// Build a named contrastive block from a retrieval snapshot.
// This is the "generation context" for Step 5: copy_from (3 best successful),
// avoid (2 worst unsuccessful), winning_patterns, avoid_patterns.
function buildContrastiveRetrievalBlock(snapshot) {
  return {
    copy_from: snapshot.successful.map((r) => ({
      id: r.id,
      hint_text: r.hint_text || r.generated_hint || '',
      outcome_label: r.outcome_label,
      final_normalized_score: r.final_normalized_score,
      patterns: r.patterns || [],
      meeting_progress: r.meeting_progress || false,
    })),
    avoid: snapshot.unsuccessful.map((r) => ({
      id: r.id,
      hint_text: r.hint_text || r.generated_hint || '',
      outcome_label: r.outcome_label,
      final_normalized_score: r.final_normalized_score,
      negative_flags: r.negative_flags || [],
    })),
    winning_patterns: snapshot.winning_patterns,
    avoid_patterns: snapshot.avoid_patterns,
    counts: snapshot.counts,
  };
}

function buildHintMemorySnapshot(session, lang = null) {
  const snapshot = retrieveRelevantHintMemories(session, lang);
  return { ...snapshot, contrastive: buildContrastiveRetrievalBlock(snapshot) };
}

function memoryScoreCandidate(text, records = [], direction = 1) {
  const patterns = hintPatterns(text);
  const words = new Set(normalizeHintText(text).split(' ').filter((word) => word.length >= 4));
  let score = 0;
  for (const record of records) {
    const recordPatterns = Array.isArray(record?.patterns) ? record.patterns : hintPatterns(record?.generated_hint || '');
    const overlap = recordPatterns.filter((pattern) => patterns.includes(pattern)).length;
    score += overlap * 4 * direction;
    const recordWords = new Set(normalizeHintText(record?.generated_hint || '').split(' ').filter((word) => word.length >= 4));
    let wordOverlap = 0;
    for (const word of words) {
      if (recordWords.has(word)) wordOverlap += 1;
    }
    score += Math.min(wordOverlap, 6) * direction;
    if (record?.meeting_progress) score += 3 * direction;
  }
  return score;
}

function chooseMemoryInformedCandidate(session, candidates = [], fallback = '', snapshot = null) {
  const cleaned = candidates.map((candidate) => String(candidate || '').trim()).filter(Boolean);
  if (!cleaned.length) return fallback;
  const mem = snapshot || buildHintMemorySnapshot(session);
  const ranked = cleaned.map((candidate) => ({
    candidate,
    score: memoryScoreCandidate(candidate, mem.successful, 1)
      + memoryScoreCandidate(candidate, mem.unsuccessful, -1),
  })).sort((a, b) => b.score - a.score);
  return ranked[0]?.candidate || fallback || cleaned[0];
}

// snapshot may be passed in from the caller to avoid a duplicate retrieval when
// the same snapshot was already built for generation (Step 5: contrastive retrieval).
// explorationStrategy (Step 7): 'exploit' | 'adjacent' | 'explore' — stored for analytics.
function createHintMemoryAttempt(session, suggestion, lang = null, source = 'hint', snapshot = null, explorationStrategy = null) {
  const retrieval = snapshot || buildHintMemorySnapshot(session, lang);
  const persona = personaMeta(session) || {};
  const record = normalizeHintMemoryRecord({
    id: randomId('hintmem'),
    version: HINT_MEMORY_VERSION,
    created_at: now(),
    session_id: session.session_id,
    persona_id: session.bot_id,
    persona_archetype: persona.archetype || '',
    dialogue_type: session.dialogue_type,
    seller_turn_index: sellerMessages(session).length + 1,
    turn_stage: retrieval.context.turn_stage,
    hint_stage: retrieval.context.hint_stage,
    ask_allowed_at_hint_time: retrieval.context.ask_allowed_at_hint_time,
    repair_state_bool: retrieval.context.repair_state_bool,
    bridge_step_type: retrieval.context.bridge_step_type,
    active_concern: retrieval.context.active_concern,
    signal_type: retrieval.context.signal_type,
    seller_message_context: sellerMessages(session).length === 0
      ? (session?.sde_card?.rendered_text || '')
      : (botMessages(session).slice(-1)[0] || session?.sde_card?.rendered_text || ''),
    generated_hint: suggestion,
    hint_text: suggestion,
    was_used: source === 'auto',
    source,
    hint_language: retrieval.context.hint_language,
    buyer_state_before: retrieval.context.buyer_state,
    buyer_metrics_before: retrieval.context.buyer_metrics,
    retrieval_context: {
      successful: retrieval.successful.map((r) => r.id),
      unsuccessful: retrieval.unsuccessful.map((r) => r.id),
      contrastive: retrieval.contrastive,
      counts: retrieval.counts,
      context: retrieval.context,
    },
    patterns: hintPatterns(suggestion),
    outcome_label: source === 'auto' ? 'neutral' : 'pending',
    exploration_strategy: explorationStrategy || null,
    hint_variant: getHintVariant(session, retrieval.context.hint_stage || 'proof'),
    hint_schema: computeHintSchema(session),
    mixed_mode_violation: validateMixedMode(suggestion, retrieval.context.hint_stage || 'proof').violation || null,
  });
  const records = loadHintMemoryStore();
  records.push(record);
  saveHintMemoryStore(records);
  return { record, retrieval };
}

function findHintMemoryAttempt(session, hintId = null, sellerText = '') {
  const normalizedText = normalizeHintText(sellerText);
  const records = loadHintMemoryStore();
  if (hintId) {
    const byId = records.find((record) => record.id === hintId && record.session_id === session.session_id);
    if (byId) return byId;
  }
  return [...records].reverse().find((record) => (
    record.session_id === session.session_id
    && !record.was_used
    && normalizeHintText(record.generated_hint) === normalizedText
  )) || null;
}

function updateHintMemoryAttempt(session, sellerEntry, hintId = null) {
  const record = findHintMemoryAttempt(session, hintId, sellerEntry?.text || '');
  if (!record) return null;
  const records = loadHintMemoryStore();
  const index = records.findIndex((entry) => entry.id === record.id);
  if (index === -1) return null;

  const transition = sellerEntry?.buyer_state_transition || {};
  const assessment = assessHintEffect(
    transition,
    session,
    sellerEntry?.buyer_reply_outcome || null,
    sellerEntry?.text || record.generated_hint
  );
  const meetingSignals = meetingProgressSignals(session, transition, sellerEntry?.text || record.generated_hint);
  const acceptedNextStepType = sellerEntry?.buyer_reply_outcome === 'replied' && detectMeetingAskText(sellerEntry?.text || record.generated_hint)
    ? ((sellerEntry?.ask_type === 'premature_ask') ? null : (sellerEntry?.bridge_step_type || 'direct_call'))
    : null;
  records[index] = normalizeHintMemoryRecord({
    ...record,
    was_used: true,
    used_at: now(),
    used_hint_text: sellerEntry?.text || record.generated_hint,
    hint_text: sellerEntry?.text || record.generated_hint,
    seller_turn_index: transition.turn_index || record.seller_turn_index,
    buyer_state_before: transition.state_before || record.buyer_state_before || {},
    buyer_state_deltas: transition.predicted_delta || {},
    buyer_state_after: transition.state_after || {},
    buyer_metrics_before: transition.derived_metrics_before || record.buyer_metrics_before || {},
    buyer_metrics_after: transition.derived_metrics_after || {},
    buyer_reply_outcome: sellerEntry?.buyer_reply_outcome || null,
    hint_stage: sellerEntry?.hint_stage || record.hint_stage || record.context?.hint_stage,
    ask_allowed_at_hint_time: sellerEntry?.ask_allowed_at_hint_time === true,
    repair_state_bool: sellerEntry?.repair_state_bool === true,
    bridge_step_type: sellerEntry?.bridge_step_type || record.bridge_step_type || null,
    accepted_next_step_type: acceptedNextStepType,
    premature_ask_bool: sellerEntry?.premature_ask_bool === true,
    outcome_label: assessment.label,
    meeting_progress: meetingSignals.turnSignal,
    final_meeting_signal: meetingSignals.finalSignal,
    notes: [...(transition.explanation || []), ...(transition.coaching_notes || [])].join(' ').trim(),
    risk_flags: transition.risk_flags || [],
    failure_flags: assessment.failureFlags,
    coaching_notes: transition.coaching_notes || [],
    patterns: hintPatterns(sellerEntry?.text || record.generated_hint),
    turn_deltas: assessment.turnDeltas,
    buyer_progress_delta: {
      trust: Number(assessment.turnDeltas?.buyer_state?.trust || 0),
      clarity: Number(assessment.turnDeltas?.buyer_state?.clarity || 0),
      next_step_likelihood: Number(assessment.turnDeltas?.buyer_metrics?.next_step_likelihood || 0),
    },
    final_normalized_score: assessment.finalNormalizedScore,
  });
  saveHintMemoryStore(records);
  return records[index];
}

function appendSessionHintMemory(session) {
  const records = loadHintMemoryStore();
  const sellerEntries = (session?.transcript || []).filter((entry) => entry.role === 'seller');

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.session_id !== session.session_id) continue;
    const sellerEntry = sellerEntries.find((entry) => entry.hint_memory_id === record.id)
      || sellerEntries.find((entry) => normalizeHintText(entry.text) === normalizeHintText(record.generated_hint));
    const transition = sellerEntry?.buyer_state_transition || {};
    const assessment = assessHintEffect(
      transition,
      session,
      sellerEntry?.buyer_reply_outcome || null,
      sellerEntry?.text || record.used_hint_text || record.generated_hint
    );
    const meetingSignals = meetingProgressSignals(
      session,
      transition,
      sellerEntry?.text || record.used_hint_text || record.generated_hint
    );
    records[index] = normalizeHintMemoryRecord({
      ...record,
      was_used: record.was_used || Boolean(sellerEntry),
      used_at: record.used_at || (sellerEntry ? (sellerEntry.ts || now()) : null),
      used_hint_text: sellerEntry?.text || record.used_hint_text || record.generated_hint,
      hint_text: sellerEntry?.text || record.used_hint_text || record.generated_hint,
      buyer_state_before: Object.keys(record.buyer_state_before || {}).length ? record.buyer_state_before : (transition.state_before || {}),
      buyer_state_deltas: Object.keys(record.buyer_state_deltas || {}).length ? record.buyer_state_deltas : (transition.predicted_delta || {}),
      buyer_state_after: Object.keys(record.buyer_state_after || {}).length ? record.buyer_state_after : (transition.state_after || {}),
      buyer_metrics_before: Object.keys(record.buyer_metrics_before || {}).length ? record.buyer_metrics_before : (transition.derived_metrics_before || {}),
      buyer_metrics_after: Object.keys(record.buyer_metrics_after || {}).length ? record.buyer_metrics_after : (transition.derived_metrics_after || {}),
      buyer_reply_outcome: record.buyer_reply_outcome || sellerEntry?.buyer_reply_outcome || null,
      outcome_label: sellerEntry ? assessment.label : record.outcome_label,
      meeting_progress: record.meeting_progress || meetingSignals.turnSignal,
      final_meeting_signal: meetingSignals.finalSignal,
      final_verdict: session?.assessment?.verdict || record.final_verdict,
      assessment_id: session?.assessment_id || record.assessment_id,
      notes: sellerEntry
        ? [...(transition.explanation || []), ...(transition.coaching_notes || [])].join(' ').trim()
        : record.notes,
      risk_flags: sellerEntry ? (transition.risk_flags || []) : record.risk_flags,
      failure_flags: sellerEntry ? assessment.failureFlags : record.failure_flags,
      coaching_notes: sellerEntry ? (transition.coaching_notes || []) : record.coaching_notes,
      patterns: hintPatterns(sellerEntry?.text || record.used_hint_text || record.generated_hint),
      turn_deltas: sellerEntry ? assessment.turnDeltas : record.turn_deltas,
      final_normalized_score: sellerEntry ? assessment.finalNormalizedScore : record.final_normalized_score,
    });
  }

  saveHintMemoryStore(records);
}

function buildHintMemorySummary(personaId = null) {
  const records = loadHintMemoryStore()
    .filter((record) => !personaId || record.persona_id === personaId)
    .filter((record) => record.was_used);
  const counts = {
    total: records.length,
    meeting_progress: records.filter((record) => record.outcome_label === 'meeting_progress').length,
    positive: records.filter((record) => record.outcome_label === 'positive').length,
    neutral: records.filter((record) => record.outcome_label === 'neutral').length,
    weak: records.filter((record) => record.outcome_label === 'weak').length,
    failed: records.filter((record) => record.outcome_label === 'failed').length,
  };
  const patternScores = new Map();
  for (const record of records) {
    const weight = Number(record.final_normalized_score || 0);
    for (const pattern of record.patterns || []) {
      const current = patternScores.get(pattern) || 0;
      patternScores.set(pattern, current + weight);
    }
  }
  const rankedPatterns = [...patternScores.entries()]
    .map(([pattern, score]) => ({ pattern, score }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  return {
    persona_id: personaId || null,
    counts,
    helpful_patterns: rankedPatterns.filter((entry) => entry.score > 0).slice(0, 5),
    harmful_patterns: rankedPatterns.filter((entry) => entry.score < 0).slice(0, 5),
    recent_records: [...records]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 8)
      .map(summarizeHintMemoryRecord),
  };
}

function logFinishedRun(session) {
  if (storage.saveFinishedLog) {
    Promise.resolve(storage.saveFinishedLog(session)).catch((err) => {
      console.error('[logs] save error:', err?.message || err);
    });
  }
}

function buildSessionArtifact(session) {
  try {
    const sid = session.session_id;
    const a = session.assessment || {};
    const sde = session.sde_card || {};

    const artifact = {
      artifact_version: 'v1',
      session_id: sid,
      saved_at: now(),
      started_at: session.started_at || null,
      finished_at: session.finished_at || null,
      seller_username: session.seller_username || session.seller_id || '',
      persona: {
        id: session.bot_id || '',
        name: session.bot_name || ''
      },
      signal_card: {
        id: session.sde_card_id || '',
        signal_type: sde.signal_type || '',
        heat: sde.heat || '',
        company_name: sde.company_name || '',
        contact_name: sde.contact_name || '',
        pain_summary: sde.pain_summary || ''
      },
      dialogue_type: session.dialogue_type || 'messenger',
      language: session.language || 'ru',
      assessment: {
        verdict: a.verdict || null,
        verdict_label: a.verdict_label || null,
        summary_for_seller: a.summary_for_seller || null,
        criteria: a.criteria || []
      },
      transcript: (session.transcript || []).map((m) => ({
        role: m.role,
        text: m.text,
        ts: m.ts || null
      }))
    };

    const criteriaLines = (a.criteria || []).map((c) =>
      `- ${c.id}. ${c.label || c.name || c.id}: ${c.status}${c.short_reason ? ` — ${c.short_reason}` : ''}`
    ).join('\n');

    const transcriptLines = (session.transcript || [])
      .filter((m) => m.role !== 'system')
      .map((m) => `[${m.role === 'seller' ? 'Seller' : (session.bot_name || 'Bot')}] ${m.text}`)
      .join('\n\n');

    const md = [
      `# Sales Simulator — ${session.bot_name || sid}`,
      '',
      `Session: ${sid}`,
      `Saved at: ${artifact.saved_at}`,
      `Started: ${artifact.started_at || '—'}`,
      `Finished: ${artifact.finished_at || '—'}`,
      `Seller: ${artifact.seller_username || '—'}`,
      `Persona: ${artifact.persona.name} (${artifact.persona.id})`,
      `Signal card: ${artifact.signal_card.id} | ${artifact.signal_card.signal_type} | Heat: ${artifact.signal_card.heat}`,
      artifact.signal_card.company_name ? `Company: ${artifact.signal_card.company_name}` : '',
      artifact.signal_card.contact_name ? `Contact: ${artifact.signal_card.contact_name}` : '',
      artifact.signal_card.pain_summary ? `Pain: ${artifact.signal_card.pain_summary}` : '',
      `Dialogue type: ${artifact.dialogue_type}`,
      `Language: ${artifact.language}`,
      '',
      `## Verdict: ${a.verdict || '—'}`,
      a.verdict_label ? `*${a.verdict_label}*` : '',
      '',
      a.summary_for_seller ? `## Summary\n\n${a.summary_for_seller}` : '',
      '',
      criteriaLines ? `## Criteria\n\n${criteriaLines}` : '',
      '',
      '## Transcript',
      '',
      transcriptLines
    ].filter((line) => line !== undefined && line !== false).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();

    return { artifact, markdown: md, sessionId: sid };
  } catch (err) {
    console.error(`[artifacts] Failed to build artifact for session ${session.session_id}:`, err.message);
    return null;
  }
}

function saveArtifact(session) {
  const payload = buildSessionArtifact(session);
  if (!payload) return;
  if (storage.saveArtifact) {
    Promise.resolve(storage.saveArtifact(payload)).catch((err) => {
      console.error(`[artifacts] Failed to save artifact for session ${session.session_id}:`, err?.message || err);
    });
  }
}

async function loadSession(sessionId) {
  const session = await storage.loadSession(sessionId);
  if (!session) return null;
  return ensureBuyerStateSessionFields(session);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

const signalVariantPresets = {
  COMPLIANCE_PRESSURE: [
    {
      what: 'Во время internal finance review всплыли два зависших contractor payout и слишком длинная ручная сверка по документам.',
      pain: 'Финансовый риск и ручной разбор исключений перед review.',
      render: 'Сигнал: finance review вскрыл зависшие contractor payout и длинную ручную сверку документов. Разговор должен идти через контроль, explainability и снятие ручного слоя.'
    },
    {
      what: 'Новый controller эскалировал разрыв между payout-операциями и тем, что команда может быстро объяснить legal и leadership.',
      pain: 'Слабая explainability схемы и растущая нагрузка на finance.',
      render: 'Сигнал: новый controller увидел слабую explainability contractor flow и эскалировал вопрос до leadership. Контекст лучше открывать через control gap, а не общий fintech pitch.'
    },
    {
      what: 'Перед внешним review finance команда обнаружила старые исключения по подрядчикам и слишком много ручных обходных маршрутов.',
      pain: 'Серые зоны в payout flow и потеря контроля над исключениями.',
      render: 'Сигнал: перед внешним review вскрылись старые исключения и ручные обходные маршруты. Нужен разговор про audit trail, контроль и границы ответственности.'
    }
  ],
  PAIN_SIGNAL: [
    {
      what: 'Ops устал собирать статусы выплат по подрядчикам из чатов, почты и личных напоминаний.',
      pain: 'Потеря скорости команды и постоянные ручные follow-ups.',
      render: 'Сигнал: распределённая contractor-команда растёт, а ops уже тонет в статусах и ручных follow-ups. Заход должен быть коротким и operational-first.'
    },
    {
      what: 'Founder получил жалобы от team leads, что выплаты подрядчикам снова приходится разруливать вручную через несколько инструментов.',
      pain: 'Бардак в execution-слое и потеря времени ключевых людей.',
      render: 'Сигнал: team leads жалуются на ручное разруливание выплат через несколько инструментов. Контекст держится на speed, predictability и снятии хаоса.'
    },
    {
      what: 'После нового hiring wave менеджеры начали эскалировать непредсказуемость payout-statuses по новым подрядчикам.',
      pain: 'Слабая predictability и лишняя координация внутри команды.',
      render: 'Сигнал: после hiring wave всплыла непредсказуемость payout-statuses. Открывать разговор стоит через predictability и экономию времени, не через страх.'
    }
  ],
  FUNDRAISING_DILIGENCE: [
    {
      what: 'После разговора с lead investor finance получила задачу быстро собрать explainable contractor flow до следующего board update.',
      pain: 'Investor scrutiny усиливает pressure на control и explainability.',
      render: 'Сигнал: investor pressure ускорил разбор contractor flow. Разговор должен идти через readiness к diligence, а не через общий compliance pitch.'
    },
    {
      what: 'Board попросил CFO показать, как текущая contractor scheme будет выглядеть под будущим diligence через 6-8 месяцев.',
      pain: 'Сейчас нет истории, которую можно уверенно показать на следующем раунде.',
      render: 'Сигнал: board просит заранее подготовить contractor story к будущему diligence. Хороший заход идёт через explainability и control, не через страх.'
    }
  ],
  TEAM_SCALING: [
    {
      what: 'После очередной hiring wave engineering manager снова стал ручным эскалационным слоем между contractors, ops и finance.',
      pain: 'Champion теряет время на firefighting вместо команды и delivery.',
      render: 'Сигнал: engineering manager устал быть мостом между contractors и finance. Открывать разговор лучше через снятие эскалаций и internal champion case.'
    },
    {
      what: 'Новые external engineers начали чаще спрашивать про payout status, и engineering manager снова оказался в чужой операционной проблеме.',
      pain: 'Команда отвлекается, а manager тратит доверие на не свою функцию.',
      render: 'Сигнал: рост команды вытолкнул engineering manager в ops-firefighting. Лучший заход, это operational relief и stronger internal story.'
    }
  ],
  OPERATIONS_OVERLOAD: [
    {
      what: 'Ops держит payout statuses в таблицах и чатах, а еженедельные follow-ups уже превратились в отдельный ритуал.',
      pain: 'Слишком много ручной координации, мало predictability.',
      render: 'Сигнал: ops живёт между таблицами, чатами и ручными follow-ups по выплатам. Разговор лучше открывать через predictability и removal of manual status work.'
    },
    {
      what: 'После роста contractor team ops стала bottleneck для статусов и эскалаций по выплатам.',
      pain: 'Процесс больше не масштабируется руками.',
      render: 'Сигнал: рост contractor-команды превратил ops в bottleneck для payouts. Рабочий заход, это конкретный process upgrade, а не большой pitch.'
    }
  ],
  FINANCE_CONTROL_GAP: [
    {
      what: 'Finance попросили за один день собрать полную картину contractor payments, а данные оказались размазаны по нескольким источникам.',
      pain: 'Слабый контроль и тяжёлая explainability перед leadership.',
      render: 'Сигнал: finance не может быстро собрать explainable picture по contractor payments. Разговор стоит держать на control, auditability и less manual reconciliation.'
    },
    {
      what: 'Перед annual audit finance снова вручную склеивает contractor docs, payout statuses и ответы для leadership.',
      pain: 'Ручной reporting ломает доверие к процессу и забирает время команды.',
      render: 'Сигнал: annual audit снова вскрыл ручной reporting по contractor flow. Лучший заход, это explainability вверх и сокращение ручной сверки вниз.'
    }
  ],
  LEGAL_REVIEW_TRIGGER: [
    {
      what: 'Internal legal увидел серые зоны между тем, как оформлены contractors, и тем, как реально идёт payout flow.',
      pain: 'Слишком много grey zones и трудно защищаемых исключений.',
      render: 'Сигнал: legal review вскрыл серые зоны между документами и payment flow. Открывать разговор лучше через boundaries, audit trail и no overclaiming.'
    },
    {
      what: 'При обновлении contractor templates legal поняла, что текущий payout process уже плохо бьётся с документами и исключениями.',
      pain: 'Consistency между документами и процессом расползается.',
      render: 'Сигнал: legal пересобирает contractor templates и упирается в inconsistent payout flow. Лучший заход, это process discipline и explainable scope.'
    }
  ],
  OUTSIDE_COUNSEL_CHECK: [
    {
      what: 'Внешний counsel быстро нашёл слабую traceability между intermediaries, документами и реальным contractor flow.',
      pain: 'Недостаточная defensibility перед внешним review.',
      render: 'Сигнал: external counsel увидел слабую traceability и много ручных слоёв в contractor flow. Разговор должен держаться на defensibility, scope boundary и evidence.'
    },
    {
      what: 'Во время короткого outside counsel review всплыло, что текущая схема плохо объясняется без длинной устной расшифровки.',
      pain: 'Схема слабо защищается без ручного контекста и устных пояснений.',
      render: 'Сигнал: outside counsel review показал слабую explainability contractor scheme без ручных пояснений. Лучший заход, это exact scope, safeguards and audit trail.'
    }
  ]
};

const signalHintVariants = [
  'Открой через конкретный рабочий сигнал, не через общий pitch.',
  'Начни с observed context и быстро приземли разговор в механику.',
  'Сделай первый заход точным и коротким, без шаблонной подводки.'
];

const outreachWindowVariants = ['48 часов', '72 часа', '5 дней', '7 дней', '10 дней', '14 дней'];

function chooseRandom(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function buildSignalVariant(baseCard, randomizerConfig = null) {
  const variability = randomizerConfig?.variability || 'medium';
  const card = clone(baseCard);

  // 'off' means no randomization — return base card as-is
  if (variability === 'off') return card;

  // 'low' — only randomize hint and outreach window, keep core signal data
  if (variability === 'low') {
    return {
      ...card,
      first_touch_hint: chooseRandom([card.first_touch_hint, ...signalHintVariants].filter(Boolean)) || card.first_touch_hint,
      outreach_window: chooseRandom([card.outreach_window, ...outreachWindowVariants].filter(Boolean)) || card.outreach_window
    };
  }

  // 'medium' (default) and 'high' — full variant replacement
  const variantPool = signalVariantPresets[baseCard.signal_type] || [];
  const variant = chooseRandom(variantPool);
  if (!variant) return card;
  return {
    ...card,
    what_happened: variant.what || card.what_happened,
    probable_pain: variant.pain || card.probable_pain,
    rendered_text: variant.render || card.rendered_text,
    first_touch_hint: chooseRandom([card.first_touch_hint, ...signalHintVariants].filter(Boolean)) || card.first_touch_hint,
    outreach_window: chooseRandom([card.outreach_window, ...outreachWindowVariants].filter(Boolean)) || card.outreach_window
  };
}

function pickCard(personaId, randomizerConfig = null) {
  const persona = personas[personaId];
  let cards = persona?.cards || [];

  // Filter to allowed signal types if configured
  if (Array.isArray(randomizerConfig?.signal_types) && randomizerConfig.signal_types.length) {
    const allowed = new Set(randomizerConfig.signal_types.flatMap(signalTypeVariants));
    const filtered = cards.filter((c) => signalTypeVariants(c.signal_type).some((variant) => allowed.has(variant)));
    if (filtered.length) cards = filtered;
  }

  const baseCard = chooseRandom(cards);
  return buildSignalVariant(baseCard || normalizeCard({}, personaId, 0), randomizerConfig);
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasAny(text, items) {
  const t = text.toLowerCase();
  return items.some((item) => t.includes(item));
}

function pick(options) {
  return options[Math.floor(Math.random() * options.length)];
}

const BUYER_STATE_DIMENSIONS = [
  'patience',
  'interest',
  'perceived_value',
  'conversation_capacity',
  'trust',
  'clarity',
];

const BUYER_STATE_LABELS = {
  patience: 'Patience',
  interest: 'Interest',
  perceived_value: 'Perceived value',
  conversation_capacity: 'Conversation capacity',
  trust: 'Trust',
  clarity: 'Clarity',
};

const BASE_BUYER_STATE_PRIORS = {
  default: {
    patience: 58,
    interest: 10,
    perceived_value: 8,
    conversation_capacity: 4,
    trust: 45,
    clarity: 18,
  },
  finance: {
    patience: 54,
    interest: 11,
    perceived_value: 9,
    conversation_capacity: 5,
    trust: 42,
    clarity: 20,
  },
  ops: {
    patience: 60,
    interest: 14,
    perceived_value: 12,
    conversation_capacity: 4,
    trust: 49,
    clarity: 16,
  },
  legal: {
    patience: 50,
    interest: 8,
    perceived_value: 7,
    conversation_capacity: 5,
    trust: 38,
    clarity: 24,
  },
};

const PERSONA_BUYER_STATE_PRIORS = {
  andrey: { patience: 50, interest: 9, perceived_value: 7, conversation_capacity: 5, trust: 36, clarity: 20 },
  alexey: { patience: 62, interest: 15, perceived_value: 11, conversation_capacity: 4, trust: 48, clarity: 16 },
  cfo_round: { patience: 53, interest: 12, perceived_value: 9, conversation_capacity: 5, trust: 40, clarity: 22 },
  eng_manager: { patience: 59, interest: 16, perceived_value: 13, conversation_capacity: 4, trust: 46, clarity: 17 },
  ops_manager: { patience: 57, interest: 15, perceived_value: 12, conversation_capacity: 4, trust: 48, clarity: 16 },
  head_finance: { patience: 55, interest: 12, perceived_value: 10, conversation_capacity: 5, trust: 43, clarity: 21 },
  internal_legal: { patience: 51, interest: 8, perceived_value: 7, conversation_capacity: 5, trust: 39, clarity: 26 },
  external_legal: { patience: 47, interest: 7, perceived_value: 6, conversation_capacity: 5, trust: 34, clarity: 28 },
  olga: { patience: 48, interest: 7, perceived_value: 6, conversation_capacity: 5, trust: 35, clarity: 29 },
};

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMetric(value) {
  return Math.round(Number(value) || 0);
}

function mergeBuyerState(base, override = {}) {
  return {
    patience: override.patience ?? base.patience,
    interest: override.interest ?? base.interest,
    perceived_value: override.perceived_value ?? base.perceived_value,
    conversation_capacity: override.conversation_capacity ?? base.conversation_capacity,
    trust: override.trust ?? base.trust,
    clarity: override.clarity ?? base.clarity,
  };
}

function conversationCapacityMax(session, seedState = null) {
  const persona = personaMeta(session) || {};
  const base = seedState?.capacity_max
    || session?.buyer_state?.capacity_max
    || PERSONA_BUYER_STATE_PRIORS[persona.id]?.conversation_capacity
    || BASE_BUYER_STATE_PRIORS[persona.archetype]?.conversation_capacity
    || BASE_BUYER_STATE_PRIORS.default.conversation_capacity;
  const emailBonus = normalizeDialogueType(session?.dialogue_type) === 'email' ? 1 : 0;
  return Math.max(2, roundMetric(base + emailBonus));
}

function deriveBuyerStateMetrics(state, capacityMax) {
  const capacityRatio = clampNumber((state.conversation_capacity || 0) / Math.max(capacityMax || 1, 1), 0, 1);
  const disengagementRaw = 0.38
    - (state.patience * 0.0024)
    - (state.trust * 0.0025)
    - (state.clarity * 0.0018)
    - (state.interest * 0.0014)
    - (capacityRatio * 0.18)
    + ((100 - state.perceived_value) * 0.0008);
  const disengagementRisk = clampNumber(disengagementRaw, 0.03, 0.98);
  const replyLikelihood = clampNumber(
    0.16
      + (state.patience * 0.0022)
      + (state.interest * 0.0033)
      + (state.trust * 0.0028)
      + (state.clarity * 0.0015)
      + (capacityRatio * 0.12)
      - (disengagementRisk * 0.35),
    0.03,
    0.99
  );
  const nextStepLikelihood = clampNumber(
    -0.08
      + (state.interest * 0.0036)
      + (state.perceived_value * 0.0039)
      + (state.trust * 0.0028)
      + (state.clarity * 0.0021)
      + (capacityRatio * 0.08),
    0.01,
    0.96
  );

  return {
    reply_likelihood: Number(replyLikelihood.toFixed(2)),
    next_step_likelihood: Number(nextStepLikelihood.toFixed(2)),
    disengagement_risk: Number(disengagementRisk.toFixed(2)),
  };
}

function normalizeBuyerState(state, session) {
  const capacityMax = conversationCapacityMax(session, state);
  const normalized = {
    patience: clampNumber(roundMetric(state?.patience), 0, 100),
    interest: clampNumber(roundMetric(state?.interest), 0, 100),
    perceived_value: clampNumber(roundMetric(state?.perceived_value), 0, 100),
    conversation_capacity: clampNumber(roundMetric(state?.conversation_capacity), 0, capacityMax),
    trust: clampNumber(roundMetric(state?.trust), 0, 100),
    clarity: clampNumber(roundMetric(state?.clarity), 0, 100),
    capacity_max: capacityMax,
  };
  return { ...normalized, ...deriveBuyerStateMetrics(normalized, capacityMax) };
}

function applyDifficultyTier(state, tier) {
  const t = Number(tier) || 1;
  if (t <= 1) return state;
  const multipliers = t === 2
    ? { patience: 0.80, trust: 0.85 }
    : { patience: 0.65, trust: 0.70 };
  return {
    ...state,
    patience: Math.round(state.patience * multipliers.patience),
    trust: Math.round(state.trust * multipliers.trust),
  };
}

function buildInitialBuyerState(session) {
  const persona = personaMeta(session) || {};
  const fromArchetype = BASE_BUYER_STATE_PRIORS[persona.archetype] || BASE_BUYER_STATE_PRIORS.default;
  const fromPersona = PERSONA_BUYER_STATE_PRIORS[persona.id] || {};
  const emailOffset = normalizeDialogueType(session?.dialogue_type) === 'email'
    ? { patience: 4, clarity: 4, conversation_capacity: 1 }
    : {};
  const baseState = normalizeBuyerState(
    mergeBuyerState(
      mergeBuyerState(mergeBuyerState(BASE_BUYER_STATE_PRIORS.default, fromArchetype), fromPersona),
      emailOffset
    ),
    session
  );
  return normalizeBuyerState(applyDifficultyTier(baseState, session?.difficulty_tier), session);
}

function buyerStateSnapshot(state) {
  return BUYER_STATE_DIMENSIONS.reduce((acc, key) => {
    acc[key] = roundMetric(state?.[key]);
    return acc;
  }, {});
}

function buyerStateTextHints(lang = 'en') {
  return lang === 'ru'
    ? {
        boundary: ['границ', 'ответствен', 'не бер', 'не снима', 'не обещ', 'зона', 'контрол'],
        mechanism: ['документ', 'kyc', 'audit', 'trail', 'flow', 'цепоч', 'sla', 'статус', 'сверк', 'выплат', 'инцидент', 'процесс'],
        proof: ['кейс', 'пример', 'цифр', 'час', 'день', 'недел', 'pilot', 'пилот', 'trial', 'референс', '20 минут', '15 минут'],
        vague: ['платформ', 'решени', 'инновацион', 'best-in-class', 'лидер рынка', 'масштаб', 'бесшовн'],
        nextStep: ['созвон', 'звон', '15 минут', '20 минут', 'материал', 'memo', 'walkthrough', 'review', 'follow-up', 'на неделе', 'завтра'],
      }
    : {
        boundary: ['boundary', 'scope', 'responsib', 'not taking', 'do not take', "don't take", "won't", 'limit', 'control'],
        mechanism: ['document', 'kyc', 'audit', 'trail', 'flow', 'payment chain', 'sla', 'status', 'reconcil', 'incident', 'process', 'payout'],
        proof: ['case', 'example', 'number', 'hour', 'day', 'week', 'pilot', 'trial', 'reference', '20 minute', '15 minute'],
        vague: ['platform', 'solution', 'innovative', 'best-in-class', 'market leader', 'seamless', 'scale without'],
        nextStep: ['call', 'meeting', '15 minute', '20 minute', 'material', 'memo', 'walkthrough', 'review', 'follow-up', 'this week', 'tomorrow'],
      };
}

function syncLegacyBehaviorState(session) {
  const buyerState = normalizeBuyerState(session?.buyer_state || buildInitialBuyerState(session), session);
  session.buyer_state = buyerState;
  const trustBand = 0.5 + (buyerState.trust / 40);
  const irritationBand = ((100 - buyerState.patience) + (100 - buyerState.clarity) + (buyerState.disengagement_risk * 100)) / 80;
  session.meta.trust = Number(clampNumber(trustBand, 0.5, 3).toFixed(2));
  session.meta.irritation = Number(clampNumber(irritationBand, 0, 3).toFixed(2));
}

function ensureBuyerStateSessionFields(session) {
  if (!session) return session;
  if (!session.meta || typeof session.meta !== 'object') session.meta = {};
  if (session.meta.trust === undefined) session.meta.trust = 1;
  if (session.meta.irritation === undefined) session.meta.irritation = 0;
  if (session.meta.miss_streak === undefined) session.meta.miss_streak = 0;
  if (!session.meta.concern_order) session.meta.concern_order = buildConcernOrder(session.bot_id);
  if (!session.meta.resolved_concerns) session.meta.resolved_concerns = {};
  if (!Array.isArray(session.transcript)) session.transcript = [];
  session.meta.buyer_state_version = 'v1';
  session.buyer_state = normalizeBuyerState(session.buyer_state || buildInitialBuyerState(session), session);
  syncLegacyBehaviorState(session);
  return session;
}

function applyBuyerStateDelta(before, delta, session) {
  return normalizeBuyerState({
    ...before,
    patience: before.patience + (delta.patience || 0),
    interest: before.interest + (delta.interest || 0),
    perceived_value: before.perceived_value + (delta.perceived_value || 0),
    conversation_capacity: before.conversation_capacity + (delta.conversation_capacity || 0),
    trust: before.trust + (delta.trust || 0),
    clarity: before.clarity + (delta.clarity || 0),
  }, session);
}

function evaluateBuyerStateDelta(session, sellerText) {
  const before = normalizeBuyerState(session.buyer_state || buildInitialBuyerState(session), session);
  const lower = sellerText.toLowerCase();
  const lang = session.language === 'ru' ? 'ru' : 'en';
  const turnIndex = sellerMessages(session).length;
  const persona = personaMeta(session) || {};
  const activeConcern = getActiveConcern(session);
  const hints = buyerStateTextHints(lang);
  const words = countWords(sellerText);
  const emailMode = isEmailMode(session);
  const longLimit = persona.archetype === 'ops' ? (emailMode ? 95 : 48) : (emailMode ? 120 : 72);
  const contextualOpening = turnIndex === 1 && hasAny(lower, firstContactMatchers(session.bot_id, lang));
  const concernAddressed = activeConcern
    ? (lang === 'ru' ? sellerAdvancesConcern(activeConcern, lower) : sellerAdvancesConcernEN(activeConcern, lower))
    : false;
  const hasBoundary = hasAny(lower, hints.boundary);
  const hasMechanism = hasAny(lower, hints.mechanism);
  const hasProof = hasAny(lower, hints.proof) || /\d/.test(lower);
  const hasQuestion = sellerText.includes('?');
  const hasNextStep = hasAny(lower, hints.nextStep);
  const hasVagueLanguage = hasAny(lower, hints.vague);
  const overclaim = isMisclassificationBlocker(sellerText);
  const tooLong = words > longLimit;
  const veryLong = words > longLimit + 25;

  const delta = {
    patience: -2,
    interest: 0,
    perceived_value: 0,
    conversation_capacity: -1,
    trust: 0,
    clarity: 0,
  };
  const explanation = [];
  const risk_flags = [];
  const coaching_notes = [];

  if (contextualOpening) {
    delta.interest += 7;
    delta.trust += 4;
    delta.clarity += 2;
    explanation.push('Opened from a real signal instead of a generic pitch.');
  } else if (turnIndex === 1) {
    delta.interest -= 5;
    delta.trust -= 3;
    delta.clarity -= 2;
    explanation.push('Opening felt generic and did not anchor to the active signal.');
    coaching_notes.push('Lead with a concrete signal from the card, not a general pitch.');
  }

  if (concernAddressed) {
    delta.interest += 6;
    delta.perceived_value += 5;
    delta.clarity += 5;
    delta.trust += 4;
    delta.patience += 1;
    explanation.push(`Message addressed the buyer's active concern: ${activeConcern}.`);
  } else if (activeConcern && turnIndex > 1) {
    delta.interest -= 4;
    delta.patience -= 3;
    delta.clarity -= 3;
    explanation.push(`Message missed the buyer's current concern: ${activeConcern}.`);
    coaching_notes.push('Answer the active concern before moving to a new angle.');
  }

  if (hasBoundary) {
    delta.trust += 5;
    delta.clarity += 4;
    explanation.push('Boundary language made scope feel more credible.');
  }

  if (hasMechanism) {
    delta.perceived_value += 4;
    delta.clarity += 4;
    explanation.push('Concrete mechanism increased perceived value and understanding.');
  }

  if (hasProof) {
    delta.trust += 4;
    delta.perceived_value += 5;
    explanation.push('Specific evidence or numbers made the message more believable.');
  }

  if (hasQuestion && (concernAddressed || contextualOpening || hasMechanism)) {
    delta.interest += 2;
    explanation.push('The prompt invited a practical response from the buyer.');
  }

  if (hasNextStep) {
    if (before.trust >= 45 && before.clarity >= 35 && before.interest >= 18) {
      delta.interest += 3;
      delta.perceived_value += 2;
      explanation.push('Next step landed at a workable moment in the conversation.');
    } else {
      delta.patience -= 3;
      delta.trust -= 2;
      delta.conversation_capacity -= 1;
      explanation.push('Next step came before enough trust or clarity was built.');
      coaching_notes.push('Earn the next step after scope, clarity, and value are established.');
    }
  }

  if (tooLong) {
    delta.patience -= persona.archetype === 'ops' ? 8 : 5;
    delta.clarity -= persona.archetype === 'ops' ? 6 : 4;
    delta.interest -= persona.archetype === 'ops' ? 4 : 2;
    explanation.push('Message length strained patience and reduced clarity.');
    coaching_notes.push(`Keep messages under roughly ${longLimit} words for this persona/channel.`);
  }

  if (veryLong) {
    delta.conversation_capacity -= 1;
  }

  if (hasVagueLanguage) {
    delta.trust -= 3;
    delta.clarity -= 4;
    explanation.push('Vague or marketing-heavy language reduced credibility.');
  }

  if (!hasMechanism && !hasBoundary && !hasProof) {
    delta.perceived_value -= 3;
    delta.clarity -= 3;
    explanation.push('Message stayed abstract, so the buyer saw little concrete value.');
    coaching_notes.push('Name the mechanism: documents, payment flow, audit trail, SLA, or operational change.');
  }

  if (overclaim) {
    delta.trust -= 18;
    delta.clarity -= 8;
    delta.patience -= 8;
    delta.conversation_capacity -= 1;
    risk_flags.push('overclaim_scope');
    explanation.push('Overclaiming on misclassification or responsibility sharply reduced trust.');
    coaching_notes.push('Do not promise that Mellow removes misclassification risk.');
  }

  if (before.conversation_capacity <= 2 && !hasNextStep && !concernAddressed) {
    delta.conversation_capacity -= 1;
    delta.patience -= 2;
    explanation.push('The buyer was already near cutoff, so a weak turn cost extra capacity.');
  }

  const after = applyBuyerStateDelta(before, delta, session);
  const beforeMetrics = hintMetricSnapshotFromBuyerState(before);
  const afterMetrics = hintMetricSnapshotFromBuyerState(after);

  if (after.trust <= 25) risk_flags.push('low_trust');
  if (after.clarity <= 30) risk_flags.push('low_clarity');
  if (after.conversation_capacity <= 1 || after.disengagement_risk >= 0.7) risk_flags.push('near_disengagement');

  return {
    turn_index: turnIndex,
    state_before: buyerStateSnapshot(before),
    predicted_delta: buyerStateSnapshot(delta),
    state_after: buyerStateSnapshot(after),
    derived_metrics_before: beforeMetrics,
    derived_metrics_after: afterMetrics,
    derived_metrics_delta: buildHintTurnDeltas({
      buyerStateBefore: buyerStateSnapshot(before),
      buyerStateAfter: buyerStateSnapshot(after),
      buyerMetricsBefore: beforeMetrics,
      buyerMetricsAfter: afterMetrics,
      fallbackBuyerStateDeltas: buyerStateSnapshot(delta),
    }).buyer_metrics,
    explanation: explanation.length ? explanation : ['Message produced a mostly neutral buyer-state shift.'],
    risk_flags,
    coaching_notes,
  };
}

function emailFirstReplyFallback(session) {
  const lang = session.language === 'ru' ? 'ru' : 'en';
  const persona = personaMeta(session) || {};
  if ((persona.archetype || '') === 'legal') {
    return lang === 'ru'
      ? pick([
          'Если идти дальше, мне сразу нужна ясность по границе ответственности. Что именно в зоне Mellow, а что остаётся на нашей стороне?',
          'Пока вижу потенциальную релевантность. Но первый вопрос простой: где у Mellow заканчивается зона контроля?',
        ])
      : pick([
          'If we continue, I need scope clarity first. What exactly sits within Mellow, and what stays on our side?',
        ]);
  }
  if ((persona.archetype || '') === 'ops') {
    return lang === 'ru'
      ? pick([
          'Если это правда релевантно, скажите конкретно: что именно уходит из ручной координации и кто owner, когда что-то ломается?',
          'Потенциально в тему. Но мне нужна механика, не общие слова: что именно меняется в процессе?',
        ])
      : pick([
          'Potentially relevant, but I need the mechanism, not the pitch. What exactly comes out of manual coordination and who owns incidents?',
        ]);
  }
  return lang === 'ru'
    ? pick([
        'Потенциально это в тему. Но чтобы продолжать, мне нужна чёткая граница: что именно Mellow контролирует, а что нет?',
        'Вижу, почему вы написали. Теперь без общих слов: где зона контроля Mellow и как это выглядит на практике?',
      ])
    : pick([
        'Potentially relevant. To continue, I need the control boundary clearly: what exactly does Mellow own, and what does it not?',
      ]);
}

function stateDrivenReplyOverride(session, sellerText) {
  const buyerState = normalizeBuyerState(session?.buyer_state || buildInitialBuyerState(session), session);
  const lang = session.language === 'ru' ? 'ru' : 'en';
  const assets = getRelevantSalesAssets(session, lang);
  const lower = sellerText.toLowerCase();
  const hints = buyerStateTextHints(lang);
  const hasNextStep = hasAny(lower, hints.nextStep);
  const hasMechanism = hasAny(lower, hints.mechanism);
  const persona = personaMeta(session) || {};
  const acceptanceStage = session?.meta?.acceptance_stage || getBuyerAcceptanceStage(session);
  const financePersona = isFinancePersonaId(persona.id);
  const hasWrittenStep = explicitWrittenRequest(lower) || hasAny(lower, ['memo', 'brief', 'one-pager', 'summary', 'breakdown', 'записк', 'материал', 'схем', 'пришлю', 'отправлю']);
  const hasCallStep = explicitReviewReference(lower);
  const antiSilenceThirdTurn = buyerState.conversation_capacity <= 0
    && ['panic_churn_ops', 'cm_winback', 'grey_pain_switcher', 'direct_contract_transition'].includes(persona.id)
    && hasAny(lower, ['план', 'flow', 'incident', 'recovery', 'mapping', 'slice', 'созвон', 'call', 'pilot', 'пилот', 'boundary', 'owner', 'transition']);

  if (antiSilenceThirdTurn && !session.meta._memo_requested) {
    if (persona.id === 'panic_churn_ops') {
      session.meta._memo_requested = true;
      return lang === 'ru'
        ? pick([
            'Пришлите это письменно и очень коротко: кто предупреждает людей, как выглядит incident path и что именно они узнают заранее. Если это внятно, тогда имеет смысл продолжить.',
            'Ок. Нужен короткий written recovery flow без общих слов. Если там правда видно, что прошлый сценарий не повторится, можно двигаться дальше.',
          ])
        : pick([
            'Send this in writing and keep it short: who informs people, what the incident path looks like, and what they know in advance. If that is clear, we can continue.',
          ]);
    }
    if (persona.id === 'grey_pain_switcher') {
      session.meta._memo_requested = true;
      return lang === 'ru'
        ? pick([
            'Тогда пришлите очень коротко: кто owner при инциденте, как идёт bank/question path и где ваша граница заканчивается. Если это выглядит чисто, продолжим.',
            'Ок. Нужна короткая incident-boundary note без лозунгов: owner, путь исключения, граница ответственности. Если это приземлённо, обсудим дальше.',
          ])
        : pick([
            'Then send it very briefly: who owns the incident, how the bank/question path works, and where your scope stops. If that looks clean, we can continue.',
          ]);
    }
    if (persona.id === 'direct_contract_transition') {
      session.meta._memo_requested = true;
      return lang === 'ru'
        ? pick([
            'Тогда пришлите очень короткий transition slice map: кто входит в пилот, что меняется в workflow и кто owner на исключениях. Если это узко и безопасно, обсудим дальше.',
            'Ок. Нужен короткий mapping по узкому slice, без broad relaunch: состав, workflow, граница ответственности. Если логика чистая, продолжим.',
          ])
        : pick([
            'Then send a very short transition slice map: who moves first, what changes in workflow, and who owns exceptions. If it looks narrow and safe, we can continue.',
          ]);
    }
    session.meta._memo_requested = true;
    return lang === 'ru'
      ? pick([
          'Тогда пришлите очень короткое описание этого slice: кого именно вы имеете в виду и почему fit появился сейчас. Если логика чистая, обсудим дальше.',
          'Ок. Нужен короткий slice map без comeback-риторики. Если там правда новый fit, тогда можно продолжить разговор.',
        ])
      : pick([
          'Send a very short description of that slice: who exactly you mean and why the fit exists now. If the logic is clean, we can continue.',
        ]);
  }

  if ((buyerState.conversation_capacity <= 0 || buyerState.disengagement_risk >= 0.9) && !session.meta._memo_requested) {
    if (isEmailMode(session) && (session.meta?.bot_turns || 0) === 0) {
      return emailFirstReplyFallback(session);
    }
    if (isEmailMode(session) && (session.meta?.bot_turns || 0) === 1) {
      const persona = personaMeta(session) || {};
      if ((persona.archetype || '') === 'legal') {
        session.meta._memo_requested = true;
        return lang === 'ru'
          ? 'Ок, пришлите это одним экраном письменно: граница ответственности, документы и incident path. Если формулировки чистые, дальше уже можно решать, нужен ли короткий review call.'
          : 'Ok, send that in one screen: responsibility boundary, documents, and incident path. If the wording is clean, we can decide whether a short review call is worth it.';
      }
      if ((persona.archetype || '') === 'ops') {
        session.meta._memo_requested = true;
        return lang === 'ru'
          ? 'Ок, тогда пришлите короткую workflow note: что уходит из ручной координации, кто owner при сбое и что команда видит заранее. Если это выглядит приземлённо, продолжим.'
          : 'Ok, then send a short workflow note: what comes out of manual coordination, who owns incidents, and what the team sees in advance. If that looks grounded, we can continue.';
      }
      session.meta._memo_requested = true;
      return lang === 'ru'
        ? 'Ок, тогда пришлите это коротко письменно: зона контроля, документы, payment chain и что остаётся на нашей стороне. Если логика выглядит чисто, продолжим уже по review path.'
        : 'Ok, then send this briefly in writing: control boundary, documents, payment chain, and what stays on our side. If the logic looks clean, we can continue on a review path.';
    }
    return null;
  }

  if (financePersona && acceptanceStage === 'mechanics_engaged' && hasMechanism && buyerState.clarity >= 42 && buyerState.interest >= 18) {
    return lang === 'ru'
      ? pick([
          'Это уже понятнее. Теперь разложите economics до конца: где ставка, где FX, где цена ручной координации и что buyer видит заранее.',
          'Ок, механизм уже понятнее. Теперь нужен language of money: где именно premium, где риск сбоя, где скрытая ручная цена.',
        ])
      : pick([
          'This is clearer now. Next I need the economics all the way through: rate, FX, manual coordination cost, and what the buyer sees in advance.',
        ]);
  }

  if (financePersona && acceptanceStage !== 'written_step_accepted' && buyerAskedFinanceEconomicsMath(session) && !session.meta._finance_math_answered) {
    session.meta._finance_math_answered = true;
    if (persona.id === 'fx_trust_shock_finance') {
      return lang === 'ru'
        ? pick([
            `Заранее buyer видит не обещание, а короткую cost breakdown model: базовая ставка, FX по нужной валютной паре, payout route и что меняется, если банк или выплата дают сбой. ${assets.caseSnippet} То есть effective cost видна до первого платежа, а не объясняется задним числом.`,
            'Здесь математика должна быть видна до старта в одном экране: ставка, FX-слой, маршрут выплаты и failure path. Если этого нет заранее, доверие действительно не восстанавливается.',
          ])
        : pick([
            'The buyer should see a real cost breakdown before launch: base rate, FX for the relevant currency pair, payout route, and what changes if a bank or payout failure occurs. Effective cost has to be visible before the first payment, not explained after it.',
          ]);
    }
    if (persona.id === 'rate_floor_cfo') {
      return lang === 'ru'
        ? pick([
            'Если перевести premium в язык денег, разница обычно в трёх строках: цена ручной координации внутри finance, цена платежного сбоя и цена непрозрачной полной стоимости до invoicing. Не “надёжность вообще”, а конкретная управляемость этих трёх слоёв.',
            'Здесь premium оправдывается не словом “сервис”, а тремя экономическими слоями: меньше ручного хвоста у finance, меньше цена инцидента и заранее видимая полная стоимость до invoicing.',
          ])
        : pick([
            'In money terms, the premium usually sits in three lines: finance-side manual coordination, incident cost when a payment goes wrong, and full cost visibility before invoicing. Not reliability as a slogan, but control over those three layers.',
          ]);
    }
  }

  if (financePersona && ['economics_engaged', 'written_step_requested'].includes(acceptanceStage) && hasWrittenStep && !session.meta._memo_requested && buyerState.clarity >= 50) {
    session.meta._memo_requested = true;
    return lang === 'ru'
      ? pick([
          `Хорошо. Пришлите это коротко письменно: математика, граница ответственности, incident path. Можно в формате: ${assets.writtenProof} Если там все приземлённо, тогда уже можно взять 15 минут на review.`,
          `Ок. Нужна короткая записка без общих слов: economics, scope boundary, failure path. При желании добавьте ${assets.calculator} Если это выглядит честно, найдём 15 минут на разбор.`,
        ])
      : pick([
          'Fine. Send this briefly in writing: economics, scope boundary, and failure path. If it is grounded, we can take 15 minutes for a review.',
        ]);
  }

  if (financePersona && acceptanceStage === 'written_step_accepted') {
    if (buyerShowsPostArtifactReviewReadiness(session)) {
      return lang === 'ru'
        ? pick([
            'Хорошо, тогда следующий шаг уже понятен: короткий 15-минутный review call только по economics вашего кейса, без широкого pitch. Какой слот удобен?',
            'Ок, раз материал выглядит рабочим, давайте коротко созвонимся на 15 минут только по economics и fit на вашем кейсе. Когда удобно?',
          ])
        : pick([
            'Good, then the next step is clear: a short 15-minute review call only on the economics of your case. What time works?',
          ]);
    }
    return lang === 'ru'
      ? pick([
          'Если записка выглядит приземлённо, следующим шагом логично взять короткий 15-минутный review только по economics вашего кейса, без широкого pitch. Если такой формат ок, я предложу слот.',
          'После такой записки обычно не нужен новый длинный обмен сообщениями, а нужен короткий review по кейсу. Если формат ок, следующим сообщением зафиксирую 15 минут только на economics и fit.',
        ])
      : pick([
          'If the note looks grounded, the natural next step is a short 15-minute review on the economics of your case. If that format works, I can suggest a slot next.',
        ]);
  }

  if (financePersona && session.meta._memo_requested && hasCallStep && buyerState.next_step_likelihood >= 0.45 && buyerState.trust >= 40) {
    return lang === 'ru'
      ? pick([
          'Да, если записка будет конкретной, можно взять короткий 15-минутный review call по кейсу.',
          'Ок, после нормальной записки давайте коротко созвонимся на 15 минут и проверим это на нашем кейсе.',
        ])
      : pick([
          'Yes, if the note is concrete, we can do a short 15-minute review call on the case.',
        ]);
  }

  if (financePersona && acceptanceStage === 'written_step_accepted' && hasCallStep && buyerState.clarity >= 55) {
    return lang === 'ru'
      ? pick([
          'Да, это уже нормальный следующий шаг. После такой записки можно коротко созвониться на 15 минут и пройти только economics вашего кейса.',
          'Согласен. Если breakdown действительно закрывает surprise risk, давайте возьмём короткий 15-минутный review call только по economics.',
        ])
      : pick([
          'Yes, that is a reasonable next step. After a note like that, we can do a short 15-minute review call focused only on the economics of your case.',
        ]);
  }

  if (!financePersona && ['panic_churn_ops', 'grey_pain_switcher', 'cm_winback', 'direct_contract_transition'].includes(persona.id) && acceptanceStage === 'written_step_accepted' && hasCallStep) {
    return lang === 'ru'
      ? pick([
          'Да, так нормально. Пришлите материал, и дальше логичный шаг, это короткий 15-минутный review только по спорным местам нашего кейса.',
          'Ок, это разумно. Сначала материал, потом короткий 15-минутный review call только по fit, boundary и следующему шагу.',
        ])
      : pick([
          'Yes, that works. Send the material first, then the natural next step is a short 15-minute review call only on fit, boundary, and the open points in our case.',
        ]);
  }

  if (!financePersona && ['panic_churn_ops', 'grey_pain_switcher', 'cm_winback', 'direct_contract_transition'].includes(persona.id) && acceptanceStage === 'written_step_accepted') {
    if (buyerShowsPostArtifactReviewReadiness(session)) {
      return lang === 'ru'
        ? pick([
            'Ок, тогда следующий шаг уже узкий и понятный: короткий 15-минутный review call только по fit, boundary и спорным местам кейса. Какой слот удобен?',
            'Хорошо, раз материал подходит, давайте коротко созвонимся на 15 минут только по fit, boundary и следующему шагу. Когда удобно?',
          ])
        : pick([
            'Good, then the next step is a short 15-minute review call only on fit, boundary, and the open points in the case. What time works?',
          ]);
    }
    return lang === 'ru'
      ? pick([
          'Если материал выглядит рабочим, следующим шагом логично взять короткий 15-минутный review только по спорным местам кейса, без широкого pitch. Если формат ок, я предложу слот следующим сообщением.',
          'После такой записки не нужен новый длинный круг переписки. Нужен короткий review по fit и boundary. Если такой формат ок, следующим сообщением зафиксирую 15 минут.',
        ])
      : pick([
          'If the material looks workable, the natural next step is a short 15-minute review only on the open points in the case. If that format works, I can suggest a slot next.',
        ]);
  }

  if (buyerState.conversation_capacity <= 1 && buyerState.disengagement_risk >= 0.75 && !hasNextStep && !hasMechanism && !session.meta._memo_requested) {
    return lang === 'ru'
      ? pick([
          'Сейчас не лучший момент. Если хотите продолжить, пришлите коротко и по делу.',
          'Пока не готов продолжать длинный разговор. Нужен очень короткий follow-up с конкретикой.',
        ])
      : pick([
          "This isn't the right moment for a longer thread. If you follow up, keep it very short and concrete.",
          "I'm close to dropping this thread. If you want to continue, send a brief concrete follow-up.",
        ]);
  }

  if (buyerState.trust <= 25 && isMisclassificationBlocker(sellerText)) {
    return lang === 'ru'
      ? 'На таком overclaim доверие заканчивается. Если хотите продолжать, сформулируйте зону Mellow без магических обещаний.'
      : "That overclaim kills credibility. If you want to continue, restate Mellow's scope without magical promises.";
  }

  if (buyerState.clarity <= 28 && buyerState.interest >= 18 && !hasMechanism) {
    return lang === 'ru'
      ? pick([
          'Пока не понимаю механику. Что именно делает Mellow по шагам, а что остаётся на нашей стороне?',
          'Интерес есть, но схема пока размыта. Объясните конкретно: документы, платёжный flow, инциденты.',
        ])
      : pick([
          "I'm interested, but I still don't understand the mechanism. What exactly does Mellow do step by step, and what stays on our side?",
          "There's some relevance here, but the setup is still blurry. Explain it concretely: documents, payout flow, incident handling.",
        ]);
  }

  return undefined;
}

function buyerStateImpactScore(transition) {
  const delta = transition?.predicted_delta || {};
  return (
    (delta.patience || 0) * 0.7
    + (delta.interest || 0)
    + (delta.perceived_value || 0)
    + (delta.trust || 0)
    + (delta.clarity || 0)
    + (delta.conversation_capacity || 0) * 6
  );
}

function sellerTurnRecords(session) {
  return (session?.transcript || []).filter((entry) => entry.role === 'seller' && entry.buyer_state_transition);
}

function buildBuyerStateReport(session) {
  const turns = sellerTurnRecords(session);
  if (!turns.length) return null;

  const initialState = turns[0].buyer_state_transition.state_before;
  const finalState = turns[turns.length - 1].buyer_state_transition.state_after;
  const strongestPositiveTurn = turns.reduce((best, entry) => {
    const score = buyerStateImpactScore(entry.buyer_state_transition);
    if (!best || score > best.score) {
      return {
        score,
        turn_index: entry.buyer_state_transition.turn_index,
        seller_message: entry.text,
        explanation: entry.buyer_state_transition.explanation,
      };
    }
    return best;
  }, null);
  const biggestDamageTurn = turns.reduce((worst, entry) => {
    const score = buyerStateImpactScore(entry.buyer_state_transition);
    if (!worst || score < worst.score) {
      return {
        score,
        turn_index: entry.buyer_state_transition.turn_index,
        seller_message: entry.text,
        explanation: entry.buyer_state_transition.explanation,
      };
    }
    return worst;
  }, null);
  const highestRiskTurn = turns.reduce((worst, entry) => {
    const risk = Number(entry.buyer_state_transition?.derived_metrics_after?.disengagement_risk || 0);
    if (!worst || risk > worst.disengagement_risk) {
      return {
        disengagement_risk: risk,
        turn_index: entry.buyer_state_transition.turn_index,
        seller_message: entry.text,
        explanation: entry.buyer_state_transition.explanation,
      };
    }
    return worst;
  }, null);

  const dimension_summary = BUYER_STATE_DIMENSIONS.map((key) => {
    const start = roundMetric(initialState?.[key]);
    const end = roundMetric(finalState?.[key]);
    const delta = end - start;
    let signal = 'steady';
    if (key === 'conversation_capacity') {
      signal = end <= 1 ? 'risk' : end <= 2 ? 'watch' : 'healthy';
    } else if (end <= 25) {
      signal = 'risk';
    } else if (end <= 45) {
      signal = 'watch';
    } else {
      signal = 'healthy';
    }
    return {
      id: key,
      label: BUYER_STATE_LABELS[key] || key,
      start,
      end,
      delta,
      signal,
    };
  });

  const strongestDimension = [...dimension_summary].sort((a, b) => b.delta - a.delta)[0];
  const weakestDimension = [...dimension_summary].sort((a, b) => a.delta - b.delta)[0];

  return {
    initial_state: initialState,
    final_state: finalState,
    final_metrics: {
      reply_likelihood: session?.buyer_state?.reply_likelihood ?? null,
      next_step_likelihood: session?.buyer_state?.next_step_likelihood ?? null,
      disengagement_risk: session?.buyer_state?.disengagement_risk ?? null,
    },
    strongest_positive_turn: strongestPositiveTurn,
    biggest_damage_turn: biggestDamageTurn,
    highest_risk_turn: highestRiskTurn,
    strongest_dimension: strongestDimension,
    weakest_dimension: weakestDimension,
    dimension_summary,
  };
}

function buildPersonaSeed(personaId) {
  const seeds = {
    andrey:         pick(['risk-first', 'blunt-skeptic', 'deal-weary', 'analytical']),
    alexey:         pick(['speed-freak', 'pragmatist', 'exec-compressed', 'semi-open']),
    cfo_round:      pick(['diligence-focused', 'cautious-timing', 'investor-aware', 'process-risk']),
    eng_manager:    pick(['champion-potential', 'skeptical-vendor', 'bridge-seeker', 'tired-escalator']),
    ops_manager:    pick(['chaos-averse', 'time-poor', 'process-fatigued', 'results-oriented']),
    head_finance:   pick(['control-seeker', 'reporting-pressure', 'audit-focused', 'explainability-first']),
    internal_legal: pick(['precision-seeker', 'grey-zone-fatigued', 'methodical', 'overclaim-allergic']),
    external_legal: pick(['deeply-skeptical', 'defensibility-focused', 'rapid-assessor', 'evidence-first']),
    olga:           pick(['outside-counsel', 'defensibility-check', 'tight-wording', 'evidence-first']),
  };
  return seeds[personaId] || 'default';
}

function extractClaims(sellerText) {
  const lower = sellerText.toLowerCase();
  const found = {};
  const dayMatch = lower.match(/(\d+)\s*дн/);
  if (dayMatch) found.days = dayMatch[0].trim();
  for (const tool of ['wise', 'crypto', 'payoneer', 'swift', 'revolut']) {
    if (lower.includes(tool)) { found.tool = tool; break; }
  }
  if (lower.includes('sla')) found.sla = true;
  if (lower.includes('audit trail') || lower.includes('audit-trail')) found.auditTrail = true;
  const rubMatch = lower.match(/(\d[\d\s]*)\s*(тыс|млн|руб|₽|\$|€|usd|eur)/);
  if (rubMatch) found.amount = rubMatch[0].trim();
  if (hasAny(lower, ['срочно', 'deadline', 'дедлайн', 'до конца', 'до пятниц', 'до следующ'])) found.urgency = true;
  if (hasAny(lower, ['другой', 'конкурент', 'альтернатив', 'сравниваю', 'тоже смотрим'])) found.competitor = true;
  if (hasAny(lower, ['пилот', 'trial', 'тест', 'попробовать', 'проверить'])) found.trialMention = true;
  return found;
}

function updateSessionClaims(session, sellerText) {
  const current = session.meta.claims || {};
  session.meta.claims = { ...current, ...extractClaims(sellerText) };
}

function verdictLabel(verdict) {
  return {
    PASS: 'Готово к следующему шагу',
    PASS_WITH_NOTES: 'Хорошо, но можно сильнее',
    FAIL: 'Нужна доработка',
    BLOCKER: 'Критическая ошибка'
  }[verdict] || verdict;
}

function criterionLabel(id) {
  return {
    K1: 'Заход через реальный контекст',
    K2: 'Границы ответственности и контроль',
    K3: 'Попадание в язык собеседника',
    K4: 'Работа с ключевыми возражениями',
    K5: 'Чёткий следующий шаг'
  }[id] || id;
}

function recommendationLabel(code, persona) {
  if (code === 'advance_followup') {
    return 'Можно переходить к follow-up: коротко зафиксируй flow, следующий шаг и зачем продолжать разговор.';
  }
  if (code.startsWith('repeat_') && code.endsWith('_boundary')) {
    return `Повтори прогон с ${persona.name}: держи разговор через зону контроля, документы, платёжный flow и без обещаний снять чужой риск.`;
  }
  if (code.startsWith('repeat_') && code.endsWith('_conciseness')) {
    return `Повтори прогон с ${persona.name}: укороти подачу и продавай через speed, predictability и снятие ручной возни.`;
  }
  if (code.startsWith('repeat_') && code.endsWith('_legal_scope')) {
    return `Повтори прогон с ${persona.name}: говори точнее про документы, audit trail, process safeguards и границы ответственности.`;
  }
  return 'Повтори прогон и доведи разговор до более конкретного, доверительного next step.';
}

function sellerMessages(session) {
  return session.transcript.filter((m) => m.role === 'seller').map((m) => m.text);
}

function botMessages(session) {
  return session.transcript.filter((m) => m.role === 'bot').map((m) => m.text);
}

function isMisclassificationBlocker(text) {
  const lower = text.toLowerCase();
  if (!lower.includes('misclassification')) return false;
  const negativeFrames = [
    'не обещ', 'не бер', 'не берё', 'не снима', 'не защищ', 'не можем обещ',
    "won't", "don't", "cannot", "can't", "not taking", "not covering", "not protecting",
    "we don't", "we won't", "we can't", "we cannot", "don't promise", "not something we",
    "doesn't cover", "doesn't protect", "does not", "do not take", "not take on",
    "doesn't take", "don't take", "not taking on", "we don't take", "we do not"
  ];
  if (negativeFrames.some((frame) => lower.includes(frame))) return false;
  return [
    'защит', 'сним', 'бер', 'гарант',
    'protect', 'remove', 'take on', 'guarantee', 'eliminate', 'cover', 'prevent', 'solve'
  ].some((frame) => lower.includes(frame));
}

function personaMeta(session) {
  return personas[session.bot_id];
}

// ==================== CONCERN & BEHAVIOR SYSTEM ====================

// Build a per-session concern order with variability in middle concerns
function buildConcernOrder(personaId, seed = null) {
  const persona = personas[personaId] || {};
  const archetype = persona.archetype;
  const promptDriven = deriveConcernOrderFromPrompt(persona.system_prompt, []);

  if (archetype === 'finance') {
    if (personaId === 'rate_floor_cfo' || personaId === 'fx_trust_shock_finance') {
      return deriveConcernOrderFromPrompt(persona.system_prompt, ['cost', 'scope', 'sla']);
    }
    if (personaId === 'cfo_round') {
      return deriveConcernOrderFromPrompt(persona.system_prompt, ['scope', 'cost', 'sla', 'geo_tax']);
    }
    if (personaId === 'head_finance') {
      return deriveConcernOrderFromPrompt(persona.system_prompt, ['scope', 'cost', 'sla']);
    }
    const r = Math.random();
    let middle;
    if (r < 0.35) middle = ['scope', 'why_change', 'sla'];
    else if (r < 0.60) middle = ['why_change', 'scope', 'sla'];
    else if (r < 0.80) middle = ['scope', 'sla', 'why_change'];
    else middle = ['sla', 'scope', 'why_change'];
    const order = [...middle];
    if (['andrey', 'cfo_round'].includes(personaId)) order.push('geo_tax');
    return deriveConcernOrderFromPrompt(persona.system_prompt, order);
  }

  if (archetype === 'ops') {
    if (personaId === 'eng_manager') {
      const r = Math.random();
      if (r < 0.30) return deriveConcernOrderFromPrompt(persona.system_prompt, ['op_value', 'vendor_fatigue', 'internal_sell', 'cost']);
      if (r < 0.55) return deriveConcernOrderFromPrompt(persona.system_prompt, ['vendor_fatigue', 'op_value', 'internal_sell', 'cost']);
      if (r < 0.75) return deriveConcernOrderFromPrompt(persona.system_prompt, ['op_value', 'internal_sell', 'cost']);
      return deriveConcernOrderFromPrompt(persona.system_prompt, ['op_value', 'internal_sell', 'vendor_fatigue']);
    }
    if (personaId === 'alexey') {
      // Seed-specific ordering: exec-compressed leads with cost, others vary
      if (seed === 'exec-compressed') {
        return Math.random() > 0.4
          ? deriveConcernOrderFromPrompt(persona.system_prompt, ['cost', 'op_value', 'proof'])
          : deriveConcernOrderFromPrompt(persona.system_prompt, ['op_value', 'cost', 'proof']);
      }
      const r = Math.random();
      if (r < 0.35) return deriveConcernOrderFromPrompt(persona.system_prompt, ['op_value', 'proof', 'cost']);
      if (r < 0.65) return deriveConcernOrderFromPrompt(persona.system_prompt, ['op_value', 'cost', 'proof']);
      return deriveConcernOrderFromPrompt(persona.system_prompt, ['cost', 'op_value', 'proof']);
    }
    if (personaId === 'ops_manager') {
      const r = Math.random();
      if (r < 0.35) return deriveConcernOrderFromPrompt(persona.system_prompt, ['op_value', 'proof', 'internal_sell']);
      if (r < 0.65) return deriveConcernOrderFromPrompt(persona.system_prompt, ['op_value', 'internal_sell', 'proof']);
      return deriveConcernOrderFromPrompt(persona.system_prompt, ['proof', 'op_value', 'internal_sell']);
    }
    return deriveConcernOrderFromPrompt(persona.system_prompt, ['op_value', 'cost']);
  }

  if (archetype === 'legal') {
    const r = Math.random();
    if (personaId === 'external_legal') {
      // external_legal: can lead with scope, incident, or grey_zones
      if (r < 0.30) return deriveConcernOrderFromPrompt(persona.system_prompt, ['scope', 'incident', 'grey_zones']);
      if (r < 0.55) return deriveConcernOrderFromPrompt(persona.system_prompt, ['scope', 'grey_zones', 'incident']);
      if (r < 0.75) return deriveConcernOrderFromPrompt(persona.system_prompt, ['incident', 'scope', 'grey_zones']);
      return deriveConcernOrderFromPrompt(persona.system_prompt, ['grey_zones', 'scope', 'incident']);
    }
    // internal_legal: usually scope-first but with meaningful variety
    if (r < 0.35) return deriveConcernOrderFromPrompt(persona.system_prompt, ['scope', 'grey_zones', 'incident']);
    if (r < 0.60) return deriveConcernOrderFromPrompt(persona.system_prompt, ['scope', 'incident', 'grey_zones']);
    if (r < 0.80) return deriveConcernOrderFromPrompt(persona.system_prompt, ['grey_zones', 'scope', 'incident']);
    return deriveConcernOrderFromPrompt(persona.system_prompt, ['incident', 'grey_zones', 'scope']);
  }

  return promptDriven.length ? promptDriven : ['scope'];
}

// Check if seller's text addresses a specific concern
function sellerAdvancesConcern(concern, lower) {
  const maps = {
    scope:         ['документ', 'kyc', 'audit', 'trail', 'платеж', 'sla', 'цепоч', 'границ', 'ответствен', 'не снима', 'не берёт', 'огранич', 'warning', 'api', 'mcp', 'внедрен'],
    why_change:    ['риск', 'надёжн', 'надежн', 'документ', 'sla', 'системн', 'конкретн', 'не работа', 'сломает', 'уязвим', 'санкц', 'тяжел', 'снг', 'рф', 'беларус'],
    sla:           ['sla', 'эскалац', 'поддерж', 'инцидент', 'застр', 'статус', 'трекинг', '24 час', '48 час'],
    geo_tax:       ['ндфл', 'налог', 'россий', 'рф', 'паспорт', 'diligence', 'инвест'],
    op_value:      ['убирает', 'убрать', 'меньше', 'быстрее', 'конкретн', 'часов', 'минут', 'без ручн', 'статус', 'предсказ', 'процесс', 'встро', 'автомат', 'внедрен'],
    cost:          ['стоим', 'цен', 'дорог', 'бюджет', 'trial', 'пилот', 'деньг', 'месяц', 'zero cost', 'без затрат на старт', 'без upfront'],
    internal_sell: ['finance', 'финансист', 'внутри', 'champion', 'материал', 'письм', 'pitch', 'аргумент', 'слайд', 'enterprise', 'implementation', 'api', 'mcp'],
    grey_zones:    ['серые зон', 'overlap', 'между', 'разделен', 'flow', 'chain', 'цепоч', 'границ'],
    incident:      ['инцидент', 'исключен', 'flow', 'trail', 'эскалац', 'документ', 'в срок'],
    next_step:     ['созвон', 'звон', '15 минут', '20 минут', 'follow', 'материал', 'memo', 'review', 'walkthrough', 'расч'],
    vendor_fatigue:['другой vendor', 'обещал', 'другой сервис', 'пробовали', 'уже пробов', 'прошлый', 'раньше', 'до этого', 'похожий'],
    proof:         ['кейс', 'пример', 'клиент', 'кто использует', 'референс', 'результат', 'покажи', 'сравни', 'тест', 'пилот', 'trial'],
  };
  return hasAny(lower, maps[concern] || []);
}

// English keyword maps for concern detection (seller writes in English)
function sellerAdvancesConcernEN(concern, lower) {
  const maps = {
    scope:         ['document', 'kyc', 'audit', 'trail', 'payment chain', 'sla', 'chain', 'bound', 'responsible', 'responsibility', 'limit', 'warning', 'scope', 'api', 'mcp', 'implementation'],
    why_change:    ['risk', 'reliable', 'document', 'sla', 'systemic', 'concrete', 'break', 'vulnerab', 'won\'t survive', 'sanction', 'hard geo', 'cis', 'pakistan', 'india', 'africa', 'latam', 'asia'],
    sla:           ['sla', 'escalat', 'support', 'incident', 'stuck', 'status', 'track', '24 hour', '48 hour', 'response time'],
    geo_tax:       ['tax', 'russia', ' rf ', 'passport', 'diligence', 'invest', 'sanction', 'geo', 'jurisdiction'],
    op_value:      ['remov', 'fewer', 'faster', 'specific', 'hours', 'minutes', 'manual', 'status', 'predictable', 'process', 'saves', 'embed', 'workflow', 'implementation'],
    cost:          ['cost', 'price', 'expens', 'budget', 'trial', 'pilot', 'money', 'month', 'zero cost', 'no upfront'],
    internal_sell: ['finance', 'internal', 'champion', 'material', 'letter', 'pitch', 'argument', 'slide', 'stakeholder', 'enterprise', 'implementation', 'api', 'mcp'],
    grey_zones:    ['grey zone', 'gray zone', 'overlap', 'between', 'divid', 'flow', 'chain', 'boundary', 'gap'],
    incident:      ['incident', 'exception', 'flow', 'trail', 'escalat', 'document', 'on time', 'on-time'],
    next_step:     ['call', 'meeting', '15 minute', '20 minute', 'follow', 'material', 'memo', 'review', 'walkthrough', 'calculation'],
    vendor_fatigue:['another vendor', 'promised', 'tried before', 'previous vendor', 'similar', 'last time'],
    proof:         ['case study', 'example', 'client', 'reference', 'result', 'show me', 'compare', 'test', 'pilot', 'trial'],
  };
  return hasAny(lower, maps[concern] || []);
}

// Get the current active (unresolved) concern from the session's shuffled order
function getActiveConcern(session) {
  const order = session.meta.concern_order || [];
  const resolved = session.meta.resolved_concerns || {};
  for (const c of order) {
    if (!resolved[c]) return c;
  }
  return null;
}

// Update trust/irritation based on seller turn quality
function updateBehaviorState(session, sellerText) {
  if (typeof sellerText !== 'string' || !sellerText.trim()) return;
  const lower = sellerText.toLowerCase();
  const archetype = personaMeta(session).archetype;
  const concern = getActiveConcern(session);
  const isEN = session.language === 'en';

  // Hard negatives
  const marketingSlang = isEN
    ? hasAny(lower, ['market leader', 'best-in-class', 'reliable solution', 'scale without', 'innovative'])
    : hasAny(lower, ['лидер рынка', 'best-in-class', 'надежное решение', 'масштабируйтесь без проблем', 'инновационн']);
  const tooLong = archetype === 'ops' && countWords(sellerText) > 50;

  if (marketingSlang || tooLong) {
    session.meta.irritation = Math.min(3, (session.meta.irritation || 0) + 1.2);
    session.meta.miss_streak = (session.meta.miss_streak || 0) + 1;
    return;
  }

  const advances = concern
    ? (isEN ? sellerAdvancesConcernEN(concern, lower) : sellerAdvancesConcern(concern, lower))
    : false;
  if (!advances) {
    session.meta.irritation = Math.min(3, (session.meta.irritation || 0) + 0.7);
    session.meta.miss_streak = (session.meta.miss_streak || 0) + 1;
    return;
  }

  // Count keyword hits to grade quality
  const concernKeys = isEN
    ? {
        scope:         ['document', 'kyc', 'audit', 'trail', 'sla', 'chain', 'boundary', 'responsible'],
        why_change:    ['risk', 'document', 'sla', 'systemic', 'concrete'],
        sla:           ['sla', 'escalat', 'support', 'incident', 'status'],
        geo_tax:       ['tax', 'russia', 'passport'],
        op_value:      ['remov', 'fewer', 'faster', 'hours', 'concrete'],
        cost:          ['cost', 'price', 'trial', 'pilot'],
        internal_sell: ['material', 'letter', 'pitch', 'finance'],
        grey_zones:    ['process', 'flow', 'divid', 'boundary'],
        incident:      ['incident', 'flow', 'trail', 'escalat'],
      }
    : {
        scope:         ['документ', 'kyc', 'audit', 'trail', 'sla', 'цепоч', 'границ', 'ответствен'],
        why_change:    ['риск', 'документ', 'sla', 'системн', 'конкретн'],
        sla:           ['sla', 'эскалац', 'поддерж', 'инцидент', 'статус'],
        geo_tax:       ['ндфл', 'налог', 'россий'],
        op_value:      ['убирает', 'меньше', 'быстрее', 'часов', 'конкретн'],
        cost:          ['стоим', 'цен', 'trial', 'пилот'],
        internal_sell: ['материал', 'письм', 'pitch', 'финансист'],
        grey_zones:    ['процесс', 'flow', 'разделен', 'границ'],
        incident:      ['инцидент', 'flow', 'trail', 'эскалац'],
      };
  const hits = (concernKeys[concern] || []).filter(k => lower.includes(k)).length;
  const quality = hits >= 2 ? 'strong' : 'partial';

  if (quality === 'strong') {
    session.meta.irritation = Math.max(0, (session.meta.irritation || 0) - 0.8);
    session.meta.trust = Math.min(3, (session.meta.trust || 1) + 0.6);
    session.meta.miss_streak = 0;
    if (concern) {
      session.meta.resolved_concerns = { ...(session.meta.resolved_concerns || {}), [concern]: 'strong' };
    }
  } else {
    session.meta.irritation = Math.max(0, (session.meta.irritation || 0) - 0.3);
    session.meta.miss_streak = 0;
  }
}

// ==================== FINANCE RESPONSES ====================

function respondFinance(session, sellerText) {
  const lower = sellerText.toLowerCase();
  const turn = session.meta.bot_turns || 0;
  const claims = session.meta.claims || {};
  const persona = personaMeta(session);
  const trust = session.meta.trust || 1;
  const irritation = session.meta.irritation || 0;
  const flags = session.meta.flags || {};

  if (turn === 1 && persona.id === 'rate_floor_cfo') {
    return pick([
      'Хорошо, тогда не в терминах красивого сервиса. Где именно у вас экономическая логика premium: SLA, меньше инцидентов, меньше скрытого future cost или что-то ещё?',
      'Тогда разложите premium на язык денег. За что конкретно я плачу выше рынка, кроме общего ощущения надёжности?',
      'Ок, идём не через лозунги. Где у вас разница в economics: риск инцидента, cost of delay, hidden ops load или что именно?',
    ]);
  }
  if (turn === 2 && persona.id === 'rate_floor_cfo' && sellerAdvancesConcern('cost', lower)) {
    return pick([
      'Хорошо. Теперь второе, без чего это не продать внутри: что именно у вас в зоне Mellow, а что остаётся на нас? Платёжная цепочка, KYC, разбор сбоя?',
      'Ок, экономику вы очертили. Теперь нужна clean boundary: что именно вы берёте на себя в payment flow, а что остаётся на finance команде?',
      'Нормально. Следующий вопрос тогда про механику: где ваша зона в цепочке, а где остаётся наша ответственность?',
    ]);
  }
  if (turn === 1 && persona.id === 'fx_trust_shock_finance') {
    return pick([
      'Это уже ближе. Теперь разложите математику до конца: какой слой rate, какой слой FX, какой слой банковой цепочки, и где buyer видит это заранее?',
      'Хорошо. Но мне нужен не общий принцип, а прозрачная total-cost логика до платежа, а не после него. Как именно вы это показываете?',
      'Если вы хотите вернуть доверие, мне нужна предсказуемая математика вперёд. Где buyer заранее видит реальную effective cost?',
    ]);
  }
  if (turn === 2 && persona.id === 'fx_trust_shock_finance') {
    return pick([
      'Хорошо. Пришлите короткую cost breakdown model: что видно до старта, где возможен FX effect, и как buyer заранее видит effective cost. Если там правда нет surprise, тогда можно идти дальше.',
      'Ок. Мне нужен один экран с честной total-cost логикой до первого платежа. Если это прозрачно, обсуждение можно продолжать.',
      'Тогда следующий шаг только такой: прозрачная схема стоимости до invoicing. Если она убирает surprise, у разговора есть шанс.',
    ]);
  }
  if (turn === 3 && persona.id === 'fx_trust_shock_finance' && sellerAdvancesConcern('cost', lower)) {
    return pick([
      'Ок. Если пришлёте это в одном коротком breakdown без сюрпризов по FX и payment chain, дальше можно взять 15 минут только на economics и fit.',
      'Хорошо. Если это реально один короткий breakdown по ставке, FX и payout route, я готова перейти к короткому review call.',
      'Нормально. Дайте это в коротком виде, а потом можно 15 минут только на economics, без общего демо.',
    ]);
  }
  const seed = session.meta.persona_seed || 'analytical';

  // head_finance: reporting-upward differentiation — unique to Elena, not andrey
  if (persona.id === 'head_finance' && turn >= 1 && ['reporting-pressure', 'audit-focused', 'explainability-first'].includes(seed) && !session.meta._hf_report_done) {
    session.meta._hf_report_done = true;
    return pick([
      'Я должна отчитаться перед советом за каждого vendor, которого вводим. Что именно я им говорю — в двух предложениях, без pitch?',
      'У меня встреча с CEO через месяц. Что им сказать: почему Mellow, почему сейчас, что именно берёт на себя?',
      'Каждый vendor — это вопрос от leadership. Что именно я им объясняю про Mellow и почему это надёжнее текущей схемы?',
      'Мне нужно это объяснять наверх. Что именно ваша зона — в формате, который я могу положить на стол совету?',
    ]);
  }

  // Seed-based tone modulation: certain seeds add a personal pressure line on later turns
  if (turn === 2 && seed === 'deal-weary' && irritation < 1) {
    session.meta._seed_comment_done = (session.meta._seed_comment_done || 0) + 1;
    if (session.meta._seed_comment_done === 1) {
      return pick([
        'Слышу. Но у меня в очереди ещё три vendor-разговора на этой неделе. Что именно выделяет вас?',
        'Понятно. Только у меня уже была похожая история с другим vendor — и закончилась ничем. Почему здесь иначе?',
      ]);
    }
  }
  if (turn === 2 && seed === 'risk-first' && trust < 1.5) {
    session.meta._seed_comment_done = (session.meta._seed_comment_done || 0) + 1;
    if (session.meta._seed_comment_done === 1) {
      return pick([
        'Подождите. Прежде чем идти дальше — что происходит, если всё пойдёт не по плану? Это моя главная точка.',
        'Мне важно понять failure mode до того, как двигаться дальше. Что происходит при инциденте?',
      ]);
    }
  }

  if (turn === 2 && persona.id === 'head_finance' && sellerAdvancesConcern('scope', lower)) {
    return pick([
      'Хорошо, зона стала понятнее. Теперь мне нужна экономическая часть: что именно уходит из ручной сверки и координации, а что остаётся внутри finance?',
      'Ок, граница стала чище. Следующий вопрос про control economics: что реально снимается с команды в ручном режиме?',
      'Нормально. Тогда добиваем картину: где здесь экономия ручного finance burden, а не просто более аккуратная схема?',
    ]);
  }
  if (turn === 2 && persona.id === 'cfo_round' && sellerAdvancesConcern('scope', lower)) {
    return pick([
      'Хорошо. Теперь следующий слой: где именно здесь economics of readiness, то есть что уходит из ручной подготовки к diligence и внутренней координации?',
      'Ок, по зоне стало понятнее. Теперь разложите investor-readiness на язык стоимости и подготовки, а не структуры.',
      'Нормально. Следующий вопрос тогда не про scope, а про prep cost перед diligence: что именно становится дешевле и объяснимее?',
    ]);
  }

  if (isMisclassificationBlocker(sellerText)) {
    session.meta.flags = { ...flags, blocker: true };
    return pick([
      'То есть вы сейчас обещаете снять misclassification риск? Именно такие обещания и подрывают доверие. Где у вас заканчивается ответственность?',
      'Это именно тот overclaim, который разрушает доверие с первого раза. Сформулируйте зону Mellow без магических обещаний.',
      'Стоп. Если вы обещаете снять misclassification risk — на этом разговор заканчивается. Где именно ваша зона контроля?',
      'Misclassification вы не можете снять, и если обещаете — это красный флаг. Что именно в вашей зоне, без расширенных обещаний?',
    ]);
  }

  // Turn 0: context check
  if (turn === 0) {
    if (persona.id === 'rate_floor_cfo') {
      return pick([
        'Ставку рынка я знаю. Вопрос простой: почему мне платить вам выше 3%, и что именно я покупаю поверх этой разницы?',
        'Я уже вижу рынок 2.5-3.5%. Что у вас не просто дороже, а реально стоит premium?',
        'Цена для меня не первая тема, но почти всегда финальная. Что именно оправдывает ваш premium относительно рынка?',
      ]);
    }
    if (persona.id === 'fx_trust_shock_finance') {
      return pick([
        'У нас уже был post-invoice сюрприз по effective cost. Объясните прямо: где rate, где FX, и почему это не было прозрачно с самого начала?',
        'Меня интересует не headline rate, а итоговая экономика. Где именно у вас формируется реальная total cost?',
        'После FX surprise мне нужен не pitch, а честная математика. Из чего реально складывается стоимость?',
      ]);
    }
    if (!hasAny(lower, ['audit', 'review', 'дью', 'due', 'раунд', 'инвест', '23', 'wise', 'payoneer', 'подряд', 'сверк'])) {
      return pick([
        'Пока слишком общо. Что именно вы увидели в нашем контексте, и почему пишете именно сейчас?',
        'Это звучит как стандартный открывающий питч. Что конкретно из нашей ситуации вас зацепило?',
        'Непонятно, почему вы пишете именно сейчас. Что в нашем контексте подтолкнуло к этому письму?',
        'Слишком общий заход. Что именно вы знаете про нашу ситуацию, прежде чем писать?',
        'Это шаблон. Что конкретно у нас происходит, что вас привело именно сейчас?',
        'Я каждую неделю получаю такие письма. Чем ваше отличается — что вы видели у нас до отправки?',
      ]);
    }
    if (persona.id === 'cfo_round') {
      return pick([
        'Ок, контекст раунда вы заметили. Тогда сразу: что именно Mellow делает управляемее перед diligence, а где ваша зона заканчивается?',
        'Понял, что вы отслеживаете раунд. Конкретно: что именно упрощается перед следующим diligence, и где ваша зона контроля заканчивается?',
        'Раунд заметили. Тогда напрямую: какую часть проблемы с contractor documentation вы закрываете, а что остаётся у меня?',
        'Это видно, что вы смотрели контекст. Тогда сразу к делу: где конкретно заканчивается зона Mellow перед diligence?',
      ]);
    }
    if (persona.id === 'head_finance') {
      const hfSeed = session.meta.persona_seed || 'control-seeker';
      if (hfSeed === 'control-seeker') {
        return pick([
          'Контекст понятен. Мне нужна граница: что именно в вашей зоне, что у меня — чётко, без деклараций.',
          'Хорошо. Что именно вы контролируете — документы, сверка, аудит? Где ваша зона заканчивается?',
        ]);
      }
      if (hfSeed === 'reporting-pressure') {
        return pick([
          'Контекст есть. Но мне надо это объяснить наверх — в двух предложениях, без pitch. Что именно ваша зона?',
          'Понял контекст. Что я говорю руководству: почему Mellow, что берёт на себя, что нет — коротко?',
        ]);
      }
      // audit-focused / explainability-first (default)
      return pick([
        'Хорошо, контекст finance operations вы увидели. Что именно вы контролируете в цепочке, а что остаётся на стороне клиента?',
        'Ок, контекст понял. Что конкретно в вашей зоне, а что нет? Мне нужны границы, не декларации.',
        'Контекст вы знаете. Тогда прямо: что именно в зоне Mellow, что у меня — документы, сверка, аудит?',
        'Хорошо. Только без общих слов. Что именно вы контролируете, что нет — конкретика по цепочке.',
      ]);
    }
    return pick([
      'Ок, контекст вы хотя бы увидели. Тогда сразу: что именно Mellow контролирует, а где ваша ответственность заканчивается?',
      'Нормально. Сразу к делу: что именно в вашей зоне, а что — нет? Платёжная цепочка, документы, НДФЛ?',
      'Хорошо. Тогда без лирики: что Mellow контролирует, что не контролирует, и чем это подтверждается?',
      'Ладно, контекст есть. Но пока не понятно, что именно вы берёте на себя. Граница?',
      'Вижу, что подготовились. Сразу вопрос: платёжная цепочка, документы, KYC — что в вашей зоне, что нет?',
      'Ок. Чем быстрее объясните границу ответственности, тем быстрее станет понятно, есть ли разговор.',
    ]);
  }

  // Seller proposing next step — close if concerns mostly covered
  if (hasAny(lower, ['созвон', 'звон', '15 минут', '20 минут', 'follow', 'материал', 'расч', 'memo'])) {
    if (session.meta._memo_requested) {
      return pick([
        'Жду материалы. Когда скинете?',
        'Договорились. Жду письмо.',
        'Хорошо. Присылайте — посмотрю.',
      ]);
    }
    session.meta._memo_requested = true;
    return respondFinanceNextStep(persona, claims, trust);
  }

  // Check if seller jumped ahead to a future concern — give partial credit and keep asking active one
  const order = session.meta.concern_order || [];
  const resolved = session.meta.resolved_concerns || {};
  for (const futureConcern of order) {
    if (!resolved[futureConcern] && futureConcern !== getActiveConcern(session) && sellerAdvancesConcern(futureConcern, lower)) {
      session.meta.resolved_concerns = { ...resolved, [futureConcern]: 'partial' };
    }
  }

  const concern = getActiveConcern(session);
  return respondFinanceByConcern(concern, session, persona, lower, claims, trust, irritation);
}

function respondFinanceNextStep(persona, claims, trust) {
  if (persona.id === 'cfo_round') {
    return pick([
      'Хорошо. Пришлите коротко flow, audit story и что именно упростится перед diligence. Если там без магии, выделю 20 минут на неделе.',
      'Ок. Скиньте flow и audit story — кратко, без лирики. Если это приземлено, можем поговорить 20 минут.',
      'Пришлите written summary: что в зоне Mellow, что нет, как это выглядит перед diligence. Если аккуратно — найдём 20 минут.',
      'Ладно. Скиньте flow, SLA и как audit story выглядит для следующего investor round. Если реально — найдём время.',
    ]);
  }
  if (persona.id === 'head_finance') {
    return pick([
      'Ок. Скиньте коротко flow, SLA и как сокращается ручная сверка. Если это приземлённо, выделю слот на неделе.',
      'Хорошо. Пришлите flow и SLA одним экраном. Если без воды, найдём 20 минут.',
      'Пришлите summary: flow, SLA и что убирается из ручной сверки. Если реально — созвонимся.',
      'Нормально. Скиньте flow и конкретно сколько убирается из ручного reconciliation. Если цифры реальные — выделю время.',
    ]);
  }
  return pick([
    'Хорошо. Пришлите коротко структуру потока, SLA и пример расчёта. Если это выглядит приземлённо, выделю 20 минут на неделе.',
    'Ок. Структуру потока и SLA — кратко. Если реальные цифры, а не шаблон, выделю 20 минут.',
    'Нормально. Скиньте flow, SLA и один конкретный кейс. Если без воды — найдём время.',
    'Ладно. Flow, SLA и что происходит при инциденте — одним экраном. Если реально — созвонимся.',
    'Пришлите memo: flow, зона контроля, SLA. Если без лишних обещаний — найдём 20 минут.',
  ]);
}

function respondFinanceByConcern(concern, session, persona, lower, claims, trust, irritation) {
  if (concern === 'scope') {
    if (irritation >= 2) {
      return pick([
        'Всё равно не слышу, где ваша зона заканчивается.',
        'Ещё раз: что именно в зоне Mellow? Без деклараций.',
        'Стоп. За что вы отвечаете, за что нет?',
        'Граница ответственности. Три раза уже прошу. Где она?',
        'Не слышу чёткого ответа. Платёжная цепочка — ваша или моя?',
      ]);
    }
    if (trust >= 2) {
      return pick([
        'Ладно, это уже ближе. Что конкретно Mellow берёт на себя — документы, платёжная цепочка, что ещё?',
        'Хорошо, начинаю понимать вашу зону. А что именно не берёте на себя — что остаётся у меня?',
        'Это уже аккуратнее. Значит, документы и KYC — ваши. Что ещё? И что конкретно остаётся на нас?',
        'Ок, зона вырисовывается. Тогда уточните: а что именно Mellow не покрывает — где заканчивается контроль?',
      ]);
    }
    if (persona.id === 'cfo_round') {
      return pick([
        'Всё ещё не слышу чёткой зоны. Что конкретно в зоне Mellow перед diligence — docs, платёжная цепочка, что ещё?',
        'Вернёмся к зоне. Что именно Mellow берёт на себя, а что остаётся у меня?',
        'Для diligence мне нужно знать точно: что у вас под контролем, что у меня. Без размытых формулировок.',
        'Инвестор будет спрашивать. Что именно вы можете показать как structured — docs, KYC, пейаут trail?',
      ]);
    }
    if (persona.id === 'head_finance') {
      return pick([
        'Вы не ответили на вопрос про зону. Что именно в вашем контроле, что нет?',
        'Снова про границу: что Mellow контролирует, а что остаётся на стороне клиента?',
        'Мне нужно объяснять это leadership. Что именно ваша зона — документы, сверка, НДФЛ?',
        'Неясная граница — это проблема при аудите. Что конкретно в зоне Mellow, что у меня?',
      ]);
    }
    return pick([
      'Я уже спрашивал. Что именно Mellow контролирует, а где ваша ответственность заканчивается?',
      'Не услышал ответа. Платёжная цепочка, документы, KYC — что в вашей зоне, что нет?',
      'Ещё раз: зона контроля Mellow — что конкретно, без деклараций?',
      'Хорошо, контекст понял. Но граница ответственности ещё не прозвучала. Что в вашей зоне?',
      'Это всё звучит правильно. Но пока не понятно, где ваша ответственность заканчивается.',
      'Половина ответа есть. Вторая: что именно вы не берёте — где моя сторона начинается?',
    ]);
  }

  if (concern === 'why_change') {
    if (persona.id === 'cfo_round') {
      return pick([
        'Это ближе. Но следующий раунд — не завтра. Зачем мне менять схему сейчас, если текущая не взорвалась?',
        'Слышу. Но текущая схема как-то держится. Что конкретно сломается без Mellow — и когда?',
        'Текущая схема кривая, но живёт. Что именно не выдержит следующего diligence без изменений?',
        'Понял. Но инвестор смотрит на риск, а не на vendor. Почему текущая схема — это риск, а Mellow его убирает?',
      ]);
    }
    if (claims.days) {
      return pick([
        `Вы упоминали задержку в ${claims.days} — это конкретно. Но зачем мне менять схему целиком, если такое случилось один раз?`,
        `${claims.days} задержки — слышал. Это системная проблема или разовый инцидент? Почему Mellow это исправит?`,
        `${claims.days} — это факт, хорошо. Но текущий посредник тоже потом закрыл вопрос. Почему это системная проблема?`,
      ]);
    }
    if (irritation >= 2) {
      return pick([
        'Ещё раз: текущая схема как-то живёт. Что конкретно сломается без Mellow?',
        'Уже спрашивал. Почему именно сейчас? Что не работает?',
        'Третий раз прошу. Зачем менять схему, которая пусть плохо, но работает?',
      ]);
    }
    return pick([
      'Это уже ближе к делу. Но зачем мне менять текущего посредника, если схема пусть криво, но работает годами?',
      'Текущая схема живёт года три. Что конкретно сломается без Mellow?',
      'Ближе. Но пока не вижу, почему это критично именно сейчас, а не через полгода.',
      'Допустим. Но у нас уже работает схема — не идеальная, но предсказуемая. Зачем менять?',
      'Понял контекст. Но зачем рисковать переходом, если текущее "как-то работает"?',
    ]);
  }

  if (concern === 'sla') {
    if (persona.id === 'head_finance') {
      return pick([
        'Допустим. А если платёж застрянет или документ не тот — как это выглядит операционно с моей стороны?',
        'Ок. А если что-то пойдёт не так — есть SLA или это тоже общие обещания?',
        'Мне надо это объяснять вверх. Есть ли SLA по инцидентам — конкретные часы, кто отвечает?',
        'Кто ведёт инцидент, если платёж завис? Мне нужны имена и сроки, не декларации.',
      ]);
    }
    if (irritation >= 2) {
      return pick([
        'Сбой. Платёж завис. Что дальше? Кто, в каком сроке?',
        'Операционно — что происходит при инциденте? Конкретика.',
        'Сценарий: платёж завис на три дня. Мои действия? Ваши действия?',
        'Не хочу общих ответов. Инцидент — конкретный процесс, конкретные сроки.',
      ]);
    }
    return pick([
      'Допустим. А если платёж снова застрянет, что у вас происходит операционно? Есть SLA или это тоже общие обещания?',
      'Понял. Но конкретно: если платёж повиснет на неделю, что происходит? Кто эскалирует, в каком сроке?',
      'Хорошо. Когда всё хорошо, схемы работают. Что происходит, когда нет? Операционно, шаг за шагом.',
      'Допустим, всё работает как описано. Теперь другой сценарий: платёж завис, документ потерян. Что происходит?',
      'Мне важно понять не ideal path, а failure path. Что происходит при инциденте — кто, что, за сколько?',
      'SLA — это не только обещание, это процесс. Есть ли у вас конкретный escalation path при сбое?',
    ]);
  }

  if (concern === 'geo_tax') {
    if (persona.id === 'cfo_round') {
      return pick([
        'И отдельно: contractor docs, НДФЛ и как это объясняется следующему инвестору на diligence?',
        'Ещё: как выглядит audit story по contractor docs и НДФЛ для будущего инвестора?',
        'Инвестор спросит про contractor classification в РФ. Как Mellow помогает с этим нарративом?',
        'Отдельный вопрос: у нас подрядчики с РФ-паспортами. Что именно вы делаете с НДФЛ и классификацией?',
      ]);
    }
    return pick([
      'И отдельно, как вы работаете с НДФЛ и выплатами по людям с российским паспортом? Мне нужна граница, а не витрина.',
      'Ещё вопрос: как работает ваша схема для подрядчиков с российскими паспортами? Что в вашей зоне по налогам?',
      'Отдельно по НДФЛ и РФ-паспортам: что именно вы берёте на себя, что остаётся у меня?',
      'Половина команды с РФ-паспортами. Это не абстракция. Что именно Mellow делает с НДФЛ в такой конфигурации?',
      'Geo-риск — это отдельная история. Как вы работаете с подрядчиками из санкционных или серых юрисдикций?',
    ]);
  }

  // All concerns resolved — push for next step or fall through
  if (irritation >= 2) {
    return pick([
      'Не убедительно. Где конкретика по документам, зоне контроля и следующему шагу?',
      'Опять без конкретики. Что именно меняется в моём процессе?',
      'Декларации слышу. Механизмы — нет. Что реально меняется?',
    ]);
  }
  return pick([
    'Я пока не услышал достаточно конкретики. Что именно вы меняете в процессе, кроме красивых слов про compliance?',
    'Пока много деклараций. Что конкретно меняется в моём процессе, в каком сроке?',
    'Не убедительно. Где конкретика по документам, зоне контроля и следующему шагу?',
    'Всё звучит правильно. Но правильные слова — не аргумент. Что конкретно изменится?',
    'Слышу слова про надёжность. Где механизм — что именно становится лучше и как это проверяется?',
  ]);
}

// ==================== OPS RESPONSES ====================

function respondOps(session, sellerText) {
  const lower = sellerText.toLowerCase();
  const turn = session.meta.bot_turns || 0;
  const wordCount = countWords(sellerText);
  const claims = session.meta.claims || {};
  const persona = personaMeta(session);
  const trust = session.meta.trust || 1;
  const irritation = session.meta.irritation || 0;

  if (turn === 1 && persona.id === 'panic_churn_ops') {
    return pick([
      'Хорошо, тогда без защиты прошлого. Что именно в вашей новой схеме гарантирует, что людей снова не поставят перед фактом?',
      'Если идти дальше, мне нужен не общий recovery tone, а конкретный incident and comms path. Как он выглядит?',
      'Ок. Но trust возвращается не словами. Что именно вы меняете в предупреждении людей, обновлениях и handling инцидентов?',
    ]);
  }
  if (turn === 1 && persona.id === 'cm_winback') {
    return pick([
      'Если это правда другой fit, то покажите узко: для какого именно slice вы вообще видите CM релевантным сейчас?',
      'Хорошо. Но мне не нужен broad comeback story. Где конкретно у нас changed fit, если смотреть на roster today?',
      'Ок, тогда без общих слов. Какая часть нашей текущей структуры вообще делает CM релевантным, а не просто возможным?',
    ]);
  }
  if (turn === 1 && persona.id === 'grey_pain_switcher') {
    return pick([
      'Это уже ближе. Теперь скажите через границы: что именно у вас в зоне ответственности, а где buyer всё ещё остаётся на своём риске?',
      'Хорошо, но безопасность для меня теперь не абстракция. Как выглядит ваш clean process, если случается инцидент или вопрос от банка?',
      'Ок. Тогда не обещания, а mechanics: кто у вас держит документы, payout flow, incident trail и где ваша граница заканчивается?',
    ]);
  }
  if (turn === 1 && persona.id === 'direct_contract_transition') {
    return pick([
      'Нормально. Теперь вопрос практический: как вы бы сузили это до пилота, не втягивая весь roster в relaunch?',
      'Хорошо, но меня интересует только narrow fit. Какой минимальный slice имеет смысл перевести, чтобы проверить гипотезу без большого процесса?',
      'Ок. Тогда не в общем, а в дизайне пилота: как это выглядит для узкой части структуры, а не для всей компании?',
    ]);
  }
  if (turn === 2 && persona.id === 'panic_churn_ops') {
    return pick([
      'Хорошо. Пришлите короткий recovery plan: кто предупреждает об изменениях, как выглядит incident path, и что именно видят люди до того, как начнётся новая паника. Если это внятно, тогда обсудим дальше.',
      'Ок. Следующий шаг только в таком формате: короткая схема предупреждения людей и handling инцидентов. Если там снова общие слова, на этом остановимся.',
      'Тогда покажите это как written recovery flow, а не как обещание. Если flow снимает повторение прошлой боли, разговор можно продолжить.',
    ]);
  }
  if (turn === 2 && persona.id === 'cm_winback') {
    return pick([
      'Хорошо. Тогда следующим шагом дайте узкий mapping: какой именно non-RU/BY или direct-contract slice вы бы смотрели первым. Если fit правда узкий и понятный, можно короткий call.',
      'Ок. Не comeback story, а конкретный slice map. Если вы можете быстро показать, где именно CM fit появился сейчас, это уже повод на короткий разговор.',
      'Тогда пришлите короткое описание узкого сценария: какой slice, почему fit появился сейчас, и почему это не broad relaunch. Если логика чистая, обсудим дальше.',
    ]);
  }

  // Hard length enforcement — ops personas push back immediately on wall-of-text
  const lengthLimit = persona.id === 'eng_manager' ? 65 : 50;
  if (wordCount > lengthLimit) {
    return persona.id === 'ops_manager'
      ? pick([
          'Слишком длинно. В чём апгрейд для меня, одной-двумя фразами?',
          'Много букв. Я живу процессами, не питчами. Одна фраза про апгрейд.',
        ])
      : pick([
          'Слишком длинно. В чём апгрейд для меня, одной-двумя фразами?',
          'Кратко. Что именно меняется для меня?',
          'Коротко, пожалуйста. Суть в одном предложении.',
        ]);
  }

  // Turn 0: context check
  if (turn === 0) {
    if (persona.id === 'panic_churn_ops') {
      return pick([
        'У нас вопрос не в цене. После вашей поздней bank/compliance коммуникации люди реально запаниковали. Почему я должна снова вам доверять?',
        'Вы тогда создали внутреннюю панику. Если говорить дальше, то только про то, что именно теперь не повторится.',
        'Для нас это был trust failure, а не просто process issue. Что именно вы теперь делаете иначе?',
      ]);
    }
    if (persona.id === 'cm_winback') {
      return pick([
        'Мы уже проходили с вами неприятный цикл. В чём сейчас реально другой use case, а не тот же разговор под новым названием?',
        'Если это просто попытка вернуть нас в старую историю, то смысла нет. Что именно изменилось в fit?',
        'Я не хочу обсуждать возврат ради возврата. Почему сейчас вообще релевантно снова открывать разговор?',
      ]);
    }
    if (persona.id === 'grey_pain_switcher') {
      return pick([
        'После серого провайдера я больше не покупаю слово compliance. Чем вы реально безопаснее, а не просто дороже?',
        'У нас уже была боль от небезопасной схемы. Кто у вас за что отвечает, если что-то идёт не так?',
        'Мне нужен не compliance-слоган, а понятная граница ответственности. В чём она у вас?',
      ]);
    }
    if (persona.id === 'direct_contract_transition') {
      return pick([
        'Мы не ищем широкий restart. Какой именно slice roster вы считаете релевантным для нового контура и почему?',
        'Если это реально про changed workforce mix, то скажите узко: для какой части структуры это вообще practically useful?',
        'Мне не нужен ещё один общий vendor pitch. В чём конкретный fit для нашего changed roster?',
      ]);
    }
    if (hasAny(lower, ['санк', 'compliance', 'комплаенс', 'юрид']) && persona.id !== 'eng_manager') {
      return pick([
        'Compliance не моя главная боль. Где реальный операционный апгрейд?',
        'Это не мой язык. Мне нужен процесс, а не legal framing.',
        'Не надо про compliance. Что именно убирается из моей ручной работы?',
        'Legal не моя сторона. Что именно убирается из ежедневной координации?',
        'Compliance — это не то, где болит. Где операционный апгрейд для меня?',
      ]);
    }
    if (!hasAny(lower, ['wise', 'crypto', 'задерж', 'ручн', 'ops', 'выплат', 'эскалац', 'команд'])) {
      if (persona.id === 'ops_manager') {
        return pick([
          'Пока похоже на обычный pitch. Что вы увидели у нас конкретно?',
          'Это стандартный заход. Что именно у нас происходит, что вас привело?',
          'Не видно конкретики про нас. Чем ваш питч отличается от других двадцати?',
          'Такое мне пишут каждую неделю. Что именно вы знаете про нашу операционную ситуацию?',
          'Слишком общо. Что конкретно у нас сломано, что вы решаете?',
        ]);
      }
      if (persona.id === 'eng_manager') {
        return pick([
          'Пока похоже на обычный pitch. Что вы увидели у нас конкретно?',
          'Видел уже такие сообщения. Что именно вы знаете про нашу ситуацию?',
          'Стандартный заход. Что конкретно у нас происходит с payments?',
          'Без конкретики это просто ещё один vendor. Что именно вы знаете про нас?',
        ]);
      }
      return pick([
        'Пока похоже на обычный pitch. Что вы увидели у нас конкретно?',
        'Звучит как template. Что у нас конкретно зацепило?',
        'Ещё один vendor-питч. Что именно у нас происходит — что вы видели до отправки?',
        'Слишком общо. Что конкретно у нас болит?',
      ]);
    }
    if (persona.id === 'eng_manager') {
      const emSeed = session.meta.persona_seed || 'champion-potential';
      if (emSeed === 'tired-escalator') {
        return pick([
          'Устал быть прокладкой между finance и contractors. Если это реально снимает ручные эскалации — что именно убирается и за сколько?',
          'У меня уже три квартала ручные разруливания выплат. Если это реально снимает ручной слой — конкретно как это выглядит?',
        ]);
      }
      if (emSeed === 'skeptical-vendor') {
        return pick([
          'Слышал такое раньше. Предыдущий vendor обещал то же самое и не поехал. Что у вас конкретно другое — операционно?',
          'Это стандартный pitch. Что именно у Mellow другое — не в словах, а в механике?',
        ]);
      }
      if (emSeed === 'bridge-seeker') {
        return pick([
          'Finance помнит прошлый vendor, который не поехал. Как объяснить им, что это другой разговор?',
          'Мне надо занести это в finance — как вы помогаете строить кейс без enterprise theatre?',
        ]);
      }
      // champion-potential (default)
      return pick([
        'Нормально. Но у меня уже был один vendor, который обещал то же самое. Почему это другой разговор?',
        'Проблему вы угадали. Но мне надо донести это до finance — как вы мне в этом поможете?',
      ]);
    }
    if (persona.id === 'ops_manager') {
      const opsSeed = session.meta.persona_seed || 'chaos-averse';
      if (opsSeed === 'time-poor') {
        return pick([
          'У меня десять минут. Что конкретно убирается из дня — одной фразой?',
          'Нет времени на долгий pitch. Одно предложение: что именно перестаю делать руками?',
        ]);
      }
      if (opsSeed === 'process-fatigued') {
        return pick([
          'Ещё один vendor. Что именно убирается из процесса — не слова, а конкретный шаг?',
          'Слышала подобное прежде. Что конкретно меняется в моём ежедневном процессе?',
        ]);
      }
      // chaos-averse / results-oriented (default)
      return pick([
        'Нормально. Тогда коротко: что именно упростится у меня в ежедневной координации?',
        'Ок. Я слышу это каждый раз. Что конкретно убирается из моего дня — сколько часов, какие шаги?',
        'Ладно. Конкретно: что перестаю делать я руками, если ставим Mellow?',
        'Хорошо, видите боль. Но у меня таблица уже работает — что именно убирается?',
        'Правильно угадали. Но мне важно: что именно станет предсказуемее — платежи, статусы, что?',
      ]);
    }
    // Alexey seed-specific T1 phrasing
    const alexeySeed = session.meta.persona_seed || 'pragmatist';
    if (alexeySeed === 'speed-freak') {
      return pick([
        'Ок, коротко. Что конкретно убирается из ручного — одной фразой?',
        'Слышу. Но быстро: что реально меняется для меня завтра, если ставим Mellow?',
      ]);
    }
    if (alexeySeed === 'exec-compressed') {
      return pick([
        'Не надо про compliance. Что именно убирается из моей ручной работы?',
        'Скинь flow на один экран, без pitch. Что реально убирается — часы, шаги?',
      ]);
    }
    // pragmatist / semi-open / default — status-quo anchored
    return pick([
      'Хорошо. Но crypto + Wise работает уже два года. Почему именно сейчас мне это нужно?',
      'Понял. А что реально сломается, если я ничего не меняю?',
      'Контекст понял. Но пока работает — зачем менять? Что конкретно это разблокирует?',
      'Ок. Если коротко — зачем мне менять то, что и так как-то держится?',
    ]);
  }

  // Seller proposing next step
  if (hasAny(lower, ['созвон', 'звон', '15 минут', '20 минут', 'follow', 'материал', 'кейс', 'расч'])) {
    if (session.meta._memo_requested) {
      return pick([
        'Жду материалы. Когда скинете?',
        'Договорились. Жду письмо.',
        'Хорошо. Присылайте — посмотрю.',
        'Присылайте. Если конкретно — отвечу.',
      ]);
    }
    // Gate: if trust is very low and early in the conversation, push back before accepting
    if (trust < 1.5 && (session.meta.bot_turns || 0) < 2) {
      const activeConcern = getActiveConcern(session);
      if (activeConcern === 'vendor_fatigue') {
        return pick([
          'Рано. Вы ещё не убедили меня, что это не очередной vendor. Сначала этот вопрос.',
          'Подождите. Я ещё не понял, чем вы отличаетесь. Не пойдём дальше без этого.',
        ]);
      }
      if (activeConcern === 'internal_sell') {
        return pick([
          'Не торопитесь. Я ещё не понял, как это объяснять finance. Сначала этот вопрос.',
          'Рано. Без материала для finance я никуда не пойду с этим.',
        ]);
      }
    }
    session.meta._memo_requested = true;
    return respondOpsNextStep(persona, claims, trust, getActiveConcern(session));
  }

  // Check for jumped-ahead concerns
  const order = session.meta.concern_order || [];
  const resolved = session.meta.resolved_concerns || {};
  for (const futureConcern of order) {
    if (!resolved[futureConcern] && futureConcern !== getActiveConcern(session) && sellerAdvancesConcern(futureConcern, lower)) {
      session.meta.resolved_concerns = { ...resolved, [futureConcern]: 'partial' };
    }
  }

  const concern = getActiveConcern(session);

  // Alexey CBE: express loss aversion / switching-cost reasoning once at turn 1-2
  if (persona.id === 'alexey' && turn >= 1 && turn <= 2 && !session.meta._alexey_cbe_done) {
    if (Math.random() > 0.4) {
      session.meta._alexey_cbe_done = true;
      return pick([
        'Я уже инвестировал год в текущую схему — что именно теряю, если подожду ещё квартал?',
        'Перестраивались под Wise + crypto год назад. Переключение тоже стоит времени команды. Что именно перевешивает прямо сейчас?',
        'Слышу. Но текущий процесс — кривой, но предсказуемый. Сколько времени уйдёт на переход, и кто его тащит?',
        'Смотри, текущая схема стоила нам года настройки. Что именно сломается через квартал, если я ничего не меняю?',
      ]);
    }
  }

  // ops_manager CBE: process-investment cost / loss-aversion framing — first wave at turns 1-2
  if (persona.id === 'ops_manager' && turn >= 1 && turn <= 2 && !session.meta._ops_cbe_done) {
    const opsSeed = session.meta.persona_seed || 'chaos-averse';
    if (Math.random() > 0.25) {
      session.meta._ops_cbe_done = true;
      if (opsSeed === 'process-fatigued') {
        return pick([
          'Слушай, я понимаю умом, что это правильно. Но у меня уже был переход на новый vendor год назад — три месяца потеряли. И команда это помнит. Почему это будет короче?',
          'Логически ясно зачем. Но внутри я знаю: каждый переход стоит дороже, чем обещали. Что конкретно делает этот переход другим по стоимости для ops?',
        ]);
      }
      if (opsSeed === 'time-poor') {
        return pick([
          'Я уже потратила время на выстраивание текущего процесса. Переход — это тоже инвестиция. Что именно окупает это прямо сейчас?',
          'Ты говоришь дело. Но время на настройку — не абстракция, это мои часы и часы команды. Кто это держит во время перехода?',
        ]);
      }
      return pick([
        'Текущая схема — кривая, но я её знаю. Переход на новый vendor — это время, настройка, риск сбоев. Что конкретно стоит этих затрат?',
        'Мы уже несколько раз переделывали ops-процесс. Каждый раз — стоимость. Почему это не очередная переделка впустую?',
        'Текущий процесс плохой, но предсказуемый. Что именно сломается, если я ещё квартал ничего не трогаю?',
        'Я уже строила процессы под разных вендоров. Один раз — хорошо, дважды — дорого, трижды — политическая проблема. Почему этот другой?',
        'Если переход не взлетит — я за это отвечу. Не vendor. Что конкретно снижает мой риск здесь?',
        'Смотри: текущая схема работает на 60%. Новая может работать на 90% — но сначала будет на 30%, пока мы настраиваемся. Что гарантирует, что кривая короткая?',
        'Понимаю логику. Но честно: у меня в голове срабатывает "менять то, что хоть как-то работает — опасно". Чем именно ты это перевешиваешь?',
        'Слышу. Только я трижды уже меняла инструменты — и каждый раз казалось, что этот точно лучше. Чем ты убеждаешь меня, что это последний раз?',
      ]);
    }
  }
  // ops_manager CBE second wave: status quo bias + sunk-cost — once at turns 3-4
  if (persona.id === 'ops_manager' && turn >= 3 && turn <= 4 && !session.meta._ops_cbe2_done) {
    if (Math.random() > 0.4) {
      session.meta._ops_cbe2_done = true;
      return pick([
        'Подожди. Ты только что хорошо ответил. Но у меня всё равно ощущение: если я ничего не трогаю — ничего и не сломается. Почему сейчас именно?',
        'Слышу логику. Но внутри у меня включается: менять то, что хоть как-то работает — всегда рискованнее, чем кажется. Чем ты это перевешиваешь?',
        'Мне нравится то, что ты говоришь. Но есть момент: каждое изменение в ops — это я трачу своё политическое топливо. Ты уверен, что это стоит затраты?',
        'Слышу аргументы. Но я уже вложила время в то, что есть — и менять это снова тяжело не потому что не вижу смысла, а потому что смены уже были. Что делает этот переход финальным?',
        'Логика есть. Но что-то внутри говорит: "если бы это было так легко — мы бы уже это сделали". Почему мы не сделали раньше, и что изменилось?',
      ]);
    }
  }

  // eng_manager CBE: past-vendor-failure anchoring — first wave at turns 1-2, second wave at turns 3-4
  if (persona.id === 'eng_manager' && turn >= 1 && turn <= 2 && !session.meta._eng_cbe_done) {
    const emSeed2 = session.meta.persona_seed || 'champion-potential';
    if (Math.random() > 0.25) {
      session.meta._eng_cbe_done = true;
      if (emSeed2 === 'tired-escalator') {
        return pick([
          'Понимаю логику. Но у меня уже был vendor, которого я продавал внутри — не взлетел, и я полгода объяснял почему. Это создаёт предвзятость. Почему здесь риск другой?',
          'Слышу. Только я знаю: следующий раз, когда я захожу с vendor к finance — это уже не первый раз. И они помнят прошлый. Что делает этот питч короче?',
        ]);
      }
      if (emSeed2 === 'skeptical-vendor') {
        return pick([
          'У нас уже был vendor, которого я сам занёс в finance. Не взлетел — и я за это ответил. Почему этот разговор другой?',
          'Мы уже выбирали похожий инструмент полтора года назад. Внедряли три месяца. Потом выбросили. Почему сейчас иначе?',
        ]);
      }
      return pick([
        'Я уже один раз продавал внутри похожую идею. Потратил политический капитал, не получил результат. Что именно гарантирует, что это другой случай?',
        'После последнего vendor-провала finance стал скептичнее. Мне нужно быть уверенным, прежде чем снова выходить с этим. Что у вас конкретно другое?',
        'Я несу ответственность за то, что занёс внутрь. Если снова не взлетит — это уже не vendor проблема, это моя репутация. Почему этот vendor надёжен?',
        'Каждый раз, когда я захожу с внешним vendor-решением в engineering, команда ждёт, когда я это объясню finance. Это стоимость. Почему она стоит?',
        'Смотри: мне нужно объяснить это двум аудиториям — finance и моей команде. Если объяснение провалится хотя бы у одной — провалится всё. Что именно делает его убедительным?',
        'Понимаю умом, что есть смысл. Но у меня уже срабатывает: "снова vendor, снова обещания". Это иррационально — но реально. Чем именно это другой случай?',
        'Хочу верить. Но мозг автоматически достраивает: "а что если снова облажается". Это не недоверие лично к вам — это паттерн. Есть что-то конкретное, что прерывает его?',
      ]);
    }
  }
  // eng_manager CBE second wave: confirmation bias / anchoring to prior failure — once at turns 3-4
  if (persona.id === 'eng_manager' && turn >= 3 && turn <= 4 && !session.meta._eng_cbe2_done) {
    if (Math.random() > 0.4) {
      session.meta._eng_cbe2_done = true;
      return pick([
        'Ты говоришь убедительно. Но у меня в голове всё ещё история с прошлым vendor — она мешает. Что именно в вашей модели другое по структуре, не по словам?',
        'Логика понятна. Но я автоматически сравниваю с тем, что было год назад — и вижу похожие обещания. Где конкретное отличие по факту?',
        'Хорошо. Последний вопрос с моей стороны: если через полгода это не работает — что происходит? Как выглядит ваша ответственность в этом сценарии?',
        'Слышу и почти верю. Но есть момент: я знаю, что мозг ищет подтверждение тому, во что уже верю. Если я сейчас скептичен — это паттерн, не факт. Дай мне один объективный показатель, который не зависит от того, хочу ли я это слышать.',
        'Аргументы звучат хорошо. Но у меня якорь: полтора года назад мы тоже думали, что нашли решение. Что именно в вашей механике принципиально другое — не в pitch, а в том, как это работает?',
      ]);
    }
  }

  return respondOpsByConcern(concern, session, persona, lower, claims, trust, irritation);
}

function respondOpsNextStep(persona, claims, trust, activeConcern) {
  if (persona.id === 'eng_manager') {
    // concern-specific next steps for eng_manager
    if (activeConcern === 'vendor_fatigue') {
      return pick([
        'Ладно. Пришли конкретный материал, который объясняет, чем Mellow структурно отличается от того, что у нас уже не взлетело. Не pitch — факты по механике.',
        'Скинь comparison: что именно Mellow делает иначе по факту, а не по словам. Если там есть что-то, что можно проверить — занесу в finance.',
        'Ок. Один вопрос после всего разговора: можешь дать мне кейс с похожей командой, где это реально работает? Конкретный, не абстрактный.',
      ]);
    }
    if (activeConcern === 'internal_sell') {
      return pick([
        'Ладно. Мне нужно что-то, что я могу показать команде без долгих объяснений. Одностраничник: что убирается, что остаётся, какой следующий шаг. Можешь?',
        'Пришли pilot proposal — не pitch. Что именно тестируем, в каком сроке, как измеряем. Если разумно, смогу занести.',
        'Скинь короткое письмо для finance — только факты: что меняется, что убирается из ручных эскалаций и что нужно от них.',
      ]);
    }
    return pick([
      'Ок. Скинь короткий follow-up, который я реально смогу перекинуть в finance: что меняется, что убирается из ручных эскалаций и какой следующий шаг.',
      'Нормально. Пришли короткое письмо или слайд для finance: что меняется, что убирается, что нужно от них.',
      'Ок. Скинь материал для finance — одним экраном. Если там нет лишней воды, могу внутри показать.',
      'Скинь follow-up с конкретным before/after для нашей ситуации с эскалациями. Если там реальные цифры — могу занести в finance.',
      'Ок. Мне нужен один конкретный сценарий: как выглядит наша ситуация с эскалациями через Mellow через месяц. Один реальный пример. Пришли.',
    ]);
  }
  if (persona.id === 'ops_manager') {
    // concern-specific next steps for ops_manager
    if (activeConcern === 'proof') {
      return pick([
        'Пришли реальный кейс — похожая команда по размеру и географии. Если это не фикция, поговорим.',
        'Скинь один конкретный пример, где это работает. Не общий референс — конкретный сценарий с цифрами.',
        'Ок. Кейс или пилот — ничего другого не убедит. Что можешь дать конкретно для нашего типа setup?',
      ]);
    }
    if (activeConcern === 'cost') {
      return pick([
        'Пришли короткий расчёт или хотя бы benchmark — что это стоит для нашего объёма. Без цифр разговора нет.',
        'Ладно. Скинь что-то по стоимости и условиям — без этого я не могу двигаться внутри.',
        'Ок. Что нужно от тебя: условия, примерная стоимость для нашего объёма, условия выхода. Одним письмом.',
      ]);
    }
    return pick([
      'Ок. Скинь короткий follow-up: как выглядит поток, что убирается из ручной возни и что нужно от моей ops. Если там без воды, можно созвониться.',
      'Нормально. Пришли flow и что именно исчезает у меня из ежедневного списка. Если реально, созвонимся.',
      'Ладно. Follow-up — кратко: поток, что убирается из ручного, следующий шаг. Без декораций.',
      'Скинь конкретный until-after для нашей ops: что делается сейчас вручную — что делает система после. Одним экраном.',
      'Хорошо. Пришли пример реального onboarding нового подрядчика через Mellow — шаги, ответственные, сроки. Если это похоже на правду, поговорим.',
      'Ок. Что мне нужно от тебя: не общий pitch, а конкретно — что убирается из моей еженедельной сверки. Пришли это одним абзацем.',
      'Давай так: скинь короткий trial proposal. Что тестируем, на каком объёме, как меряем. Если там нет кучи conditions — рассмотрю.',
    ]);
  }
  if (claims.tool) {
    const toolName = claims.tool.charAt(0).toUpperCase() + claims.tool.slice(1);
    return pick([
      `Ок. Скинь flow на один экран, и конкретно — что хуже ${toolName} и почему. Если реально убирает ручную возню, найдём 15 минут.`,
      `Понятно по ${toolName}. Пришли сравнение — что Mellow делает иначе по шагам, не по словам. Если конкретно — найдём время.`,
    ]);
  }
  return pick([
    'Ок. Скинь короткий follow-up: как выглядит поток, что убирается из ручной возни и что нужно от моей ops. Если там без воды, можно созвониться.',
    'Нормально. Скинь flow на один экран, и если реально убирает ручную возню — найдём 15 минут.',
    'Ок. Материал коротко — что меняется, что убирается, что нужно от меня. Без sales воды.',
    'Пришли короткий trial proposal с конкретным сценарием — что тестируем, как измеряем. Не pitch.',
  ]);
}

function respondOpsByConcern(concern, session, persona, lower, claims, trust, irritation) {
  if (concern === 'op_value') {
    if (irritation >= 2) {
      return pick([
        'Ещё раз: что именно убирается из моего дня?',
        'Конкретно — что я перестаю делать руками?',
        'Не слышу апгрейда. Одна фраза: что меняется для меня?',
        'Третий раз прошу. Что конкретно убирается — часы, шаги, чаты?',
        'Устал от общих слов. Что именно убираем из моего процесса?',
      ]);
    }
    if (trust >= 2) {
      return pick([
        'Это уже ближе. А конкретно — какой процесс исчезает, сколько времени это занимает сейчас?',
        'Слышу. Ещё конкретнее: что именно убирается из ежедневного списка?',
        'Хорошо. А по шагам: что сейчас делается вручную, что после Mellow делает система?',
        'Уже лучше. Дайте конкретный пример — что именно убирается из недели ops?',
      ]);
    }
    if (persona.id === 'eng_manager') {
      return pick([
        'Хорошо. А как это помогает мне занести разговор в finance без тяжёлого enterprise theatre?',
        'Ок. Но мне надо показать это финансистам. Что мне сказать им в двух предложениях?',
        'Слышу. А как это выглядит внутри для finance — мне надо провести разговор без лишнего геморроя.',
        'Интересно. Но finance надо убедить. Что им говорить — один слайд или письмо?',
        'Мне это нравится. Проблема в том, что я не тот, кто принимает решение. Как донести до finance?',
      ]);
    }
    if (claims.tool) {
      const toolName = claims.tool.charAt(0).toUpperCase() + claims.tool.slice(1);
      return pick([
        `Раз уже работаете с ${toolName} — значит, боль понятна. Что конкретно там не устраивает по скорости?`,
        `${toolName} вы уже упоминали. Что именно не работает — задержки, непредсказуемость, ручная возня?`,
        `Хорошо, ${toolName} упомянули. Что именно в нём ломается — задержки, статусы, что-то другое?`,
      ]);
    }
    if (persona.id === 'ops_manager') {
      return pick([
        'Нормально. Только не веди меня в долгий sales process. Что следующий шаг, чтобы быстро понять fit?',
        'Ок. Но у меня нет времени на долгий онбординг. Что нужно от меня, чтобы понять, работает ли это?',
        'Хорошо. Только быстро: что конкретно нужно от меня на следующий шаг?',
        'Понял. Мне нужно быстро проверить, подходит ли это. Есть пилот или демо?',
        'Ладно. Следующий шаг — что нужно от меня, чтобы понять fit за минимум времени?',
      ]);
    }
    return pick([
      'Нормально. Только не веди меня в долгий sales process. Что следующий шаг, чтобы быстро понять fit?',
      'Ладно. Как быстро можно проверить, подходит ли это под мой setup?',
      'Ок. Мне не нужна длинная история. Что следующий шаг — быстро?',
      'Слышу. Мне важна скорость проверки — как быстро можно убедиться, что это работает?',
      'Понял апгрейд. Как быстро это запускается? Что нужно от меня?',
    ]);
  }

  if (concern === 'vendor_fatigue') {
    if (irritation >= 2) {
      return pick([
        'Я уже слышал такие обещания. Почему Mellow — не очередной vendor?',
        'Это то же самое, что говорил предыдущий. Что конкретно другое?',
        'Третий vendor за год. Почему этот — не очередная прослойка?',
      ]);
    }
    if (persona.id === 'eng_manager') {
      return pick([
        'У меня уже был один vendor, который обещал снять ручные эскалации. Не снял. Чем Mellow отличается?',
        'Звучит как то, что мы уже пробовали. Что именно вы делаете иначе?',
        'Finance помнит прошлый vendor, который не поехал. Как мне объяснить им, что это другой разговор?',
        'Мне не хочется снова продавать finance идею, которая провалится. Почему эта не провалится?',
      ]);
    }
    return pick([
      'Я слышу это второй раз в этом квартале. Что конкретно отличает Mellow от предыдущего vendor?',
      'Похоже на то, что нам уже обещали. Что именно делается иначе?',
      'Уже пробовали похожее — не взлетело. Что у вас отличается операционно?',
      'Другой vendor давал те же обещания. Где разница в механике?',
    ]);
  }

  if (concern === 'proof') {
    if (irritation >= 2) {
      return pick([
        'Примеры. Кто у вас реально это использует? Один кейс.',
        'Не хочу теории. Кто похожий на нас — и как у них работает?',
        'Конкретный кейс, пожалуйста. Без этого — разговор ни о чём.',
      ]);
    }
    if (persona.id === 'ops_manager') {
      return pick([
        'Слышу правильные слова. Есть кейс похожей ops-команды — что убралось, что осталось?',
        'Хорошо. Кто из ops-команд с похожим масштабом это уже использует? Один пример.',
        'Мне нужно доказательство, что это работает в живой ops, а не только в питче.',
        'Пилот или кейс — что могу посмотреть, чтобы понять, работает ли это реально?',
      ]);
    }
    return pick([
      'Покажи один кейс: компания с похожей структурой, что убралось, что осталось.',
      'Есть ли реальный пример команды с похожим ops-setup? Что у них изменилось?',
      'Кейс или пилот — что есть? Не хочу верить на слово.',
      'Один конкретный пример из практики. Что убралось из ручной работы у похожей команды?',
    ]);
  }

  if (concern === 'internal_sell') {
    if (irritation >= 2) {
      return pick([
        'Finance не пропустит без аргументов. Что им сказать — конкретно?',
        'Уже спросил: как занести это в finance? Где материал?',
        'Третий раз: что говорить finance — слайд, письмо, что?',
      ]);
    }
    return pick([
      'Хорошо. А как мне занести это в finance? Что им показать — один слайд, письмо, что-то конкретное?',
      'Ок, меня устраивает. Но finance нужны аргументы. Что им сказать без enterprise theatre?',
      'Слышу. Только мне надо продать это внутри. Какой материал вы можете дать?',
      'Мне это нравится. Как помочь finance принять решение быстро — что им нужно видеть?',
      'Finance смотрит на ROI. Что конкретно им показать — во времени, в деньгах, в рисках?',
      'Ок. Что можете дать мне как internal champion — материал, который finance не нужно разжёвывать?',
    ]);
  }

  if (concern === 'cost') {
    if (persona.id === 'ops_manager') {
      return pick([
        'И сколько это стоит в деньгах или времени команды? Мне не нужна ещё одна ручная система поверх старой.',
        'И что это стоит реально? Не хочу менять один хаос на другой, более дорогой.',
        'Деньги — окей, но сколько это займёт времени у меня при настройке?',
        'Сколько стоит и как быстро запускается? Мне не нужен долгий onboarding.',
        'И последнее: цена. И сколько времени ops тратит на переход — это тоже стоимость.',
      ]);
    }
    return pick([
      'И сколько это будет стоить? Мне не нужна ещё одна прослойка ради прослойки.',
      'Понятно. А по деньгам как? Мне надо занести цифры в разговор с finance.',
      'И сколько? И конкретно: есть ли trial, или сразу контракт?',
      'Стоимость — и не только деньги. Сколько времени команды уйдёт на переход?',
      'По деньгам: цена, trial, условия. И: есть ли пилот до контракта?',
    ]);
  }

  // All resolved or none active
  return persona.id === 'ops_manager'
    ? pick([
        'Пока много слов. Где конкретный апгрейд по скорости, процессу или удобству?',
        'Не слышу конкретики. Что именно убирается из моего дня?',
        'Опять абстракции. Мне нужен конкретный процесс, не обещания.',
        'Правильные слова. Но мне нужна механика, не обещания.',
      ])
    : persona.id === 'eng_manager'
    ? pick([
        'Пока много слов. Где конкретный апгрейд по скорости, процессу или удобству?',
        'Звучит как другие пятнадцать vendor pitches. Что именно убирает ручные эскалации?',
        'Хорошо звучит. Но finance будет скептичен. Что конкретно им показать?',
      ])
    : pick([
        'Пока много слов. Где конкретный апгрейд по скорости, процессу или удобству?',
        'Пока нет конкретики. Что именно быстрее, дешевле или проще?',
        'Не слышу апгрейда. Одна фраза: что меняется для меня?',
        'Слова правильные. Но где конкретный процессный апгрейд?',
      ]);
}

// ==================== LEGAL RESPONSES ====================

function respondLegal(session, sellerText) {
  const lower = sellerText.toLowerCase();
  const turn = session.meta.bot_turns || 0;
  const persona = personaMeta(session);
  const trust = session.meta.trust || 1;
  const irritation = session.meta.irritation || 0;
  const flags = session.meta.flags || {};

  if (isMisclassificationBlocker(sellerText)) {
    session.meta.flags = { ...flags, blocker: true };
    return pick([
      'Если вы обещаете снять misclassification risk, на этом доверие заканчивается. Сформулируйте границу ответственности корректно.',
      'Это тот самый overclaim, который уничтожает доверие. Где именно заканчивается зона Mellow?',
    ]);
  }

  // Turn 0: context check
  if (turn === 0) {
    if (!hasAny(lower, ['audit', 'trail', 'документ', 'границ', 'ответствен', 'review', 'legal', 'traceability'])) {
      return pick([
        'Пока звучит как vendor pitch. Что именно вы увидели в legal context и как формулируете свою зону контроля?',
        'Слишком общо. Как именно вы формулируете зону своего контроля — что берёте на себя, что нет?',
        'Это похоже на стандартный vendor заход. Как вы определяете свою зону ответственности конкретно?',
        'Стандартный заход. Что именно у нас в legal context вас зацепило перед отправкой?',
        'Много слов, мало специфики. Как вы формулируете границу своей ответственности?',
        'Пока это звучит как общий pitch. Что именно вы знаете про наш contractor/document context?',
      ]);
    }
    if (persona.id === 'external_legal') {
      return pick([
        'Хорошо. Тогда сразу: что именно контролирует Mellow, что не контролирует, и где это подтверждается процессно?',
        'Ок. Тогда три вещи сразу: что в зоне Mellow, что не в зоне, и как это докажется на практике?',
        'Контекст видите. Сразу к делу: что именно в зоне Mellow, что нет, и как это подтверждается документами?',
        'Это аккуратно. Но мне нужны три вещи: что берёте, что не берёте, как подтверждается. Не декларации.',
      ]);
    }
    return pick([
      'Ок. Что именно Mellow даёт по documents, audit trail и process discipline, и где вы не делаете overclaim?',
      'Хорошо. Конкретно по documents и audit trail: что в зоне Mellow, и где заканчивается ваша ответственность?',
      'Контекст виден. Тогда прямо: документы, audit trail, границы ответственности — что именно в вашей зоне?',
      'Это уже ближе. Но мне важно: что именно вы контролируете, а что остаётся у клиента? Без overclaim.',
    ]);
  }

  // Seller proposing next step
  if (hasAny(lower, ['созвон', 'review', 'walkthrough', '15 минут', '20 минут', 'follow-up', 'memo', 'материал'])) {
    if (session.meta._memo_requested) {
      return pick([
        'Жду материалы. Когда скинете?',
        'Договорились. Жду письмо.',
        'Хорошо. Присылайте — посмотрю.',
        'Присылайте. Если там аккуратно — найдём время.',
      ]);
    }
    // Gate next-step acceptance on meaningful engagement: low-trust deflection before accepting
    if (trust < 1.5 && (session.meta.bot_turns || 0) < 2) {
      return pick([
        'Подождите. Вы ещё не ответили на мой вопрос про границы ответственности. Сначала это — потом next step.',
        'Рано. Я ещё не закончила с вопросами про зону контроля. Что именно Mellow берёт, что нет?',
        'Давайте сначала разберёмся с зонами — тогда я скажу, стоит ли двигаться дальше.',
      ]);
    }
    session.meta._memo_requested = true;
    return respondLegalNextStep(persona, trust, getActiveConcern(session));
  }

  // Check for jumped-ahead concerns
  const order = session.meta.concern_order || [];
  const resolved = session.meta.resolved_concerns || {};
  for (const futureConcern of order) {
    if (!resolved[futureConcern] && futureConcern !== getActiveConcern(session) && sellerAdvancesConcern(futureConcern, lower)) {
      // external_legal grey_zones requires direct engagement to fire the defensibility gate —
      // cannot be pre-resolved via jump-ahead partial credit
      if (persona.id === 'external_legal' && futureConcern === 'grey_zones') continue;
      session.meta.resolved_concerns = { ...resolved, [futureConcern]: 'partial' };
    }
  }

  const concern = getActiveConcern(session);
  return respondLegalByConcern(concern, session, persona, lower, trust, irritation);
}

function respondLegalNextStep(persona, trust, activeConcern) {
  if (persona.id === 'external_legal') {
    return pick([
      'Хорошо. Пришлите короткий written follow-up с зоной контроля, process safeguards и примером flow. Если формулировки аккуратные, подключусь на короткий review call.',
      'Ок. Пришлите письменное summary: что в зоне Mellow, что нет, process safeguards. Если аккуратно — можно созвониться.',
      'Пришлите memo: зона контроля, документы, safeguards, пример инцидента. Если формулировки чёткие — найдём 20 минут.',
      'Напишите summary без декораций: что берёте, что не берёте, как это подтверждается. Если аккуратно — созвонимся.',
    ]);
  }
  // internal_legal: concern-aware next steps (more plausible than generic memo-blast)
  if (persona.id === 'internal_legal') {
    if (activeConcern === 'scope') {
      return pick([
        'Ок. Пришлите одностраничный document с чёткой разбивкой зон: что Mellow, что наш legal, что у клиента — без overlap. Если там без overclaim, обсудим.',
        'Скиньте service boundary map или что-то похожее — конкретно где Mellow заканчивается. Если это читабельно — найдём 15 минут.',
        'Пришлите письменное описание ваших зон, которое я смогу положить рядом с нашим contractor template и увидеть, где они пересекаются. Тогда поговорим.',
      ]);
    }
    if (activeConcern === 'grey_zones') {
      return pick([
        'Пришлите схему: три слоя — Mellow, наш legal, наш finance — и где проходят границы. Если это реалистично, я покажу нашему compliance.',
        'Скиньте пример конкретного flow — как выглядит зона ответственности на практике, не в словах. Если там без пробелов — можем созвониться.',
        'Ок. Пришлите что-то, что я смогу взять внутрь как доказательство, что серых зон нет — схему, образец документа, flow. Без этого двигаться не могу.',
      ]);
    }
    if (activeConcern === 'incident') {
      return pick([
        'Пришлите incident playbook или хотя бы описание типичного кейса — кто что делает при сбое, в какой срок, с каким trail. Конкретно.',
        'Скиньте пример real incident — что произошло, как Mellow отреагировал, что было задокументировано. Без реального кейса двигаться нет смысла.',
        'Ок. Если есть письменный процесс инцидента — пришлите. Мне нужно понять, как это выглядит до того, как мы договоримся об исключениях.',
      ]);
    }
    // fallback if no active concern or resolved
    return pick([
      'Ок. Пришлите короткий memo: documents, audit trail, ограничения, процесс инцидента. Если это аккуратно, можно сделать короткий walkthrough.',
      'Хорошо. Скиньте summary: documents, audit trail, границы. Если там без overclaim, обсудим детали.',
      'Нормально. Memo с documents, trail и ограничениями — один экран. Если аккуратно, поговорим.',
      'Пришлите одностраничное summary: зона контроля, документы, SLA инцидента. Если без воды — найдём время.',
      'Скиньте memo: что именно в зоне Mellow, что нет, как выглядит audit trail. Если чётко — созвонимся.',
    ]);
  }
  return pick([
    'Ок. Пришлите короткий memo: documents, audit trail, ограничения, процесс инцидента. Если это аккуратно, можно сделать короткий walkthrough.',
    'Хорошо. Скиньте summary: documents, audit trail, границы. Если там без overclaim, обсудим детали.',
    'Нормально. Memo с documents, trail и ограничениями — один экран. Если аккуратно, поговорим.',
    'Пришлите одностраничное summary: зона контроля, документы, SLA инцидента. Если без воды — найдём время.',
    'Скиньте memo: что именно в зоне Mellow, что нет, как выглядит audit trail. Если чётко — созвонимся.',
  ]);
}

function respondLegalByConcern(concern, session, persona, lower, trust, irritation) {
  if (concern === 'scope') {
    if (irritation >= 2) {
      return pick([
        'Граница ответственности — ещё раз. Что берёте на себя, что нет?',
        'Три раза уже спрашиваю. Зона контроля Mellow — конкретно.',
        'Стоп. Что именно в зоне Mellow, что нет?',
        'Без декораций: что берёте, что не берёте. Одним предложением.',
        'Продолжаю слышать декларации. Граница ответственности — конкретно.',
      ]);
    }
    if (trust >= 2) {
      return pick([
        'Это уже аккуратно. А что именно остаётся на стороне клиента — где ваша зона заканчивается?',
        'Хорошо. Зона понятна. А где граница — что вы не берёте?',
        'Это аккуратная формулировка. Уточните: что конкретно на стороне клиента остаётся?',
        'Слышу зону. А что вне зоны — где вы принципиально не берёте ответственность?',
      ]);
    }
    if (persona.id === 'external_legal') {
      return pick([
        'Хорошо. Тогда сразу: что именно контролирует Mellow, что не контролирует, и где это подтверждается процессно?',
        'Ок. Что именно в зоне Mellow, что не в зоне, и как это докажется на практике?',
        'Нужны три вещи: что берёте, что не берёте, как подтверждается. Процессно, не декларативно.',
        'Аккуратно. Но мне нужно больше: что именно в зоне контроля, и где это закреплено документально?',
      ]);
    }
    if (persona.id === 'internal_legal') {
      return pick([
        'Ок. Конкретно: KYC, документы, платёжная цепочка — что именно в зоне Mellow, и где граница с нашей internal legal?',
        'Хорошо. Но мне важно: как это ложится на наши internal templates — что меняется в документах, что остаётся у нас?',
        'Аккуратно. Три вещи: что берёт Mellow, что остаётся у нашего legal, и как это задокументировано без overclaim?',
        'Мне важна traceability, не обещания. Что конкретно подтверждается в документах — KYC, trail, границы зон?',
        'Слышу зону. А что конкретно остаётся у нашего internal legal — где Mellow заканчивается и начинаемся мы?',
        'Ок. Но я работаю с templates — как именно это ложится на наши contractor docs без создания новых серых зон?',
        'Пока звучит правильно. Но мне нужно понять: что в нашем внутреннем процессе меняется — какие шаги убираются, какие добавляются?',
        'Хорошо. Следующий вопрос: как это выглядит при добавлении нового подрядчика — кто что делает, в каком порядке?',
        'Аккуратная зона. Но если что-то пошло не так внутри нашей стороны — где граница Mellow в этом сценарии?',
        'Слышу. А при расторжении контракта с подрядчиком — что происходит с документами и trail на стороне Mellow?',
        'Понятно что берёте. Но есть ли письменный service agreement, который описывает вашу зону — то, что я могу показать нашей legal команде без дополнительных вопросов?',
        'Ок. А если у нас собственный legal template для contractors — вы его замещаете своим, или интегрируетесь рядом? Это влияет на нашу документацию.',
        'Хорошо. Но я должна понять: когда Mellow генерирует документ от имени нашего contractor — кто является legal sender? Mellow или мы?',
        'Слышу зону. А по DPA — обработка персональных данных подрядчиков: где это у Mellow, и как соотносится с нашим internal processing agreement?',
      ]);
    }
    return pick([
      'Ок. Что именно Mellow даёт по documents, audit trail и process discipline, и где вы не делаете overclaim?',
      'Хорошо. Конкретно по documents и audit trail: что в зоне Mellow, и где заканчивается ваша ответственность?',
      'Контекст понятен. Граница ответственности — что именно в зоне Mellow, что у клиента?',
      'Хорошо начали. Но мне нужна точная граница: документы, платёжная цепочка, KYC — что именно ваше?',
      'Это ближе. Но уточните: где конкретно заканчивается ваша зона — что клиент делает сам?',
    ]);
  }

  if (concern === 'grey_zones') {
    if (persona.id === 'external_legal') {
      const defCount = session.meta._ext_legal_defensible_count || 0;
      const archetype = session.meta.persona_seed || '';
      const isDeeplySkeptical = archetype === 'deeply-skeptical';
      // deeply-skeptical and defensibility-focused both need 2 substantive exchanges.
      // (was 3 for deeply-skeptical — too high for natural conversation length, causing the gate
      //  to never fire before the concern order moved on.)
      // Differentiation preserved via the mid-challenge response pool at defCount >= 1.
      const gateCount = 2;
      const gateTrust = isDeeplySkeptical ? 1.0 : 1.5;
      // After enough direct defensibility answers, transition to conditional acceptance
      if (defCount >= gateCount && trust >= gateTrust) {
        session.meta.resolved_concerns = { ...(session.meta.resolved_concerns || {}), grey_zones: 'strong' };
        if (isDeeplySkeptical) {
          return pick([
            'Ладно. Я слышу аргумент — и он более аккуратный, чем большинство. Но мне нужно проверить это письменно перед тем, как двигаться. Пришлите scope, safeguards, пример инцидента. Посмотрю без обещаний.',
            'Хорошо. Позиция последовательная. Но внешний review требует документальной проверки, не слов. Пришлите письменное summary — зона, процесс, пример инцидента. Если там без overclaim — можно поговорить.',
            'Слышу. Убеждать меня словами — это тупик. Но вы не пытаетесь убеждать, а описываете процесс. Это другое. Пришлите письменное summary для изучения.',
          ]);
        }
        return pick([
          'Хорошо. Аргумент про процессную подтверждённость слышу. Пришлите письменный follow-up — scope, safeguards, пример инцидента. Посмотрю перед следующим review.',
          'Ладно. Если это операционно подтверждается — это другой разговор. Пришлите memo: зона, документы, flow. Если там без деклараций — созвонимся.',
        ]);
      }
      session.meta._ext_legal_defensible_count = defCount + 1;
      if (isDeeplySkeptical && defCount >= 1) {
        // deeply-skeptical mid-challenge — remains skeptical but shows engagement pattern
        return pick([
          'Слышу позицию. Но "задокументировано" — это широкое слово. Что именно я смогу взять в руки и проверить? Audit trail, договор, процесс инцидента — конкретно?',
          'Это более аккуратно, чем большинство pitch. Но мне нужен следующий уровень: как выглядит ваша зона при реальном dispute? Не абстрактно — по шагам.',
          'Ладно. Вы отвечаете на мои вопросы без уклонений. Это редкость. Последний вопрос: что происходит, если ваш process не работает так, как описан — кто несёт последствия?',
        ]);
      }
      return pick([
        'Звучит аккуратно. Тогда почему эта схема более defensible, чем текущая смесь посредников и ручных исключений?',
        'Ок. Но defensibility требует доказательств, не деклараций. Чем это подтверждается операционно?',
        'Неплохо. Но текущая схема тоже "работает". Почему это качественно лучше с правовой точки зрения?',
        'Хорошо. Но добавление vendor само создаёт серые зоны в ответственности. Как вы с этим работаете?',
        'Ок. Defensibility — это не только слова. Что конкретно подтверждает вашу зону при внешнем review?',
      ]);
    }
    if (irritation >= 2) {
      return pick([
        'Серые зоны между legal, ops и finance — как они убираются? Конкретно.',
        'Ещё раз: как это не создаёт новых overlap между слоями?',
        'Три раза уже спрашиваю про серые зоны. Как именно убираются?',
        'Не слышу ответа про overlap. Конкретно по цепочке — где границы?',
      ]);
    }
    if (persona.id === 'internal_legal') {
      return pick([
        'Хорошо. Но добавление Mellow — это новый слой между нашим internal legal и ops. Как именно он не создаёт новые серые зоны?',
        'Мне важно: как это ложится на наш internal process — где граница между Mellow и нашим legal отделом?',
        'Аккуратно. Но я буду работать с этими документами внутри. Как убираются серые зоны в zone of responsibility между нами и вами?',
        'Ок. Три слоя: Mellow, наш legal, наш finance. Где именно границы — и кто несёт trail, если что-то проваливается между ними?',
        'Звучит правильно. Но у нас contractor templates уже существуют. Как именно Mellow вписывается без создания conflicting ownership?',
        'Понял зону Mellow. Но между Mellow и нашим internal legal — где конкретно разграничение ответственности, задокументированное явно?',
        'Мне нужно понять: если у нас спорная ситуация с подрядчиком — кто ведёт документацию, Mellow или наш legal? Где именно ownership переходит?',
        'Хорошо. А как это выглядит при внутреннем compliance review — что я показываю внутри про роль Mellow без создания новых вопросов?',
        'Ок. Мне важно: если регулятор задаёт вопрос про нашу contractor chain — я отвечаю за Mellow? Или Mellow отвечает сам? Где граница public-facing?',
        'Слышу структуру. Но есть конкретный вопрос: при аудите contractor payments — кто предоставляет trail, Mellow или мы? В каком формате?',
        'Понятно в принципе. Но мне нужно знать: если наш internal legal и Mellow дают разные ответы на один вопрос про подрядчика — кто прав? Как это разрешается?',
        'Хорошо. А как это соотносится с нашей текущей contractor policy — нам нужно её переписывать или Mellow встраивается без изменений?',
        'Слышу. Но конкретный сценарий: мы онбордим нового подрядчика — какие документы генерирует Mellow, какие остаются у нас? Есть ли пересечения?',
        'Интересно. Но у нас NDA с некоторыми подрядчиками охватывает и платёжные данные. Как Mellow работает с этой конфиденциальностью — у них доступ к нашим условиям?',
      ]);
    }
    return pick([
      'Хорошо. Но как это уменьшает серые зоны между legal, ops и finance, а не просто добавляет новый слой?',
      'Ок. Мне важно: как это упрощает мою работу с finance и ops — без новых серых зон между слоями?',
      'Звучит аккуратно. Но добавление нового vendor само по себе создаёт новые серые зоны. Как вы их убираете?',
      'Понял зону. Но как именно это убирает overlap между legal, ops и finance? Конкретно по цепочке.',
      'Хорошо. А между слоями — legal, ops, finance — где теперь граница проходит? Как это устроено?',
    ]);
  }

  if (concern === 'incident') {
    if (persona.id === 'external_legal') {
      return pick([
        'Ок. Тогда следующий шаг должен быть очень конкретным. Что именно вы предлагаете: review, flow walkthrough или written follow-up?',
        'Хорошо. Что конкретно вы предлагаете дальше? Мне нужно что-то, что я могу изучить до следующего разговора.',
        'Аккуратно. Что дальше — документ, который я могу изучить, или короткий review call?',
        'Хорошо. Пришлите written summary — мне нужно что-то, что я могу отнести на следующий review.',
      ]);
    }
    if (irritation >= 2) {
      return pick([
        'Инцидент. Документ не тот. Что происходит? Кто что делает?',
        'Операционно: исключение — как оформляется, в каком сроке?',
        'Конкретный сценарий: что-то пошло не так. Кто, что, за сколько?',
        'Ещё раз: кто несёт trail при инциденте — Mellow или мы?',
      ]);
    }
    if (persona.id === 'internal_legal') {
      return pick([
        'Хорошо. А как выглядит incident documentation в вашей схеме — что именно Mellow оформляет, что остаётся у нашего internal legal?',
        'Ладно. Конкретный сценарий: подрядчик оспорил документ. Кто что делает — и где граница между Mellow и нашим legal?',
        'Важно: если что-то пошло не так с платёжной цепочкой — кто несёт audit trail? Что именно у вас, что у нас?',
        'Мне нужна схема инцидента без overclaim. Если платёж завис и документ не тот — кто несёт trail, кто объясняет клиенту?',
        'Ок. Граница ответственности при инциденте — это то, что мне нужно понять. Что конкретно Mellow берёт на себя, что остаётся у нас?',
        'Исключения — это реальный тест. Как процессно описан сценарий, где Mellow облажался: кто что делает, в какой срок, с каким trail?',
        'Конкретно: у нас был случай, когда подрядчик подал жалобу на невыплату. Как Mellow участвовал бы в этом — и что именно вы документируете со своей стороны?',
        'Слышу. А если инцидент требует joint response — и Mellow, и наш legal — кто координирует? Как выглядит эта joint documentation без противоречий?',
        'Ладно. А SLA по инциденту: если Mellow не закрывает его в заявленный срок — что происходит с нашей стороны процессно? Есть ли триггер уведомления для нашего legal?',
        'Важный вопрос: если дело доходит до регулятора или суда — Mellow выступает соответчиком или только дает trail? Это влияет на то, как мы выстраиваем документацию.',
      ]);
    }
    return pick([
      'А как вы описываете инциденты, исключения и границы ответственности клиенту без ложных обещаний?',
      'Ладно. Как именно выглядит документация инцидента — кто что делает, в каком сроке, с каким trail?',
      'Хорошо. А исключения — как они процессно описаны? Где граница между "Mellow отвечает" и "клиент разбирается сам"?',
      'Важно: как выглядит сценарий инцидента — документ потерян, платёж завис? Кто что делает, в какой срок?',
      'Incidents — это реальный тест. Как именно оформляется исключение, кто несёт trail?',
    ]);
  }

  // All concerns resolved or none active
  if (irritation >= 2) {
    return pick([
      'Пока недостаточно точности. Формулировки про границы, документы, safeguards — не общие обещания.',
      'Не хватает точности. Где конкретные формулировки про зону контроля, документы, audit trail?',
      'Слишком общо. Мне нужны точные формулировки, не декларации о надёжности.',
    ]);
  }
  return pick([
    'Пока недостаточно точности. Мне нужны формулировки про границы, документы и process safeguards, а не общие обещания.',
    'Не хватает точности. Где конкретные формулировки про зону контроля, документы и audit trail?',
    'Слишком размыто. Мне нужна точность: что именно в зоне Mellow, что нет, и как это подтверждается?',
    'Звучит правильно, но не хватает специфики. Где точные границы и документальное подтверждение?',
    'Общие слова я слышал уже. Где конкретные формулировки про зону, документы, safeguards?',
  ]);
}

// ==================== SELLER AI SUGGESTION SYSTEM ====================

function getRecommendedProduct(session) {
  return (session.sde_card?.recommended_product === 'CoR') ? 'cor' : 'cm';
}

function buildSignalAwareOpeners(session, lang = 'ru') {
  const card = session?.sde_card || {};
  const contactName = card?.contact?.name || personaMeta(session)?.name || (lang === 'en' ? 'there' : 'коллеги');
  const companyName = card?.company?.name || (lang === 'en' ? 'your team' : 'вашей команды');
  const whatHappened = normalizeSellerLanguage(String(card?.what_happened || card?.rendered_text || '').trim(), lang);
  const probablePain = normalizeSellerLanguage(String(card?.probable_pain || '').trim(), lang);
  const firstTouchHint = normalizeSellerLanguage(String(card?.first_touch_hint || '').trim(), lang);
  const signalLabel = String(card?.signal_type || '').trim();
  const product = getRecommendedProduct(session) === 'cor' ? 'Mellow CoR' : 'Mellow CM';

  if (!whatHappened && !probablePain && !firstTouchHint) return [];

  if (lang === 'en') {
    return [
      `${contactName}, I noticed a specific signal at ${companyName}: ${whatHappened || 'there is a concrete operational shift in the contractor flow'}. It looks like the pressure point is ${probablePain || 'manual risk and weak control under pressure'}. ${product} is only relevant if it helps with exactly that. Which part is the sharpest right now?`,
      `${contactName}, this looks less like generic interest and more like a concrete trigger: ${whatHappened || probablePain || 'there is a real operating constraint in the current setup'}. ${firstTouchHint || `I would approach it through ${signalLabel || 'the active signal'}, not a broad pitch.`} Does that map to what is actually creating pressure on your side?`,
    ].filter(Boolean);
  }

  return [
    `${contactName}, вижу у ${companyName} не абстрактный интерес, а конкретный сигнал: ${whatHappened || 'в contractor flow появился реальный сдвиг'}. Похоже, узел сейчас в следующем: ${probablePain || 'ручная нагрузка и слабая управляемость под давлением'}. ${product} имеет смысл обсуждать только если это бьёт ровно в этот контекст. Где сейчас самая острая точка?`,
    `${contactName}, вижу здесь не общий интерес, а конкретный рабочий сигнал: ${whatHappened || probablePain || signalLabel || 'активный сигнал сессии'}. ${firstTouchHint || 'Хочу зайти точно в этот контекст, без широких обещаний.'} Это действительно тот узел, который сейчас создаёт вам наибольшее давление?`,
  ].filter(Boolean);
}

// Persona-specific first-touch openers referencing the actual signal card context
function buildSellerOpener(session) {
  const persona = personaMeta(session);
  const card = session.sde_card;
  const signalAwareOpeners = isEmailMode(session) ? buildEmailSignalAwareOpeners(session, 'ru') : buildSignalAwareOpeners(session, 'ru');
  const openers = {
    andrey: [
      `Андрей, увидел, что у Northstar перед внешним legal review один платёж завис на 23 дня, и finance команда тратит 3–4 дня в месяц на ручную сверку. Mellow работает как Contractor of Record — берём KYC, документы и платёжную цепочку на себя, с audit trail по каждой транзакции. Не обещаем снять ваш риск целиком, но убираем неструктурированный слой до review. Стоит посмотреть, подходит ли это?`,
      `Андрей, вижу, что перед external legal review у вас появился вопрос по contractor payments — зависший платёж и ручная сверка на команду. Mellow — Contractor of Record: документы, KYC, платёжная цепочка, audit trail — в нашей зоне. Misclassification risk не снимаем, но убираем ручную уязвимость. Где именно сейчас самое слабое место в схеме?`,
      `Андрей, у Northstar 45 подрядчиков в сложном geo, legal review на подходе, и платёж уже висел 23 дня. Mellow берёт конкретную зону: KYC, документы, платёжная цепочка, trail. Границу ответственности — говорю прямо, без расширенных обещаний. Есть смысл разобраться, закрывает ли это ваши риски перед review?`,
    ],
    alexey: [
      `Алексей, у OrbitFlow подрядчики в Армении, Грузии, Казахстане — а выплаты через Wise и crypto с ручной координацией. Mellow убирает эту возню: автоматические выплаты, real-time статусы, без бардака через чаты. Коротко: что конкретно сейчас тратит больше всего времени у ops?`,
      `Алексей, вижу — распределённая команда растёт, а Wise + crypto уже не тянет без ручного сопровождения. Mellow — структурированный payout flow: автоматические выплаты, статусы без follow-ups, эскалации через нас, не через вас. Один вопрос: что конкретно ломается чаще всего?`,
      `Алексей, у вас активный найм в Кавказе и задержки через Wise — знакомая история. Mellow убирает ручной слой: автовыплаты, статусы в реальном времени, меньше пожаров. Без долгого sales process — что конкретно сейчас острее всего?`,
    ],
    cfo_round: [
      `София, вижу, что Series A закрылась три недели назад и investor запросил cleaner contractor controls перед следующим diligence. Mellow — Contractor of Record с чистым audit trail по каждому платежу и документами, которые объяснимы инвестору. Не обещаем снять ваш legal риск — убираем неструктурированную схему до следующего round. Попадаем в ваш контекст?`,
      `Sofia, Series A за вами, и investor уже попросил cleaner contractor structure. Mellow даёт CoR с audit story, которую можно положить на стол при diligence — документы, KYC, пейаут trail. Где именно сейчас самая слабая точка в вашей contractor схеме?`,
      `София, вы готовите contractor structure после раунда — и следующий investor будет смотреть на это подробнее. Mellow CoR: берём документы, KYC, платёжную цепочку — с trail, который объясним при diligence. Не пытаемся закрыть ваш legal риск целиком — убираем неструктурированный слой. Что сейчас вызывает больше всего вопросов?`,
    ],
    eng_manager: [
      `Марк, вижу, что в Docklane engineering уже не первый раз тушит пожары с выплатами подрядчиков. Mellow убирает ручные эскалации: структурированный payout flow, real-time статусы, SLA при сбоях — без вас как операционного моста. И если понадобится занести это в finance, у меня есть короткий материал для внутреннего разговора. Что сейчас самая острая точка?`,
      `Марк, у Docklane 15+ инженеров в AM/GE/KZ, и задержки выплат уже съели ваше время дважды. Mellow снимает ручные эскалации: автовыплаты, статусы без чатов, named owner при сбоях. Плюс могу дать материал для finance, если понадобится двигаться внутри. Чем сейчас тратите больше всего времени на payment-coordination?`,
      `Марк, вы уже разрулили выплаты вручную несколько раз — и команда это помнит. Mellow убирает вас из этой роли: структурированный payout, SLA, real-time статусы. Finance можно занести через короткий pitch — у меня есть материал. С чего начать?`,
    ],
    ops_manager: [
      `Ирина, у BlueMesa 30+ подрядчиков, и payout coordination уже размазана по чатам и таблицам. Mellow даёт предсказуемый process: автовыплаты, real-time статусы, без ручных follow-ups. Конкретно — что сейчас занимает больше всего ops-времени в неделю?`,
      `Ирина, вижу, что у BlueMesa растёт hiring contractors, а ops уже не успевает за координацией вручную. Mellow убирает ручной слой: предсказуемый payout flow, статусы без чатов, меньше сверки. Что конкретно сейчас ломается в процессе чаще всего?`,
      `Ирина, у BlueMesa статусы по выплатам размазаны по чатам и таблицам — узнаваемая картина. Mellow даёт один предсказуемый flow: автовыплаты, статусы в реальном времени, процесс при сбоях. Что у вас сейчас отнимает больше всего времени — сверка, follow-ups, эскалации?`,
    ],
    head_finance: [
      `Елена, у ClearHarbor идёт подготовка к annual audit, и finance наводит порядок с contractor controls. Mellow берёт на себя документы, KYC и платёжную цепочку — с audit trail, который объяснимо выглядит для leadership. Не снимаем весь ваш риск — убираем ручную сверку и даём структурированную схему. Что сейчас самая болезненная точка?`,
      `Елена, перед audit всегда давление на документирование. Mellow — CoR с полным trail по каждому подрядчику: документы, KYC, пейаут — всё структурировано. Убираем ручную сверку и даём схему, которую легче объяснять leadership и аудитору. Где сейчас самый слабый участок?`,
      `Елена, у ClearHarbor идёт реорганизация contractor controls под audit. Mellow даёт CoR: audit trail, документы, пейаут — всё на нашей стороне. Что конкретно нужно закрыть до audit — документы, сверка, payout controls?`,
    ],
    internal_legal: [
      `Анна, вижу, что SynthPort пересобирает contractor documentation и хочет сократить серые зоны между ops, finance и посредниками. Mellow берёт конкретную зону: KYC, документы, платёжная цепочка — с audit trail и чёткой границей, что в нашей зоне, что на стороне клиента. Без overclaiming. Попадаем в вашу задачу?`,
      `Анна, вы обновляете contractor templates и хотите больше traceability и меньше серых зон. Mellow даёт структурированную зону: документы, KYC, пейаут с trail. Мы не претендуем на снятие legal risk целиком — убираем серые зоны в платёжной цепочке и документах. Что сейчас самая слабая точка в вашей схеме?`,
      `Анна, SynthPort ищет более чистый document и payout flow с меньшими серыми зонами. Mellow берёт конкретную зону: документы, KYC, платёжная цепочка, audit trail. Граница ответственности — задокументирована явно. Где у вас сейчас больше всего неопределённости?`,
    ],
    external_legal: [
      `Давид, вы подключены на review contractor/payment setup у Westline — и текущая схема, судя по всему, слабо defensible. Mellow — CoR с чёткой зоной: документы, KYC, платёжная цепочка, audit trail. Что берём — описываю конкретно. Что не берём — тоже говорю прямо. Какая часть текущей схемы вас беспокоит больше всего?`,
      `Давид, вы уже видели у Westline хрупкую смесь посредников и ручных исключений. Mellow даёт структурированную альтернативу: CoR с задокументированной зоной контроля, audit trail по каждому платежу. Без обещаний снять то, что вне нашей зоны. Что именно в текущей схеме вы считаете наиболее проблемным с точки зрения defensibility?`,
      `Давид, external review — это честная проверка схемы. Mellow: CoR, чёткая граница ответственности, audit trail, документы. Не пытаемся быть всем. Что в текущей схеме Westline вы бы назвали критической слабостью?`,
    ],
  };
  if (!isEmailMode(session) && signalAwareOpeners.length) {
    return chooseMemoryInformedCandidate(session, signalAwareOpeners, pick(signalAwareOpeners));
  }

  if (isEmailMode(session) && signalAwareOpeners.length) {
    return chooseMemoryInformedCandidate(session, signalAwareOpeners, pick(signalAwareOpeners));
  }

  if (openers[persona.id]?.length) {
    return pick(openers[persona.id]);
  }

  const scenarioOpeners = {
    rate_floor_cfo: [
      'Марина, вижу, что вы уже сравниваете Mellow с рынком 2.5-3.5%. Не буду спорить с бенчмарком. Вопрос только один: где для вас premium действительно оправдан, а где нет?',
    ],
    panic_churn_ops: [
      'Ольга, вижу, что после поздней bank/compliance коммуникации у вас внутри началась паника. Не хочу продавать поверх этого. Что для вас сейчас важнее всего вернуть: предсказуемость, спокойствие людей или контроль над инцидентами?',
    ],
    fx_trust_shock_finance: [
      'Дмитрий, вижу, что после первого invoice у вас возник FX/total-cost shock. Не хочу спорить с этим ощущением. Что для вас сейчас критичнее: понять математику, убрать surprise или восстановить доверие к economics?',
    ],
    cm_winback: [
      'Ирина, вижу, что старый CoR-контур с Mellow у вас доверие не удержал. Я не про возврат в ту же историю. Хочу понять только одно: появился ли сейчас другой use case, где CM может быть уже fit?',
    ],
    grey_pain_switcher: [
      'Анна, вижу, что после опыта с серым провайдером вопрос уже не в красивом compliance-слове, а в том, кто реально держит ответственность. Что для вас сейчас главный тест безопасности нового решения?',
    ],
    direct_contract_transition: [
      'Екатерина, вижу, что у вас структура roster изменилась и появился более узкий direct-contract вопрос. Не предлагаю широкий restart. Хочу понять, для какого именно slice новый контур может быть полезен.',
    ],
  };
  if (scenarioOpeners[persona.id]?.length) {
    return pick(scenarioOpeners[persona.id]);
  }

  const contactName = card?.contact?.name || persona.name || 'Коллеги';
  const companyName = card?.company?.name || 'компании';
  const whatHappened = String(card?.what_happened || '').trim();
  const probablePain = String(card?.probable_pain || '').trim();
  const product = String(card?.recommended_product || '').trim().toUpperCase() || 'Mellow';

  return pick([
    `${contactName}, вижу у ${companyName} конкретный сдвиг: ${whatHappened || 'в contractor flow появился рабочий pain'}. Похоже, основной узел сейчас в следующем: ${probablePain || 'ручная нагрузка и слабая управляемость'}. Если смотреть на это через ${product}, где сейчас самый острый участок?`,
    `${contactName}, вижу, что у ${companyName} ситуация уже не про абстрактный интерес, а про конкретный рабочий контекст: ${whatHappened || probablePain || 'есть реальный operational pain'}. Mellow здесь стоит обсуждать только если это действительно снимает узкое место. Что сейчас болит сильнее всего?`,
  ]);
}

// Concern-specific seller response lines with Mellow product knowledge
function buildConcernSpecificLine(concern, product, persona, claims = {}) {
  const isCor = product === 'cor';
  const lines = {
    scope: [
      `Зона Mellow конкретная: KYC, contractor documentation, платёжная цепочка и audit trail по каждой транзакции — на нашей стороне. Что не берём: misclassification risk и стратегические legal-решения на вашей стороне. Это граница, без размытия.`,
      `Конкретно по зоне: документы и KYC — наши, платёжная цепочка с trail — тоже наша. Что у вас остаётся — ваш внутренний legal процесс. Мы не снимаем ваш риск целиком, мы убираем конкретный неструктурированный слой.`,
      `Наша зона: KYC, договоры с подрядчиками, платёжная цепочка, audit trail. Ваша: strategic legal decisions, misclassification — туда не заходим и не обещаем. Граница в договоре, в письменном виде.`,
      isCor
        ? `CoR — это не "мы помогаем". Это: Mellow юридически оформляет подрядчиков, берёт KYC, документы, НДФЛ, платёжную цепочку с trail. Что остаётся у вас — ваши стратегические решения. Граница чёткая.`
        : `CM — платформа: автовыплаты, real-time статусы, structured payout flow. Юридическое оформление и misclassification — ваша сторона. Мы убираем операционный хаос, а не legal-риск.`,
    ],
    why_change: [
      `Менять нет смысла, пока схема держится. Она перестаёт держаться в двух сценариях: когда платёж виснет и нет SLA-пути — или когда появляется audit/diligence вопрос и нет trail. У вас оба риска присутствуют. Mellow убирает оба.`,
      claims.days
        ? `Тот платёж на ${claims.days} — это не случайность, это структурная уязвимость. Mellow даёт SLA, trail и предсказуемость. Не потому что ваша схема сломана сейчас — потому что следующий сбой обойдётся дороже.`
        : `Текущая схема работает до первого инцидента или audit-вопроса. Mellow убирает ручную уязвимость и даёт структурированный процесс. Не ради замены — ради предсказуемости.`,
      `Зачем менять — правильный вопрос. Ответ: не потому что Mellow красивее на питче. Потому что текущая схема не выдержит следующего audit/diligence/инцидента без trail и SLA. Mellow это закрывает.`,
    ],
    sla: [
      `По инциденту конкретно: платёж завис — открываете кейс, named owner назначается, ответ в течение 2 часов, resolution или эскалация с объяснением через 24 часа. Всё в письменном виде, всё с trail. Это процесс, а не "разберёмся".`,
      `SLA: 2 часа на первый ответ, 24 часа на resolution или эскалацию. Именованный контакт, не общая поддержка. Если не укладываемся — фиксируем почему. Trail по каждому шагу. Хотите — пришлю это одним экраном.`,
      `Инцидент-path: ticket → named owner → 24 часа resolution или escalation с explanation. Граница между "Mellow разбирается" и "клиент сам" прописана в договоре явно. Не устное обещание — процесс с trail.`,
    ],
    geo_tax: [
      `По подрядчикам с РФ-паспортами: Mellow работает через партнёрскую сеть в юрисдикциях, где присутствуем. НДФЛ reporting — наша зона в рамках того, что оформлено через нас. Sanction risk classification — это ваша оценка, мы её не снимаем. Но убираем неструктурированный посреднический слой и даём audit trail.`,
      `РФ-паспорта и сложные geo — мы работаем с этим через документированную партнёрскую сеть. НДФЛ reporting в нашей зоне для подрядчиков, оформленных через Mellow. Sanction compliance — ваша оценка, не наша. Но вы получаете trail и структуру вместо непрозрачных слоёв.`,
    ],
    op_value: [
      `Конкретно что убирается: ручные follow-ups по статусам → автоматические уведомления. Ручная сверка выплат → structured flow с dashboard. Эскалации через вас → direct SLA с Mellow. Сколько часов в неделю сейчас уходит на это у вашей команды?`,
      `Что меняется: статусы в реальном времени вместо "ты не знаешь, пока не спросишь". Автовыплаты вместо ручной координации. Если что-то идёт не так — Mellow owner, не вы. Какая часть дня сейчас больше всего страдает?`,
      `Убирается: ручная координация через Wise + чаты + таблицы. Появляется: предсказуемый payout flow, real-time статусы, SLA при сбоях. Что конкретно сейчас отнимает больше всего времени?`,
    ],
    cost: [
      `Стоимость зависит от числа подрядчиков и продукта. Есть pilot-формат — понять fit без долгого контракта. Что для вас важнее на первом шаге: разобраться в механике или сразу считать ROI?`,
      `По деньгам — разговор под ваш конкретный сетап: число подрядчиков, юрисдикции, продукт. Есть пилот на ограниченный период. Что нужно понять до того, как двигаться дальше?`,
    ],
    internal_sell: [
      `Для finance у меня есть короткий материал: что убирается из ручного, что появляется в структуре, ROI по времени — один экран без sales воды. Можете перекинуть напрямую. Хотите пришлю?`,
      `Finance нужны три вещи: что убирается, что стоит, какой риск если не делать. У меня есть written summary под это — не pitch, а конкретика для внутреннего разговора. Скинуть?`,
      `Для внутреннего разговора с finance: пришлю flow, SLA и конкретный before/after по времени. Один экран. Если там без лишнего, можете показать напрямую. Хотите?`,
    ],
    grey_zones: [
      `Серые зоны убираются за счёт задокументированной границы: что в зоне Mellow — описано в договоре, с trail. Что у клиента — тоже описано явно. Overlap убирается тем, что у каждого участка есть owner.`,
      `Добавление vendor создаёт серые зоны только если граница не задокументирована. У нас граница в договоре: что берём, что нет, что происходит при инциденте. Неопределённость убирается явным распределением зон, а не количеством участников.`,
    ],
    incident: [
      `Инцидент-path конкретный: кейс открывается в системе, named owner назначается автоматически, SLA — 24 часа resolution или эскалация с explanation. Trail по каждому шагу. Что в нашей зоне — мы resolveим. Что за пределами — объясняем почему и что дальше.`,
      `Документ не тот или платёж завис: ticket → named owner → 24 часа. Trail сохраняется. Граница "Mellow разбирается" vs "клиент сам" прописана в договоре. Не "разберёмся по ситуации" — процесс.`,
    ],
    vendor_fatigue: [
      `Понимаю скептицизм после vendor, который не поехал. Конкретная разница: Mellow — CoR, а не посредник-прослойка. Мы берём юридическую ответственность за свою зону — не просто "маршрутизируем" платёж. Другая модель.`,
      `Разница от предыдущего vendor: мы не обещаем то, что не контролируем. Наша зона задокументирована в договоре. Где обязуемся — есть SLA. Где нет — говорим прямо. Именно это обычно и ломалось у предыдущих.`,
    ],
    proof: [
      `Конкретный кейс: B2B SaaS, ~120 человек, distributed contractors KZ/GE, раньше Wise + ручная координация. После Mellow: ручная возня упала на ~80%, один инцидент за 6 месяцев — resolved за 18 часов. Подходит под ваш масштаб?`,
      `Есть похожий кейс — 20+ contractors в AM/GE, ops тратила 3–4 часа в неделю на payment coordination. После Mellow: автовыплаты, один dashboard, эскалации через нас. Могу дать детали.`,
    ],
    next_step: [
      `Предлагаю 20 минут на неделе: пройдём по вашему конкретному flow и покажу, как это выглядит на практике — не общее демо, а под ваш сетап. Когда удобно?`,
      `Следующий шаг: пришлю короткое summary — flow, SLA, зона контроля — один экран. Если там всё приземлённо, найдём 20 минут на созвон. Подходит?`,
    ],
  };
  return pick(lines[concern] || lines.scope);
}

// Archetype-specific next step proposals
function buildSellerNextStep(session) {
  const persona = personaMeta(session);
  const archetype = persona.archetype;
  if (archetype === 'legal') {
    return pick([
      `Предлагаю следующий шаг: пришлю written summary — зона контроля, документы, process safeguards, пример инцидента — один экран без деклараций. Если аккуратно, короткий review call. Подходит?`,
      `Следующий шаг: документ с чёткими формулировками — что в зоне Mellow, что нет, как подтверждается. Можно изучить до следующего разговора. Когда удобно?`,
    ]);
  }
  if (archetype === 'finance') {
    return pick([
      `Предлагаю: пришлю короткое flow — audit trail, SLA, зона контроля — один экран. Если это приземлённо под ваш контекст, найдём 20 минут на созвон. Когда удобно на этой неделе?`,
      `Следующий шаг: summary с flow, SLA и зоной контроля — без воды. Если там всё конкретно, за 20 минут пройдёмся по вашему сетапу. Подходит?`,
    ]);
  }
  return pick([
    `Следующий шаг: пришлю flow — что убирается из ручного, как выглядит процесс после Mellow — один экран. Если реально, можно 15 минут на созвон без долгого sales process. Когда удобно?`,
    `Предлагаю: flow + конкретный до/после для вашего сетапа — один экран. Если там без воды, найдём 15 минут. Удобно на этой неделе?`,
  ]);
}

// Return persona+state-specific trust-repair messages.
// Used when miss_streak >= 1 and trust is below ask threshold.
function getTrustRepairMessages(session, lang = 'ru') {
  const persona = personaMeta(session);
  const concern = getActiveConcern(session);
  const isEN = lang === 'en';

  const ru = {
    finance: {
      andrey: [
        `Понял, что ушли не туда — давайте конкретнее. По вашему contractor сетапу: payment chain с audit trail на нашей стороне, граница ответственности — в договоре. Что именно не звучит приземлённо?`,
        `Слышу скепсис. Уточните, что именно не попадает в вашу ситуацию — отвечу по делу, без общих тезисов.`,
      ],
      cfo_round: [
        `Понял. Конкретно под ваш контекст: Mellow — это audit trail и документация, которую можно показать инвестору без импровизации. Что именно вызывает вопросы по схеме?`,
        `Слышу. Не хочу говорить в общем — скажите, какой аспект diligence readiness для вас сейчас самый острый.`,
      ],
      head_finance: [
        `Понял, где потеряли. Конкретно: что убирает Mellow — ручная сверка, serial follow-ups в Slack, отсутствие trail. Что из этого самое болезненное сейчас?`,
        `Слышу. Без общей части — что именно нужно, чтобы схема была объяснима leadership?`,
      ],
      default: [
        `Понял, что ушли не туда. Без общих тезисов — скажите, что именно вызывает вопросы, отвечу по делу.`,
        `Слышу скепсис. Уточните самый острый момент — payment chain, документы или граница ответственности.`,
      ],
    },
    ops: {
      alexey: [
        `Понял — без воды. Конкретно: что убирается — ручные статусы, эскалации, Wise/crypto chaos. Что из этого сейчас самый большой bottleneck?`,
        `Слышу. Скажи одной строчкой, где больше всего теряешь время на payments — там и начнём.`,
      ],
      eng_manager: [
        `Слышу. Без enterprise theatre — что именно нужно закрыть, чтобы ты мог не быть операционным мостом между finance и подрядчиками?`,
        `Понял. Конкретно: что убирает Mellow — ручные эскалации и статусы. Что из этого сейчас самое болезненное?`,
      ],
      ops_manager: [
        `Слышу. Давай конкретно: что именно в текущем процессе создаёт больше всего ручной работы — выплаты, статусы, reconciliation?`,
        `Понял. Без общего — скажи, что в payout coordination отнимает больше всего времени прямо сейчас.`,
      ],
      default: [
        `Слышу. Без воды — скажи, что конкретно создаёт больше всего ops-боли прямо сейчас.`,
        `Понял. Конкретно: payments, статусы или что-то другое — что самое острое?`,
      ],
    },
    legal: {
      internal_legal: [
        `Слышу. Без деклараций — по вашей схеме конкретно: документация, KYC, payment chain с audit trail. Что именно вызывает вопросы по границам ответственности?`,
        `Понял. Уточните, где в текущей схеме самая слабая зона — разберём именно её.`,
      ],
      external_legal: [
        `Слышу скепсис. Давайте по делу: что именно в текущей схеме вы считаете слабее всего с точки зрения defensibility?`,
        `Понял. Без маркетинга — укажите конкретную слабость, отвечу точно по зоне контроля Mellow.`,
      ],
      default: [
        `Слышу. Без деклараций — что именно вызывает вопросы по документации или границам ответственности?`,
        `Понял. Уточните конкретный вопрос — отвечу без overclaim.`,
      ],
    },
  };

  const en = {
    finance: {
      andrey: [
        `Understood — too vague. Specifically: Mellow takes on the payment chain with audit trail on our side, responsibility boundary is in the contract. What exactly doesn't feel grounded in your situation?`,
        `I hear the skepticism. Tell me what specifically doesn't map to your setup and I'll answer directly.`,
      ],
      cfo_round: [
        `Got it. Concretely for your context: Mellow is audit trail and documentation that can be shown to investors without improvising. Which aspect of diligence readiness is most pressing right now?`,
        `Understood. Skip the general part — what specifically needs to be in place for this to be investor-ready?`,
      ],
      head_finance: [
        `Understood. Concretely: what Mellow removes — manual reconciliation, serial Slack follow-ups, missing audit trail. Which of those is most painful right now?`,
        `Understood. Without the general layer — what specifically needs to be explainable to leadership?`,
      ],
      default: [
        `Understood — let me get more specific. Tell me what's raising questions and I'll address it directly.`,
        `Heard the skepticism. Which part is the sharpest — payment chain, documents, or responsibility boundary?`,
      ],
    },
    ops: {
      alexey: [
        `Got it — no fluff. Specifically: what disappears — manual statuses, escalations, Wise/crypto chaos. Which of those is the biggest bottleneck right now?`,
        `Understood. Tell me in one line where payments are eating the most time — we'll start there.`,
      ],
      eng_manager: [
        `Heard. No enterprise theatre — what specifically needs to close for you to stop being the operational bridge between finance and contractors?`,
        `Got it. Specifically: what Mellow removes — manual escalations and statuses. Which of those is the sharpest pain right now?`,
      ],
      ops_manager: [
        `Understood. Concretely: what's creating the most manual work in your current process — payouts, statuses, or reconciliation?`,
        `Got it. Skip the general — tell me what's eating the most time in payout coordination right now.`,
      ],
      default: [
        `Understood — no fluff. Tell me specifically what's creating the most ops pain right now.`,
        `Got it. Concretely: payments, statuses, or something else — what's most acute?`,
      ],
    },
    legal: {
      internal_legal: [
        `Heard. Without declarations — concretely on your setup: documentation, KYC, payment chain with audit trail. What specifically raises questions on responsibility boundaries?`,
        `Understood. Tell me where the weakest zone is in your current setup and we'll address that specifically.`,
      ],
      external_legal: [
        `Heard the skepticism. Concretely: what do you consider the weakest point in the current setup from a defensibility standpoint?`,
        `Understood. No marketing — name the specific weakness and I'll answer precisely on Mellow's control zone.`,
      ],
      default: [
        `Heard. Without declarations — what specifically raises questions about documentation or responsibility boundaries?`,
        `Understood. Name the specific concern and I'll answer without overclaiming.`,
      ],
    },
  };

  const bank = isEN ? en : ru;
  const archetypeBank = bank[persona?.archetype] || bank.finance;
  const personaBank = archetypeBank[persona?.id] || archetypeBank.default;
  return personaBank;
}

// Return persona+buyer-state-specific ask messages.
// Differentiates by ask type: 'written_first' | 'direct_call' | 'narrow_walkthrough'
function getPersonaAskMessages(session, lang = 'ru') {
  const persona = personaMeta(session);
  const askType = getPersonaAskType(session);
  const isEN = lang === 'en';

  const ru = {
    finance: {
      andrey: {
        written_first: [
          `Предлагаю следующий шаг: пришлю payment flow с audit trail и примером инцидентного пути — один экран без деклараций. Если это приземлённо под ваш legal review — 20 минут на созвон. Подходит?`,
          `Пришлю до конца дня: flow, зона контроля, audit trail — конкретно под ваш contractor сетап. Если там без маркетинга — 20 минут на созвон до вашего review. Удобно?`,
        ],
        direct_call: [
          `Если audit trail и structured payment chain — то, что нужно до legal review, давайте 20 минут до конца недели. Конкретно по вашей geo-структуре.`,
          `Давайте 20 минут — конкретно по KYC, payment chain и границе ответственности под ваш сетап. Когда удобно?`,
        ],
        narrow_walkthrough: [
          `Предлагаю узкий разговор — 15 минут только по audit trail и payment chain, без широкого pitch. Покажу конкретно зону контроля Mellow. Подходит?`,
          `Короткий созвон — 15 минут, только по документации и payment flow. Никаких деклараций, только конкретика. Когда удобно?`,
        ],
      },
      cfo_round: {
        written_first: [
          `Пришлю investor-ready summary: где уходит ручной prep перед diligence, что становится explainable для инвестора и где зона контроля. Если это закрывает вопрос investor scrutiny — 20 минут на созвон до quarterly review. Подходит?`,
          `Следующий шаг: пришлю документ — hidden prep cost, flow, документация и audit trail для investor level. Если там без воды — созвон на 20 минут до вашего дедлайна. Когда удобно?`,
        ],
        direct_call: [
          `Investor diligence — конкретный риск с конкретными сроками. Давайте 20 минут — покажу именно ту часть схемы, которую нужно привести в порядок до quarterly review.`,
          `Давайте 20 минут — конкретно по audit trail и contractor documentation под ваш investor context. Когда удобно на этой неделе?`,
        ],
        narrow_walkthrough: [
          `Узкий разговор — 15 минут по investor-level diligence readiness. Только схема, документы, audit trail. Без лишнего. Когда удобно?`,
          `Короткий созвон — 15 минут, только по тому, что нужно показать инвестору. Конкретно и без общих тезисов. Подходит?`,
        ],
      },
      head_finance: {
        written_first: [
          `Пришлю summary: flow, audit trail, что именно уходит из ручной сверки и как это объяснять leadership. Если там конкретно — 20 минут на созвон. Подходит?`,
          `Следующий шаг: один экран с payment flow, control-cost logic и audit story под ваш annual audit контекст. Если приземлённо — короткий созвон. Когда удобно?`,
        ],
        direct_call: [
          `Давайте 20 минут — покажу audit trail, payment flow и схему объяснимости для leadership. Конкретно под ваш сетап.`,
          `Если control + explainability вверх и меньше ручного вниз — давайте 20 минут. Когда удобно на этой неделе?`,
        ],
        narrow_walkthrough: [
          `Узкий разговор — 15 минут только по audit trail и ручной нагрузке. Без общего pitch. Когда удобно?`,
          `Короткий созвон — 15 минут, конкретно по reconciliation и что убирается. Подходит?`,
        ],
      },
      default: {
        written_first: [
          `Пришлю summary: flow, audit trail, зона контроля — один экран без воды. Если приземлённо — 20 минут на созвон. Подходит?`,
          `Следующий шаг: пришлю flow с SLA и audit story. Если конкретно — найдём 20 минут. Когда удобно?`,
        ],
        direct_call: [
          `Давайте 20 минут — конкретно по вашей схеме: payment chain, audit trail, граница ответственности.`,
          `Если это попадает в вашу ситуацию — 20 минут на созвон. Когда удобно на этой неделе?`,
        ],
        narrow_walkthrough: [
          `Узкий разговор — 15 минут, только по audit trail и зоне контроля. Без широкого pitch. Подходит?`,
          `Короткий созвон — 15 минут по конкретике. Когда удобно?`,
        ],
      },
    },
    ops: {
      alexey: {
        written_first: [
          `Пришлю один экран: что убирается из ручного, как выглядит payment flow после Mellow — с цифрами. Если конкретно — 15 минут без долгого sales process. Когда удобно?`,
          `Следующий шаг: короткий doc с до/после по вашему ops сетапу. Если там без воды — 15 минут созвон. Подходит?`,
        ],
        direct_call: [
          `Давайте 15 минут — покажу конкретно, что убирается из вашего ops. Без воды, без enterprise theatre. Когда удобно?`,
          `Если это убирает ручную координацию реально — 15 минут созвон. Без лишних шагов. Когда удобно?`,
        ],
        narrow_walkthrough: [
          `Короткий созвон — 15 минут только по payment flow. Без enterprise theatre. Удобно на этой неделе?`,
          `15 минут — конкретно по тому, что убирает ручную возню. Подходит?`,
        ],
      },
      eng_manager: {
        written_first: [
          `Пришлю brief для internal разговора с finance — два предложения: что убирается из ручного, почему это worth it. Плюс flow для вас — один экран. Когда удобно?`,
          `Следующий шаг: пришлю operational brief + материал для finance. Если конкретно — 20 минут на созвон. Подходит?`,
        ],
        direct_call: [
          `Давайте 20 минут — покажу operational relief конкретно и дам материал, который можно занести в finance. Когда удобно?`,
          `20 минут — и у вас будет ops relief + готовый brief для finance. Когда удобно на этой неделе?`,
        ],
        narrow_walkthrough: [
          `Узкий созвон — 15 минут по operational relief. Плюс brief, который можно занести в finance без лишних вопросов. Подходит?`,
          `Короткий разговор — 15 минут, только по тому, что убирает ручные эскалации. Когда удобно?`,
        ],
      },
      ops_manager: {
        written_first: [
          `Пришлю: flow — что убирается из ручного, как выглядят статусы после Mellow — один экран. Если реально — 20 минут на созвон. Подходит?`,
          `Следующий шаг: короткий doc с пайплайном и до/после по вашему процессу. Если конкретно — найдём 20 минут. Когда удобно?`,
        ],
        direct_call: [
          `Давайте 20 минут — покажу конкретно, что убирается из ручного. Без воды. Когда удобно на этой неделе?`,
          `Если убирает ручные follow-ups реально — 20 минут на созвон. Когда удобно?`,
        ],
        narrow_walkthrough: [
          `Короткий созвон — 15 минут только по payout workflow. Конкретика без общего pitch. Подходит?`,
          `15 минут — конкретно по статусам и reconciliation. Когда удобно?`,
        ],
      },
      default: {
        written_first: [
          `Пришлю один экран: flow и что убирается из ручного. Если реально — 15 минут созвон. Подходит?`,
          `Следующий шаг: пришлю brief с до/после. Если конкретно — найдём 15 минут. Когда удобно?`,
        ],
        direct_call: [
          `Давайте 15 минут — покажу конкретно, что убирается из ops. Когда удобно?`,
          `15 минут на созвон — конкретно по вашему сетапу. Подходит?`,
        ],
        narrow_walkthrough: [
          `Короткий разговор — 15 минут по конкретике. Без воды. Когда удобно?`,
          `15 минут — только по тому, что самое острое. Подходит?`,
        ],
      },
    },
    legal: {
      internal_legal: {
        written_first: [
          `Предлагаю следующий шаг: пришлю memo — зона контроля, документы, process safeguards, пример инцидентного trail — без overclaim. Если аккуратно, короткий review call. Когда удобно?`,
          `Следующий шаг: документ с чёткими формулировками — что в зоне Mellow, что нет, как подтверждается. Можно изучить до следующего разговора. Подходит?`,
        ],
        direct_call: [
          `Если зона контроля, документация и audit trail — это то, что нужно закрыть, давайте 20 минут. Конкретно по вашей contractor схеме. Когда удобно?`,
          `20 минут — разберём зону контроля, документацию и boundaries без деклараций. Когда удобно?`,
        ],
        narrow_walkthrough: [
          `Узкий разговор — 15 минут только по документации и audit trail. Без деклараций, только конкретика. Подходит?`,
          `Короткий review call — 15 минут по зоне контроля и process safeguards. Когда удобно?`,
        ],
      },
      external_legal: {
        written_first: [
          `Пришлю описание зоны контроля Mellow: что берём, что нет, как документируется — без маркетинговой ваты. Если формулировки чёткие — короткий review call. Когда удобно?`,
          `Следующий шаг: memo с defensibility-framework — зона контроля, audit trail, границы. Если аккуратно — 20 минут на разбор. Подходит?`,
        ],
        direct_call: [
          `Если defensibility и audit trail — ключевые вопросы, давайте 20 минут. Конкретно по зоне контроля Mellow без обещаний вне неё.`,
          `20 минут — разберём зону контроля, audit trail и boundaries точно. Когда удобно?`,
        ],
        narrow_walkthrough: [
          `Узкий разговор — 15 минут только по defensibility и зоне контроля. Без маркетинга. Подходит?`,
          `Короткий review call — 15 минут по audit trail и boundaries. Когда удобно?`,
        ],
      },
      default: {
        written_first: [
          `Пришлю memo с формулировками: что в зоне Mellow, что нет, как подтверждается. Если аккуратно — короткий review call. Подходит?`,
          `Следующий шаг: документ с зоной контроля и audit trail. Если без overclaim — 20 минут на разбор. Когда удобно?`,
        ],
        direct_call: [
          `Если зона контроля и документация — ключевые вопросы, давайте 20 минут. Конкретно и без деклараций. Когда удобно?`,
          `20 минут — разберём зону контроля без маркетинга. Подходит?`,
        ],
        narrow_walkthrough: [
          `Узкий разговор — 15 минут только по документации и boundaries. Без деклараций. Подходит?`,
          `Короткий review call — 15 минут по конкретике. Когда удобно?`,
        ],
      },
    },
  };

  const en = {
    finance: {
      andrey: {
        written_first: [
          `Let me send you a payment flow with audit trail and an incident path example — one page, no marketing. If it's grounded for your legal review context — 20 minutes for a call. Does that work?`,
          `I'll send by end of day: flow, control zone, audit trail — specifically for your contractor setup. If it's without the fluff — 20 minutes before your review. When works?`,
        ],
        direct_call: [
          `If audit trail and structured payment chain is what you need before the legal review, let's do 20 minutes this week. Specifically on your geo structure.`,
          `Let's do 20 minutes — specifically on KYC, payment chain, and responsibility boundary for your setup. When works?`,
        ],
        narrow_walkthrough: [
          `I'd suggest a narrow conversation — 15 minutes just on audit trail and payment chain, no broad pitch. I'll show Mellow's control zone specifically. Does that work?`,
          `Short call — 15 minutes, just on documentation and payment flow. No declarations, just specifics. When works?`,
        ],
      },
      cfo_round: {
        written_first: [
          `Let me send you an investor-ready summary: where manual diligence prep comes out, what becomes explainable to the investor, and where the control zone sits. If it closes the investor scrutiny question — 20 minutes for a call before the quarterly review. Does that work?`,
          `Next step: I'll send a document — hidden prep cost, flow, documentation, and audit trail for investor level. If it's without fluff — 20-minute call before your deadline. When works?`,
        ],
        direct_call: [
          `Investor diligence is a concrete risk with concrete timelines. Let's do 20 minutes — I'll show exactly the part of the setup that needs to be in order before the quarterly review.`,
          `Let's do 20 minutes — specifically on audit trail and contractor documentation for your investor context. When works this week?`,
        ],
        narrow_walkthrough: [
          `Narrow conversation — 15 minutes on investor-level diligence readiness. Just the scheme, documents, audit trail. No filler. When works?`,
          `Short call — 15 minutes, just on what needs to be shown to the investor. Specific and no general points. Does that work?`,
        ],
      },
      head_finance: {
        written_first: [
          `Let me send a summary: flow, audit trail, what specifically comes out of manual reconciliation, and how to explain it to leadership. If it's specific — 20 minutes for a call. Does that work?`,
          `Next step: one page with payment flow, control-cost logic, and audit story for your annual audit context. If grounded — a short call. When works?`,
        ],
        direct_call: [
          `Let's do 20 minutes — I'll show the audit trail, payment flow, and explainability structure for leadership. Specifically for your setup.`,
          `If control + explainability up and less manual work down — let's do 20 minutes. When works this week?`,
        ],
        narrow_walkthrough: [
          `Narrow conversation — 15 minutes just on audit trail and manual workload. No broad pitch. When works?`,
          `Short call — 15 minutes, specifically on reconciliation and what disappears. Does that work?`,
        ],
      },
      default: {
        written_first: [
          `Let me send a summary: flow, audit trail, control zone — one page without filler. If grounded — 20 minutes for a call. Does that work?`,
          `Next step: I'll send a flow with SLA and audit story. If specific — let's find 20 minutes. When works?`,
        ],
        direct_call: [
          `Let's do 20 minutes — specifically on your setup: payment chain, audit trail, responsibility boundary.`,
          `If this maps to your situation — 20 minutes for a call. When works this week?`,
        ],
        narrow_walkthrough: [
          `Narrow conversation — 15 minutes, just on audit trail and control zone. No broad pitch. Does that work?`,
          `Short call — 15 minutes on specifics. When works?`,
        ],
      },
    },
    ops: {
      alexey: {
        written_first: [
          `Let me send one page: what comes out of manual work, how the payment flow looks after Mellow — with numbers. If specific — 15 minutes without a long sales process. When works?`,
          `Next step: short doc with before/after for your ops setup. If without fluff — 15-minute call. Does that work?`,
        ],
        direct_call: [
          `Let's do 15 minutes — I'll show specifically what comes out of your ops. No filler, no enterprise theatre. When works?`,
          `If this removes manual coordination for real — 15-minute call. No extra steps. When works?`,
        ],
        narrow_walkthrough: [
          `Short call — 15 minutes just on payment flow. No enterprise theatre. Works this week?`,
          `15 minutes — specifically on what removes the manual overhead. Does that work?`,
        ],
      },
      eng_manager: {
        written_first: [
          `Let me send a brief for the internal finance conversation — two sentences: what comes off manual work, why it's worth it. Plus flow for you — one page. When works?`,
          `Next step: I'll send an operational brief plus finance-ready material. If specific — 20 minutes for a call. Does that work?`,
        ],
        direct_call: [
          `Let's do 20 minutes — I'll show the operational relief specifically and give you material you can take to finance. When works?`,
          `20 minutes — and you'll have ops relief plus a ready brief for finance. When works this week?`,
        ],
        narrow_walkthrough: [
          `Narrow call — 15 minutes on operational relief. Plus a brief you can take to finance without extra questions. Does that work?`,
          `Short conversation — 15 minutes, just on what removes the manual escalations. When works?`,
        ],
      },
      ops_manager: {
        written_first: [
          `Let me send: flow — what comes off manual work, what statuses look like after Mellow — one page. If real — 20-minute call. Does that work?`,
          `Next step: short doc with pipeline and before/after for your process. If specific — let's find 20 minutes. When works?`,
        ],
        direct_call: [
          `Let's do 20 minutes — I'll show specifically what comes off manual work. No filler. When works this week?`,
          `If it removes manual follow-ups for real — 20-minute call. When works?`,
        ],
        narrow_walkthrough: [
          `Short call — 15 minutes just on payout workflow. Specifics without broad pitch. Does that work?`,
          `15 minutes — specifically on statuses and reconciliation. When works?`,
        ],
      },
      default: {
        written_first: [
          `Let me send one page: flow and what comes off manual work. If real — 15-minute call. Does that work?`,
          `Next step: I'll send a brief with before/after. If specific — let's find 15 minutes. When works?`,
        ],
        direct_call: [
          `Let's do 15 minutes — I'll show specifically what comes out of ops. When works?`,
          `15 minutes — specifically for your setup. Does that work?`,
        ],
        narrow_walkthrough: [
          `Short conversation — 15 minutes on specifics. No filler. When works?`,
          `15 minutes — just on what's most acute. Does that work?`,
        ],
      },
    },
    legal: {
      internal_legal: {
        written_first: [
          `Let me send you a memo — control zone, documents, process safeguards, incident trail example — no overclaiming. If the formulations are clean, a short review call. When works?`,
          `Next step: a document with clear formulations — what's in Mellow's scope, what's not, how it's evidenced. You can review it before we talk. Does that work?`,
        ],
        direct_call: [
          `If control zone, documentation, and audit trail are what need to close, let's do 20 minutes. Specifically on your contractor scheme. When works?`,
          `20 minutes — we'll go through the control zone, documentation, and boundaries without declarations. When works?`,
        ],
        narrow_walkthrough: [
          `Narrow conversation — 15 minutes just on documentation and audit trail. No declarations, just specifics. Does that work?`,
          `Short review call — 15 minutes on control zone and process safeguards. When works?`,
        ],
      },
      external_legal: {
        written_first: [
          `Let me send a description of Mellow's control zone: what we take on, what we don't, how it's documented — no marketing. If the formulations are clean — a short review call. When works?`,
          `Next step: a defensibility memo — control zone, audit trail, boundaries. If careful — 20 minutes to go through it. Does that work?`,
        ],
        direct_call: [
          `If defensibility and audit trail are the key questions, let's do 20 minutes. Specifically on Mellow's control zone with no promises outside it.`,
          `20 minutes — we'll go through control zone, audit trail, and boundaries precisely. When works?`,
        ],
        narrow_walkthrough: [
          `Narrow conversation — 15 minutes just on defensibility and control zone. No marketing. Does that work?`,
          `Short review call — 15 minutes on audit trail and boundaries. When works?`,
        ],
      },
      default: {
        written_first: [
          `Let me send a memo with formulations: what's in Mellow's zone, what's not, how it's evidenced. If careful — a short review call. Does that work?`,
          `Next step: document with control zone and audit trail. If without overclaiming — 20 minutes to review. When works?`,
        ],
        direct_call: [
          `If control zone and documentation are the key questions, let's do 20 minutes. Specifically and without declarations. When works?`,
          `20 minutes — we'll go through the control zone without marketing. Does that work?`,
        ],
        narrow_walkthrough: [
          `Narrow conversation — 15 minutes just on documentation and boundaries. No declarations. Does that work?`,
          `Short review call — 15 minutes on specifics. When works?`,
        ],
      },
    },
  };

  const bank = isEN ? en : ru;
  const archetypeBank = bank[persona?.archetype] || bank.finance;
  const personaBank = archetypeBank[persona?.id] || archetypeBank.default;
  return personaBank[askType] || personaBank.written_first;
}

// Main seller suggestion orchestrator
function generateSellerSuggestionEN(session) {
  const policy = getHintPolicyContext(session);
  const sellerTurnCount = session.transcript.filter((m) => m.role === 'seller').length;
  const botTurnCount = session.meta.bot_turns || 0;
  const persona = personaMeta(session);
  const concern = getActiveConcern(session);
  const trust = session.meta.trust || 1;
  const irritation = session.meta.irritation || 0;
  const claims = session.meta.claims || {};
  const resolvedConcerns = session.meta.resolved_concerns || {};
  const resolvedCount = Object.keys(resolvedConcerns).length;

  if (sellerTurnCount === 0) {
    const signalAwareOpeners = buildSignalAwareOpeners(session, 'en');
    // English opening suggestions per persona
    const openers = {
      andrey: [
        `Andrey, I noticed that before your external legal review there was a 23-day payment stuck and the finance team spends 3–4 days a month on manual reconciliation. Mellow acts as Contractor of Record — we take on KYC, documents, and the payment chain, with an audit trail on each transaction. We don't promise to remove your risk entirely, but we remove the unstructured layer before the review. Worth exploring whether this fits?`,
        `Andrey, I saw that Northstar has 45 contractors across complex geographies and a legal review coming up — and that payment sat stuck for 23 days. Mellow's scope: KYC, documents, payment chain, audit trail. We're clear on what we don't take on — misclassification risk stays on your side. Does this speak to what you're dealing with before the review?`,
      ],
      alexey: [
        `Alexey, OrbitFlow has contractors across Armenia, Georgia, Kazakhstan — with payments going through Wise and crypto plus a lot of manual coordination. Mellow removes that friction: automatic payouts, real-time statuses, no more chasing status updates. Quick question: what's eating the most ops time right now?`,
        `Alexey, I can see the distributed team is growing and Wise + crypto is no longer scaling without manual overhead. Mellow gives you a structured payout flow: automatic payments, statuses without follow-ups, escalations handled by us — not by you. What breaks most often in the current setup?`,
      ],
      cfo_round: [
        `Sofia, I see Series A closed three weeks ago and the investor has already asked for cleaner contractor controls before the next diligence. Mellow acts as Contractor of Record with a clean audit trail on every payment — documents and KYC that can be shown to investors. We don't promise to remove your legal risk — we remove the unstructured layer before the next round. Does this fit your context?`,
        `Sofia, you're structuring contractor controls post-round — and the next investor will look at this more closely. Mellow CoR: we take on documents, KYC, payment chain with audit trail. We don't try to close your legal risk entirely — we remove the grey zone in the payment chain. What's the weakest point right now?`,
      ],
      eng_manager: [
        `Mark, I can see Docklane's engineering team has been putting out payment fires more than once. Mellow removes the manual escalations: structured payout flow, real-time statuses, SLA when things break — without you acting as the operational bridge. And if you need to bring this to finance, I have a short brief for that conversation. What's the most acute pain point right now?`,
        `Mark, Docklane has 15+ engineers in AM/GE/KZ and payment delays have already cost you time twice. Mellow takes the manual escalations off your plate: auto-payments, statuses without chat threads, a named owner when things break. Plus I can give you material for finance if you need to move it internally. What takes the most time in payment coordination right now?`,
      ],
      ops_manager: [
        `Irina, BlueMesa has 30+ contractors and payout coordination is spread across chats and spreadsheets. Mellow gives you a predictable process: auto-payments, real-time statuses, no manual follow-ups. Concretely — what takes the most ops time per week right now?`,
        `Irina, I can see BlueMesa's contractor hiring is growing and ops is already falling behind on manual coordination. Mellow removes the manual layer: predictable payout flow, statuses without chats, less reconciliation. What breaks in the process most often?`,
      ],
      head_finance: [
        `Elena, ClearHarbor is preparing for the annual audit and finance is getting contractor controls in order. Mellow takes on documents, KYC, and the payment chain — with an audit trail that's explainable to leadership. We don't remove your entire risk — we remove manual reconciliation and give you a structured scheme. What's the most painful point right now?`,
        `Elena, audit season always brings pressure on documentation. Mellow is a CoR with a full trail on each contractor: documents, KYC, payouts — all structured. We remove manual reconciliation and give you a scheme that's easier to explain to leadership and auditors. What's the weakest spot?`,
      ],
      panic_churn_ops: [
        `Olga, I can see the last bank/compliance episode created internal panic, so I won't pitch over that. The real question is whether there is now a safer recovery setup: clear incident owner, earlier contractor comms, and fewer surprises when something slips. Which part would you need to trust first: owner, comms path, or escalation timing?`,
        `Olga, after a trust break the bar is simple: no one gets surprised, and there is a named path when a payout or bank issue hits. Mellow only makes sense here if we can show a calmer recovery model, not a prettier promise. What would you test first: incident ownership, warning flow, or visibility before escalation?`,
      ],
      cm_winback: [
        `Irina, I know the old CoR story with Mellow lost trust, so this is not a comeback pitch. The only reason to reopen the conversation is if your workforce mix changed enough that a narrow CM slice is now operationally cleaner and safer. Which slice should we test first: non-RU/BY contractors, direct-contract visibility, or transition workload?`,
        `Irina, I am not trying to drag you back into the old setup. I only want to test whether there is now a narrower CM use case that gives you more ownership clarity and less manual coordination for today's roster. Where do you feel the new fit might exist, if at all: non-RU/BY layer, direct-contract need, or pilot scope?`,
      ],
      grey_pain_switcher: [
        `Anna, after a grey-provider experience, “compliance” is not proof. What matters is a clean owner model: who holds documents, who answers bank questions, who owns incident handling, and where Mellow's scope ends. Which of those would you want to pressure-test first?`,
        `Anna, if the old problem was unsafe structure, the next check should stay mechanical: document owner, payout owner, incident trail, and boundary when something goes wrong. Which piece is the real make-or-break point for you?`,
      ],
      direct_contract_transition: [
        `Ekaterina, I am not proposing a broad restart. The only useful question is whether there is now a narrow direct-contract slice where the switch would reduce coordination noise without destabilizing the rest of the roster. Which part should we test first: slice choice, transition workflow, or exception ownership?`,
        `Ekaterina, if the roster mix changed, the safe move is usually a narrow transition, not a full relaunch. Mellow is only relevant if we can map one slice with clear ownership and low transition risk. Which part matters most first: who moves, what changes operationally, or how exceptions are handled?`,
      ],
      internal_legal: [
        `Anna, I see SynthPort is rebuilding contractor documentation and wants to reduce grey zones between ops, finance, and intermediaries. Mellow takes a concrete zone: KYC, documents, payment chain — with an audit trail and a clear boundary on what's ours and what's the client's. No overclaiming. Does this speak to what you're working on?`,
        `Anna, you're updating contractor templates and want more traceability and fewer grey zones. Mellow gives you a structured zone: documents, KYC, payouts with a trail. We don't claim to remove legal risk entirely — we remove grey zones in the payment chain and documentation. What's the weakest point in your current setup?`,
      ],
      external_legal: [
        `David, you're reviewing the contractor/payment setup at Westline — and the current scheme, by the looks of it, is weakly defensible. Mellow is a CoR with a clear zone: documents, KYC, payment chain, audit trail. I'll describe what we take on concretely — and what we don't, equally clearly. Which part of the current scheme concerns you most?`,
        `David, you've already seen Westline's fragile mix of intermediaries and manual exceptions. Mellow provides a structured alternative: CoR with a documented control zone, audit trail on every payment. No promises on what's outside our scope. What would you call the critical weakness in the current scheme from a defensibility standpoint?`,
      ],
      olga: [
        `Olga, I saw LexCo started an outside-counsel review because the current contractor flow lacks traceability. Mellow's scope is explicit: contractor documentation, KYC, payment chain, audit trail. We do not claim to remove the client's legal risk. Which boundary or evidence gap would you test first?`,
        `Olga, your review started because the current contractor/payment setup looks weakly documented and hard to defend later. Mellow takes a bounded zone: documents, KYC, payment chain, incident trail, while the client's legal risk stays with the client. Which grey zone would concern you most first?`,
      ],
    };
    const openerPool = [
      ...signalAwareOpeners,
      ...tunedOpeners(persona.id),
      ...(openers[persona.id] || [
        `Hi! Mellow handles contractor payments — we take on documents, KYC, payout with audit trail on our side. What's the most pressing issue in your situation right now?`,
      ])
    ];
    return chooseMemoryInformedCandidate(session, openerPool, pick(openerPool));
  }

  if (policy.hintStage !== 'diagnosis' || sellerTurnCount > 0) {
    const stageBound = buildStageBoundSuggestion(session, 'en');
    if (stageBound && stageBound.trim()) return stageBound;
  }

  // Earned ask — persona+state-specific ask routing
  if (canMakeAsk(session)) {
    const nextStepPool = [
      ...tunedNextSteps(persona.id, persona.archetype),
      ...getPersonaAskMessages(session, 'en'),
    ];
    return chooseMemoryInformedCandidate(session, nextStepPool, pick(nextStepPool));
  }

  // Trust repair — trust was damaged, address it before attempting the ask
  if (needsTrustRepair(session)) {
    const repairPool = getTrustRepairMessages(session, 'en');
    return chooseMemoryInformedCandidate(session, repairPool, pick(repairPool));
  }

  // Irritated — sharpen
  if (irritation >= 2) {
    const enLines = {
      scope: `Mellow's scope specifically: KYC, contractor documentation, payment chain, and audit trail on every transaction — on our side. What we don't take on: misclassification risk and strategic legal decisions — those stay with you. That's the line, without blurring it.`,
      why_change: `Changing doesn't make sense while the setup holds. It stops holding in two scenarios: a payment gets stuck and there's no SLA path — or an audit/diligence question comes up and there's no trail. Both risks exist in your current setup. Mellow removes both.`,
      sla: `On SLA: if a payment gets stuck we have a named escalation owner with response time in the contract. Not a general support email — a defined process with documented response time.`,
      op_value: `Concretely: Mellow owns contractor documents, KYC checks, the payment workflow, and incident handling on our side. Auto-payments remove the chase, real-time statuses remove the follow-up thread, and your team stops acting as the escalation bridge.`,
      grey_zones: `The grey zones are documented: our scope ends where your legal process begins. Payment chain, KYC, documents — Mellow. Strategic legal decisions — yours. That boundary is in the contract.`,
      incident: `Here's what happens when something breaks: a named owner on our side gets alerted, the incident is logged with full trail, and the contractor is notified. You get a status update, not a problem to solve.`,
    };
    const tunedIrritated = tunedConcernLines(persona.id, concern || 'scope', persona.archetype);
    const irritatedPool = tunedIrritated.length ? tunedIrritated : [enLines[concern] || enLines.scope];
    return chooseMemoryInformedCandidate(session, irritatedPool, pick(irritatedPool));
  }

  // Concern-specific English suggestion
  const concLines = {
    scope: `Mellow's scope is specific: KYC, contractor documentation, payment chain, and audit trail on each transaction — that's on our side. What we don't take on: misclassification risk and your strategic legal decisions. That's the boundary, in the contract, in writing.`,
    why_change: `The current setup stops being defensible in two scenarios: a payment gets stuck with no SLA path — or diligence comes and there's no audit trail. Your current setup has both risks. Mellow removes them specifically.`,
    sla: `On SLA: a named escalation owner, defined response time in the contract, incident trail documented. Not general support — a process with accountability.`,
    op_value: `Specifically what stops being manual: payment status follow-ups, exception handling, and reconciliation. Mellow owns the payment workflow, KYC checks, contractor documents, and incident handling on our side, while auto-payments and real-time statuses replace the chat threads and spreadsheet updates.`,
    cost: `Pricing model: per contractor/month, with volume tiers. There's a pilot option to test on a subset before committing. Want me to send a rough calculation?`,
    internal_sell: `For finance: the framing is risk reduction and audit readiness, not just ops upgrade. Payment chain documented, KYC verified, audit trail on every transaction — that's the two-sentence case for the internal conversation.`,
    grey_zones: `The boundary is explicit: our scope covers the payment chain, KYC and contractor documentation. Your legal and finance teams own the strategic decisions. The overlap is mapped — not assumed.`,
    incident: `When something breaks: named owner on our side, response SLA in the contract, full incident trail documented. The contractor gets notified, you get a status update — not a problem to resolve.`,
    geo_tax: `On contractors with Russian passports or complex geo: we handle the payment side — KYC, documentation, payout chain. Tax classification stays on your side — we don't take that on, and we won't pretend to.`,
    next_step: `Ready to move: I can send a 1-page summary or we can do a 20-minute walkthrough. Which format works better for where you are right now?`,
  };
  const concernKey = concern || 'scope';
  const tunedConcernPool = tunedConcernLines(persona.id, concernKey, persona.archetype);
  const concernPool = tunedConcernPool.length ? tunedConcernPool : [concLines[concernKey]];
  const concLine = chooseMemoryInformedCandidate(session, concernPool, pick(concernPool));

  if (botTurnCount >= 2 && Math.random() > 0.5) {
    const probes = {
      finance: [" What's most important to you heading into the next step?", ' Which part of this maps most directly to your situation?', ' What else do you need to understand before moving forward?'],
      ops: [" What would take the most pain off your team specifically?", " Which part of your process is eating the most time right now?", ' What else do you need for the next step?'],
      legal: [' Does this address what you need to close?', " Which of these aspects is most critical for you right now?", ' What else needs to be clarified before the next step?'],
    };
    const probe = pick(probes[persona.archetype] || probes.finance);
    return concLine + probe;
  }
  return concLine;
}

function fallbackSellerSuggestion(session, lang = null) {
  const persona = personaMeta(session);
  const effectiveLang = lang === 'en' || lang === 'ru'
    ? lang
    : (session.language === 'en' ? 'en' : 'ru');

  if (effectiveLang === 'en') {
    if (persona?.archetype === 'ops') {
      return `From your current setup, what is creating the most manual work right now?`;
    }
    if (persona?.archetype === 'legal') {
      return `Where is the weakest boundary or grey zone in the current contractor setup?`;
    }
    return `What is the biggest payment or contractor risk you need to reduce right now?`;
  }

  if (persona?.archetype === 'ops') {
    return `Что в вашей текущей схеме создаёт больше всего ручной работы прямо сейчас?`;
  }
  if (persona?.archetype === 'legal') {
    return `Где в текущей contractor-схеме самая слабая граница или серая зона?`;
  }
  return `Какой платёжный или contractor-риск вам сейчас важнее всего снизить?`;
}

async function generateSellerSuggestion(session, lang = null, snapshot = null, strategy = null, uiStrategy = null) {
  const effectiveLang = lang === 'en' || lang === 'ru'
    ? lang
    : (session.language === 'en' ? 'en' : 'ru');
  const sellerTurnCountEarly = session.transcript.filter((m) => m.role === 'seller').length;
  const earlyPolicy = getHintPolicyContext(session);

  if (isEmailMode(session) && sellerTurnCountEarly > 0) {
    const emailStageBound = buildStageBoundSuggestion(session, effectiveLang === 'en' ? 'en' : 'ru');
    if (typeof emailStageBound === 'string' && emailStageBound.trim()) {
      return adaptTextToDialogue(emailStageBound, session, 'seller');
    }
  }

  // Step 6+7: LLM hint generation with exploration policy
  const llmHint = await generateLlmHint(session, effectiveLang, snapshot, strategy, uiStrategy);
  if (llmHint) {
    // Hard ask gating: reject LLM output that violates the stage-mode contract.
    // If the hint contains a meeting ask but the stage is not direct_ask (or a valid bridge variant),
    // fall through to the stage-bound suggestion rather than surfacing the rogue ask.
    const hintStageCheck = getHintPolicyContext(session).hintStage;
    const modeCheck = validateMixedMode(llmHint, hintStageCheck);
    if (modeCheck.valid) {
      return adaptTextToDialogue(llmHint, session, 'seller');
    }
    // Violation: LLM broke the stage contract — use stage-bound suggestion instead
  }

  // Fallback: rules-based hint generation
  if (effectiveLang === 'en') {
    const suggestion = generateSellerSuggestionEN(session);
    const resolved = typeof suggestion === 'string' && suggestion.trim() ? suggestion : fallbackSellerSuggestion(session, 'en');
    return adaptTextToDialogue(resolved, session, 'seller');
  }

  const sellerTurnCount = sellerTurnCountEarly;
  const policy = earlyPolicy;
  const botTurnCount = session.meta.bot_turns || 0;
  const persona = personaMeta(session);
  const concern = getActiveConcern(session);
  const trust = session.meta.trust || 1;
  const irritation = session.meta.irritation || 0;
  const claims = session.meta.claims || {};
  const resolvedConcerns = session.meta.resolved_concerns || {};
  const resolvedCount = Object.keys(resolvedConcerns).length;
  const product = getRecommendedProduct(session);

  // No seller turns yet — give the contextual opener
  if (sellerTurnCount === 0) {
    return adaptTextToDialogue(buildSellerOpener(session), session, 'seller');
  }

  const stageBound = buildStageBoundSuggestion(session, 'ru');
  if (policy.hintStage !== 'diagnosis' || sellerTurnCount > 0) {
    return adaptTextToDialogue(stageBound, session, 'seller');
  }

  // Earned ask — persona+state-specific ask routing
  if (canMakeAsk(session)) {
    const nextStepPool = [
      ...tunedNextSteps(persona.id, persona.archetype),
      ...getPersonaAskMessages(session, 'ru'),
    ];
    return adaptTextToDialogue(
      chooseMemoryInformedCandidate(session, nextStepPool, pick(nextStepPool)),
      session, 'seller'
    );
  }

  // Trust repair — trust was damaged, address it before attempting the ask
  if (needsTrustRepair(session)) {
    const repairPool = getTrustRepairMessages(session, 'ru');
    return adaptTextToDialogue(
      chooseMemoryInformedCandidate(session, repairPool, pick(repairPool)),
      session, 'seller'
    );
  }

  // Buyer is irritated — sharpen and get specific
  if (irritation >= 2) {
    const sharpLine = buildConcernSpecificLine(concern || 'scope', product, persona, claims);
    return adaptTextToDialogue(pick([
      `Слышу — без воды. ${sharpLine}`,
      `Понял, давайте конкретнее. ${sharpLine}`,
      sharpLine,
    ]), session, 'seller');
  }

  // Address the active concern with a follow-up probe embedded
  const concLine = buildConcernSpecificLine(concern || 'scope', product, persona, claims);

  // On turns 2+, sometimes embed a probing question after addressing the concern
  if (botTurnCount >= 2 && Math.random() > 0.5) {
    const probes = {
      finance: [
        ' Что из этого сейчас самое важное для вас перед следующим шагом?',
        ' Какая часть этого попадает в вашу конкретную ситуацию?',
        ' Что ещё нужно понять, чтобы двигаться дальше?',
      ],
      ops: [
        ' Что конкретно из этого убрало бы больше всего боли у вашей команды?',
        ' Какая часть вашего процесса сейчас отнимает больше всего времени?',
        ' Что ещё нужно для следующего шага?',
      ],
      legal: [
        ' Это попадает в то, что вам нужно закрыть?',
        ' Какой из этих аспектов для вас сейчас критичнее?',
        ' Что ещё нужно прояснить до следующего шага?',
      ],
    };
    const probe = pick(probes[persona.archetype] || probes.finance);
    return adaptTextToDialogue(concLine + probe, session, 'seller');
  }

  return adaptTextToDialogue((typeof concLine === 'string' && concLine.trim()) ? concLine : fallbackSellerSuggestion(session, 'ru'), session, 'seller');
}

function normalizeUiStrategy(moveType = null, proofLayer = null) {
  const normalizedMoveType = ['clarify', 'prove', 'ask'].includes(moveType) ? moveType : null;
  const normalizedProofLayer = ['case', 'one_screen', 'calculator'].includes(proofLayer) ? proofLayer : null;
  if (!normalizedMoveType && !normalizedProofLayer) return null;
  return {
    moveType: normalizedMoveType,
    proofLayer: normalizedProofLayer,
  };
}

// ==================== MEMORY / CONTRADICTION RESOLUTION ====================

// Detect if seller is surfacing a contradiction or challenging a prior statement
function detectContradictionProbe(sellerText) {
  const lower = sellerText.toLowerCase();
  const probePatterns = [
    'вы сказали', 'только что вы', 'раньше вы', 'вы же говорили', 'вы же упоминали',
    'но раньше', 'но вы говорили', 'противоречит', 'но вы же', 'вы написали',
    'вы упоминали', 'вы признали', 'вы говорили что', 'вы же только что',
    'сначала вы', 'вначале вы', 'пару минут назад'
  ];
  return probePatterns.some((p) => lower.includes(p));
}

// Persona-specific in-character contradiction resolution
function resolveContradiction(session) {
  const personaId = session.bot_id;
  const responses = {
    andrey: [
      'Я не говорил, что готов к переходу — я говорил, что хочу понять границу риска прежде чем двигаться дальше. Это разные вещи.',
      'Не противоречие. "Схема работает" — это не "схема надёжна". Меня интересует второе, а не первое.',
      'Я не говорил, что всё хорошо. Я говорил, что схема держится. "Держится" — это не "нет риска". Риск есть, и я его оцениваю.',
    ],
    alexey: [
      'Я не говорил, что менять не надо. Я говорил, что текущая схема пока тащит. "Пока тащит" — это не "всё устраивает". Вопрос — когда именно перестанет.',
      'Не противоречие. Crypto + Wise работает — это факт. Что именно в нём ломается — это отдельный вопрос. Я хочу понять второе.',
      'Схема работает — да. Это не значит, что она меня устраивает. Разные вещи. Продолжай.',
    ],
    cfo_round: [
      'Я говорила, что схема "как-то работает". Это не значит, что она defensible для следующего diligence. Это разные критерии.',
      'Не противоречие. То, что схема держится — не то, что инвестор будет доволен аудитом. Меня интересует второй сценарий.',
      'Текущая схема функционирует. Это не означает, что она готова к investor-level scrutiny. Разные вещи.',
    ],
    eng_manager: [
      'Я не говорил, что ничего менять не буду — я говорил, что мне нужно занести это в finance без лишнего геморроя. Это условие, не отказ.',
      'Не противоречие. Проблема есть — факт. Вопрос в том, как донести решение внутри без enterprise theatre. Это разные вещи.',
      'Я не отказываюсь. Я говорю, что у меня есть ограничение: finance нужно убедить. Это контекст, не стоп.',
    ],
    ops_manager: [
      'Я не говорила, что текущее устраивает — я говорила, что пока тащу процесс. "Тащу" — не "доволен". Если убираете ручной слой реально — разговор другой.',
      'Не противоречие. Процесс работает — это значит, я его держу руками. Именно это и есть проблема.',
      'Я не сказала, что хорошо. Я сказала, что справляюсь. "Справляюсь руками" — это именно то, что я хочу убрать.',
    ],
    head_finance: [
      'Я не говорила, что готова менять без понимания структуры. Я говорила, что нужно понять, что именно уходит на вашу сторону — и только потом можно говорить об изменениях.',
      'Не противоречие. То, что текущая схема "работает" — не значит, что её легко объяснять leadership. Именно это меня и беспокоит.',
      'Я не сказала, что всё устраивает. Я сказала, что схема функционирует. Объяснимость для совета — другой вопрос.',
    ],
    internal_legal: [
      'Я не говорила, что текущая схема устраивает. Я говорила, что добавление нового vendor само создаёт новые риски. Это разные вещи — устранить одно и не добавить другое.',
      'Не противоречие. Вопрос был про серые зоны в текущей схеме. Отдельный вопрос — появятся ли новые серые зоны с Mellow. Оба вопроса важны.',
      'Я не отказываюсь рассматривать. Я говорю, что любое изменение нужно оценивать так же строго, как текущую схему. Это последовательная позиция.',
    ],
    external_legal: [
      'Я не говорил, что текущая схема defensible — я говорил, что Mellow тоже нужно оценивать с той же строгостью. Требование одинаковое. Это не противоречие.',
      'Не противоречие. Текущая схема хрупкая — это факт. Mellow тоже нужно проверить на те же вопросы. Я оцениваю оба варианта по одному стандарту.',
      'Я не защищаю текущую схему. Я применяю один стандарт к обеим сторонам. Так работает внешний review.',
    ],
  };
  return pick(responses[personaId] || [
    'Не противоречие. Держите разделение: что я сказал про текущую ситуацию — и что именно мне нужно от вас. Это разные вещи.',
  ]);
}

// ==================== ROUTING ====================

function deduplicateReply(reply, session, responderFn) {
  const recent = session.meta._recent_bot_replies || [];
  let finalReply = reply;
  if (recent.includes(reply)) {
    // Same response about to repeat — advance irritation so routing diverges, then re-generate
    session.meta.irritation = Math.min(3, (session.meta.irritation || 0) + 0.5);
    if (responderFn) {
      // Try up to 5 alternatives to find a non-duplicate.
      // Track the "best" fallback: the alt seen longest ago (lowest index in recent).
      // This ensures we NEVER re-emit the original duplicate even when the pool is tiny.
      let found = false;
      let bestAlt = null;
      let bestAltAge = Infinity; // lower index in recent = seen longer ago = prefer
      for (let attempt = 0; attempt < 5; attempt++) {
        const alt = responderFn();
        if (!recent.includes(alt)) {
          finalReply = alt;
          found = true;
          break;
        }
        const idx = recent.indexOf(alt);
        if (idx < bestAltAge) {
          bestAltAge = idx;
          bestAlt = alt;
        }
      }
      if (!found) {
        // Pool is too small to find a truly fresh response — return the one seen
        // longest ago (avoids repeating the immediately-previous reply).
        finalReply = bestAlt !== null ? bestAlt : reply;
      }
    }
  }
  // Sliding window: keep last 4 bot replies (expanded from 2 to catch longer echo loops)
  session.meta._recent_bot_replies = [...recent.slice(-3), finalReply];
  return finalReply;
}

function applyPromptStyleToReply(reply, session) {
  const persona = personaMeta(session);
  const lowerPrompt = String(persona?.system_prompt || '').toLowerCase();
  const styleLines = persona?.prompt_style || [];
  let finalReply = String(reply || '').trim();

  if (!finalReply) return finalReply;

  // ── Length directives from system_prompt ────────────────────────────────
  // "one sentence" / "одно предложение" → trim to a single sentence
  if (
    lowerPrompt.includes('one sentence') || lowerPrompt.includes('одно предложение') ||
    styleLines.some((l) => /one sentence|одно предложение/i.test(l))
  ) {
    const first = finalReply.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (first) finalReply = first;
  } else if (
    // "short" / "brief" / "коротко" / "кратко" for ops OR anywhere in system_prompt
    lowerPrompt.includes('коротко') || lowerPrompt.includes('кратко') ||
    lowerPrompt.includes('short') || lowerPrompt.includes('brief') ||
    styleLines.some((l) => /коротко|кратко|short|brief/i.test(l))
  ) {
    const shortened = finalReply.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
    if (shortened) finalReply = shortened;
  }

  // ── Finance boundary nudge ───────────────────────────────────────────────
  if (persona?.archetype === 'finance' && lowerPrompt.includes('границ')) {
    finalReply = finalReply.replace(/^Ок\.\s*/i, 'Ок. ');
  }

  // ── Legal overclaim suffix ───────────────────────────────────────────────
  if (
    (persona?.archetype === 'legal' || lowerPrompt.includes('overclaim') || lowerPrompt.includes('overclaiming')) &&
    lowerPrompt.includes('overclaim') &&
    !/overclaim|границ|scope|responsibil/i.test(finalReply)
  ) {
    finalReply = `${finalReply} Без overclaim.`;
  }

  // ── Skeptical persona — append a doubt prompt on turns > 1 ──────────────
  if (
    session.meta.bot_turns >= 2 &&
    (lowerPrompt.includes('скептич') || lowerPrompt.includes('skeptic') ||
     styleLines.some((l) => /skeptic|скептич/i.test(l))) &&
    !finalReply.endsWith('?')
  ) {
    finalReply = `${finalReply} What makes you confident?`;
  }

  return finalReply;
}

function wrapEmailReply(reply, session) {
  return adaptTextToDialogue(reply, session, 'bot');
}

// ==================== RANDOM FACTOR ====================
// Simulates real-world buyer unpredictability: ghost (no reply), busy, or defer.
// Activated only from turn 1 onward; configurable per session.

const GHOST_MARKER = '__ghost__';

function randomFactorReply(session, sellerText = '') {
  const config = session.meta.randomizer_config || {};
  if (!config.random_factor_enabled) return null;
  const turn = session.meta.bot_turns || 0;
  if (turn === 0) return null; // Never ghost on first reply

  const persona = personaMeta(session) || {};
  const lower = String(sellerText || '').toLowerCase();
  const acceptanceStage = session?.meta?.acceptance_stage || getBuyerAcceptanceStage(session);
  const acceptanceState = session?.meta?.acceptance_state || getBuyerAcceptanceState(session);
  const antiSilenceProtected = turn >= 2
    && ['panic_churn_ops', 'grey_pain_switcher', 'cm_winback', 'direct_contract_transition'].includes(persona.id)
    && hasAny(lower, ['план', 'scheme', 'flow', 'incident', 'boundary', 'recovery', 'mapping', 'slice', 'transition', 'call', 'созвон', 'пилот', 'pilot']);
  const financeAntiGhostProtected = turn >= 2
    && isFinancePersonaId(persona.id)
    && ['written_step_accepted', 'written_step_then_call', 'review_call_ready', 'meeting_booked'].includes(acceptanceStage)
    && hasAny(lower, ['созвон', 'call', 'review', '15 минут', '15 minute', 'какой слот', 'когда удобно', 'when convenient', 'what slot works']);
  const postArtifactAskProtected = turn >= 2
    && ['artifact_only', 'artifact_then_call', 'narrow_walkthrough'].includes(acceptanceState)
    && sellerProposedBoundedReviewCall(session);
  if (antiSilenceProtected || financeAntiGhostProtected || postArtifactAskProtected) return null;

  const r = Math.random();
  const ghostP = Number(config.ghost_probability ?? 0);
  const busyP = Number(config.busy_probability ?? 0);
  const deferP = Number(config.defer_probability ?? 0);

  if (ghostP > 0 && r < ghostP) {
    // No reply — persona goes silent. Seller must follow up.
    return GHOST_MARKER;
  }
  if (busyP > 0 && r < ghostP + busyP) {
    // Very short busy dismissal
    return pick([
      'Busy right now.',
      'In a meeting — follow up next week.',
      'Not a good time. Try me in 10 days.',
      'Slammed this week.',
      'Can\'t talk now. Come back in two weeks.',
    ]);
  }
  if (deferP > 0 && r < ghostP + busyP + deferP) {
    // Acknowledge but defer — seller must follow up to re-engage
    return pick([
      "I'll look at this when I have a moment.",
      "Leave it with me — I'll come back if there are questions.",
      "Noted. Not ignoring you, just need time to think.",
      "I'll review and get back to you.",
      "I'll circle back on this.",
    ]);
  }
  return null;
}

// ==================== LLM INTEGRATION ====================

let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    _anthropicClient = new Anthropic({ apiKey: key });
  }
  return _anthropicClient;
}

function buildLlmSystemPrompt(session) {
  const persona = personaMeta(session);
  const systemPrompt = String(persona?.system_prompt || '').trim();
  if (!systemPrompt) return null;
  const lang = session.language === 'en' ? 'en' : 'ru';
  const assets = getRelevantSalesAssets(session, lang);
  const doctrine = compileDoctrineForSession(session);
  const doctrineGuidance = formatDoctrineGuidance(doctrine, { includeEmail: isEmailMode(session) });

  const card = session.sde_card || {};
  const cardContext = [
    card.signal_type ? `Signal type: ${card.signal_type}` : null,
    card.what_happened ? `What happened: ${card.what_happened}` : null,
    card.probable_pain ? `Probable pain: ${card.probable_pain}` : null,
    card.first_touch_hint ? `First touch hint: ${card.first_touch_hint}` : null,
    card.outreach_window ? `Outreach window: ${card.outreach_window}` : null,
    card.company ? `Company: ${card.company.name}, ${card.company.industry}, ${card.company.size}, ${card.company.hq}` : null,
    (card.dont_do || []).length ? `Do NOT: ${card.dont_do.join('; ')}` : null,
    (card.apollo_context || []).length ? `Context facts: ${card.apollo_context.join('; ')}` : null,
  ].filter(Boolean).join('\n');

  let fullSystem = systemPrompt;
  if (cardContext) {
    fullSystem += `\n\n--- ACTIVE SIGNAL CARD ---\n${cardContext}`;
  }

  if (doctrineGuidance) {
    fullSystem += `\n\n--- COMPILED DOCTRINE ---\n${doctrineGuidance}`;
  }

  const emailPrompt = String(persona?.email_prompt || '').trim();
  if (isEmailMode(session) && emailPrompt) {
    fullSystem += `\n\n--- EMAIL MODE INSTRUCTIONS ---\n${emailPrompt}`;
  }

  const buyerState = normalizeBuyerState(session.buyer_state || buildInitialBuyerState(session), session);
  const activeConcern = getActiveConcern(session);
  fullSystem += `\n\n--- CURRENT BUYER STATE ---\nPatience: ${buyerState.patience}/100\nInterest: ${buyerState.interest}/100\nPerceived value: ${buyerState.perceived_value}/100\nConversation capacity: ${buyerState.conversation_capacity} remaining seller turns\nTrust: ${buyerState.trust}/100\nClarity: ${buyerState.clarity}/100\nReply likelihood: ${buyerState.reply_likelihood}\nDisengagement risk: ${buyerState.disengagement_risk}\n${activeConcern ? `Current concern: ${activeConcern}\n` : ''}Behavior rule: if trust is low, respond colder and more skeptical; if clarity is low but interest exists, ask for clarification; if conversation capacity is near zero, reply briefly or disengage.`;
  fullSystem += `\nProgression rule: do not generate endless fresh objections just to keep the dialogue alive. If the seller has answered the current concern with concrete mechanism or economics, advance naturally to the next narrow step that fits the persona and context, for example asking for a short written note, accepting a bounded review call, or explicitly agreeing to a short meeting.`;
  fullSystem += `\nObjection rule: objections must arise from the persona's actual role, current concern, and what is still missing in this dialogue. Do not jump to a random new objection if the previous one was addressed well enough.`;

  const difficultyTier = session?.difficulty_tier || 1;
  if (difficultyTier === 2) {
    fullSystem += '\n\n--- DIFFICULTY TIER 2: SKEPTICAL ---\nYou are more skeptical than usual from the first message. Challenge any claim not backed by specifics. Push back directly when the seller is vague or generic. Your patience is shorter — express impatience clearly when deserved. Do not reward safe or generic pitches.';
  } else if (difficultyTier >= 3) {
    fullSystem += '\n\n--- DIFFICULTY TIER 3: RESISTANT ---\nYou are actively resistant from turn 1. Challenge assumptions, probe for gaps in the seller\'s logic, and disengage earlier than normal. Apply friction throughout: ask pointed questions that expose weaknesses, express skepticism by default, and do not reward any approach that lacks specificity or clear value framing.';
  }

  fullSystem += `\n\n--- AVAILABLE SELLING ASSETS THE SELLER MAY USE ---\nCase snippet: ${assets.caseSnippet}\nStructured written proof asset: ${assets.writtenProof}\nCalculator asset: ${assets.calculator}\nUsage logic: case snippet works as narrow proof after a concrete concern appears; written proof works as a bounded next step; calculator is a review-stage or economics-stage asset, not an opening pitch. Do not reward asset-dumping. Reward precise use of one relevant asset at the right moment.`;

  return fullSystem;
}

function buildLlmMessages(session) {
  return (session.transcript || [])
    .filter((m) => m.role === 'seller' || m.role === 'bot')
    .map((m) => ({
      role: m.role === 'seller' ? 'user' : 'assistant',
      content: m.text,
    }));
}

async function generateLlmReply(session, sellerText) {
  const client = getAnthropicClient();
  if (!client) return null;

  const systemPrompt = buildLlmSystemPrompt(session);
  if (!systemPrompt) return null;

  try {
    const messages = buildLlmMessages(session);
    // The current seller turn is already in session.transcript at this point
    // (added before generateBotReply is called), so just pass all history
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages: messages.length ? messages : [{ role: 'user', content: sellerText }],
    });
    const text = response.content?.[0]?.text;
    return text ? String(text).trim() : null;
  } catch (err) {
    console.error('[LLM] generateLlmReply error:', err?.message || err);
    return null;
  }
}

// Step 7: Exploration policy — prevents local optimum / repetitive safe hints.
// 70% exploit (best-known pattern), 20% adjacent variation, 10% exploratory.
function pickExplorationStrategy() {
  const r = Math.random();
  if (r < 0.70) return 'exploit';
  if (r < 0.90) return 'adjacent';
  return 'explore';
}

// Step 6: Build a hint-generation system prompt conditioned on contrastive memory.
// The prompt instructs Claude to maximize trust/clarity, improve next-step probability,
// avoid historically harmful patterns, and produce a concise stage-specific hint.
// strategy: 'exploit' | 'adjacent' | 'explore' (Step 7 exploration policy)
function buildFirstHintSystemPrompt(session, snapshot, strategy = 'exploit', recentOpeners = [], uiStrategy = null) {
  const card = session.sde_card || {};
  const contact = card.contact || {};
  const company = card.company || {};
  const persona = personaMeta(session);
  const contrastive = snapshot?.contrastive || {};
  const lang = session.language === 'en' ? 'English' : 'Russian';
  const assets = getRelevantSalesAssets(session, session.language === 'en' ? 'en' : 'ru');
  const doctrine = compileDoctrineForSession(session);
  const doctrineGuidance = formatDoctrineGuidance(doctrine, { includeEmail: isEmailMode(session) });

  const lines = [
    `You are an expert B2B sales coach writing the first opening hint for an SDR at Mellow.io.`,
    `Mellow is a Contractor of Record (CoR) platform: KYC, contractor docs, payment chain, audit trail — all on Mellow's side.`,
    `Mellow helps companies manage contractors compliantly: payments, documentation, classification, audit-ready payout flow.`,
    ``,
    `## Task`,
    `Write ONE concise first-touch message hint for the SDR to send to this buyer as their opening outreach.`,
    `Ground the hint in the signal below. Do not infer internal buyer psychology — only use what is shown here.`,
    ``,
    `## Optimization objectives`,
    `1. Open through a specific signal, not a generic pitch`,
    `2. Use SPIN on the first turn: Situation first, then Problem. Do not jump to implication or pitch in the opener`,
    `3. Maximize trust and clarity — never overclaim, never use vague marketing language`,
    `4. Sound like a real expert: high product mastery, but explained simply, precisely, and without term abuse`,
    `5. Sound human, not AI: no buzzword stacks, no synthetic symmetry, no consultant tone`,
    `6. Show sincere buyer empathy: care about the buyer's problem, notice both factual and emotional detail, and respond with calm attention rather than pressure`,
    `7. Keep language clean: if the hint is in Russian, do not slip into English sales words unless it is a fixed market term`,
    `8. Be concise: 1–3 sentences, natural seller voice`,
    `9. Opening turn is diagnosis only: ask at most one focused question and do NOT propose a call or meeting in the first message`,
    ``,
    `## Seller tone of voice doctrine`,
    `You are not a generic SDR. You are a mature product expert who understands Mellow deeply and therefore explains it simply, precisely, and convincingly.`,
    `Your authority comes from clarity, not jargon. If a term is not necessary, do not use it.`,
    `You genuinely care about the buyer's problem. Do not treat the buyer like an objection machine. Track both the factual issue and the emotional pressure around it.`,
    `The seller must sound sincerely interested in helping the buyer, not just converting them. The buyer should feel the seller wants to reduce confusion, risk, and unnecessary work even before any meeting is booked.`,
    `Write like a thoughtful human expert: attentive, calm, specific, commercially sharp, but never plastic, needy, or over-eager.`,
    `Do not sound like AI-generated copy. Avoid symmetrical phrasing, stacked buzzwords, empty transitions, and over-produced wording.`,
    `The buyer should feel: this person understands the product, understands my situation, and is trying to help me think clearly.`,
    `If there is a tradeoff, tension, or limitation, acknowledge it honestly instead of forcing optimism. Genuine help beats smooth persuasion.`,
    `Mellow values must be visible in the hint: reliability (things work under pressure), streamlining (less manual chaos, cleaner flow), and ownership (we do not shrug when something breaks).`,
    `Trust is often earned through a concrete micro-story, not a slogan. When useful, ground the point in a tiny operational vignette: what the buyer sees before payment, who owns the issue if something slips, or what manual burden disappears.`,
    doctrineGuidance ? `Compiled doctrine: ${doctrineGuidance.replace(/\n/g, ' | ')}` : '',
    ``,
    `## Selected signal`,
    `Signal type: ${card.signal_type || 'unknown'}`,
    `Heat: ${card.heat || 'unknown'}`,
    `Outreach window: ${card.outreach_window || 'unknown'}`,
    `What happened: ${card.what_happened || ''}`,
    `Signal context: ${card.rendered_text || card.what_happened || ''}`,
    `Probable pain: ${card.probable_pain || ''}`,
    `First-touch guidance: ${card.first_touch_hint || ''}`,
    card.dont_do?.length ? `Do not: ${card.dont_do.join('; ')}` : '',
    ``,
    `## Buyer public summary`,
    `Name: ${contact.name || 'Unknown'}`,
    `Profession: ${contact.title || 'Decision maker'}`,
    `Role (training): ${persona?.role || 'Buyer'}`,
    `Company: ${company.name || 'Unknown'}${company.industry ? `, ${company.industry}` : ''}`,
    `Location: ${company.hq || 'Unknown'}`,
    `Language: ${lang} — the hint MUST be written in ${lang}`,
    ``,
    `## Available assets`,
    `Case snippet: ${assets.caseSnippet}`,
    `Structured written proof asset: ${assets.writtenProof}`,
    `Calculator asset: ${assets.calculator}`,
    `Use rule: opener should not dump assets. Mention an asset only if it helps anchor the signal in a concrete proof path, and never use calculator as first-touch pitch.`,
  ].filter((line) => line !== '');

  if (contrastive.copy_from?.length) {
    lines.push(``, `## Successful opening hints to learn from (adapt structure, do not copy verbatim)`);
    for (const r of contrastive.copy_from) {
      const score = r.final_normalized_score != null ? r.final_normalized_score.toFixed(2) : '?';
      lines.push(`- [score ${score}]: "${r.hint_text}"`);
    }
  }

  if (contrastive.avoid?.length) {
    lines.push(``, `## Failed hints to avoid (caused trust drop or disengagement)`);
    for (const r of contrastive.avoid) {
      const score = r.final_normalized_score != null ? r.final_normalized_score.toFixed(2) : '?';
      const flags = r.negative_flags?.join(', ') || '';
      lines.push(`- [score ${score}${flags ? `, flags: ${flags}` : ''}]: "${r.hint_text}"`);
    }
  }

  if (recentOpeners.length > 0) {
    lines.push(
      ``,
      `## Anti-repetition (do not reuse these recent openers)`,
      `Do not reproduce any of the following recently used opening lines verbatim or near-verbatim. Generate a meaningfully different approach — different angle, different entry point, or different emphasis:`,
      ...recentOpeners.map((o) => `- "${o}"`),
    );
  }

  if (contrastive.copy_from?.length) {
    lines.push(
      ``,
      `## Structural anchor requirement`,
      `Your hint MUST apply at least one structural move from the successful hints listed above.`,
      `Named structural moves: signal_led_open (reference a specific observable signal from the buyer context), mechanism_specificity (name the exact Mellow mechanism that resolves the pain), scope_boundary (explicitly limit the claim — "не обещаем снять риск целиком, но убираем X"), proof_point (cite a concrete data point or outcome from the signal context), spin_question (one focused SPIN situation/problem question).`,
    );
  }

  lines.push(
    ``,
    `## Output format`,
    `Return ONLY the hint text. No preamble, no labels, no explanation, no quotes.`,
    `Write as if the SDR is sending this opening message directly to the buyer.`,
    `Use a human ToV: calm, specific, grounded, expert but easy to understand, attentive to the buyer's real pressure, slightly sharp when needed, but never robotic or over-styled.`,
    `Writing test: if the line sounds like polished AI sales copy, rewrite it mentally before answering. Prefer clean human phrasing over impressive phrasing.`,
    `Voice test: the seller should sound like a deeply informed expert who genuinely cares and can explain difficult product reality simply, precisely, and with emotional attentiveness.`,
    `Hard rules: no meeting ask, no calendar ask, no more than one question mark, and no broad multi-part pitch. The opening must follow SPIN Situation or Problem mode only. In Russian, keep the wording fully Russian unless a fixed term is unavoidable.`,
  );

  return lines.join('\n');
}

function buildHintGenerationSystemPrompt(session, snapshot, strategy = 'exploit', recentOpeners = [], uiStrategy = null) {
  const persona = personaMeta(session);
  const concern = getActiveConcern(session);
  const policy = getHintPolicyContext(session);
  const buyerState = policy.buyerState;
  const sellerTurnCount = session.transcript.filter((m) => m.role === 'seller').length;

  if (sellerTurnCount === 0) {
    return buildFirstHintSystemPrompt(session, snapshot, strategy, recentOpeners, uiStrategy);
  }

  const turnStage = snapshot?.context?.turn_stage || 'mid';
  const contrastive = snapshot?.contrastive || {};
  const lang = session.language === 'en' ? 'English' : 'Russian';
  const assets = getRelevantSalesAssets(session, session.language === 'en' ? 'en' : 'ru');
  const doctrine = compileDoctrineForSession(session);
  const doctrineGuidance = formatDoctrineGuidance(doctrine, { includeEmail: isEmailMode(session) });

  const resolvedCount = Object.keys(session.meta?.resolved_concerns || {}).length;
  const askReady = policy.askAllowed;
  const progressionStage = policy.progressionStage;
  const trustRepairNeeded = policy.repairState;
  const askType = policy.askType;
  const hintVariant = getHintVariant(session, policy.hintStage);
  const hintSchema = computeHintSchema(session, policy);
  const personaSellingPolicy = getPersonaSellingPolicy(session);
  const personaValueFrames = getPersonaValueFrameSummary(session);
  const latestBuyerReply = latestBuyerReplyText(session);

  const askTypeDescriptions = {
    written_first: 'written artifact first (1-pager, memo, or brief), then invite a short call',
    direct_call: 'direct call proposal — buyer trust and clarity are high enough to skip the artifact',
    narrow_walkthrough: 'narrow-scope walkthrough (15 min, specific topic only) — trust was recovering, avoid a broad pitch',
  };
  const spinLane = getSpinLane(session, policy);
  const spinInstruction = getSpinInstruction(session, policy);
  const sandlerInstruction = getSandlerInstruction(session, policy);

  const lines = [
    `You are an expert B2B sales coach writing a single seller hint for an SDR at Mellow.io.`,
    `Mellow is a Contractor of Record (CoR) platform: KYC, contractor docs, payment chain, audit trail on our side.`,
    ``,
    `## Task`,
    `Write ONE concise seller message hint for the SDR to send to the buyer right now.`,
    `The hint must be stage-specific, persona-aware, and conditioned on the contrastive memory below.`,
    `You MUST produce exactly one hint mode for this turn: ${policy.hintStage}.`,
    ``,
    `## Primary KPI`,
    `Meeting conversion — the dialogue succeeds only when the buyer explicitly agrees to a call or meeting.`,
    `"Good sales behavior" that never results in a booked next step is a failure against the real KPI.`,
    ``,
    `## Optimization objectives (strict priority order)`,
    `1. Book the meeting — every hint must move toward explicit buyer agreement on a call or meeting`,
    `2. Earn the ask — build trust and resolve concerns to create conditions for a credible ask`,
    `3. Avoid harmful patterns — never overclaim, never use vague marketing language`,
    `4. Sound like a real expert: deep product understanding explained simply, precisely, and without term abuse`,
    `5. Sound human: no AI cadence, no buzzword piles, no consultant-style abstraction`,
    `6. Be sincerely empathetic: care about the buyer's problem, track both factual and emotional detail, and avoid indifferent sales pressure`,
    `7. Keep language clean: if the hint is in Russian, do not slip into English sales words unless it is a fixed market term`,
    `8. Be concise: 1–3 sentences maximum, natural seller voice`,
    `9. One hint = one action. Ask one question or propose one next step, never both multiple times.`,
    ``,
    `## Seller tone of voice doctrine`,
    `You are not a generic SDR. You are a mature product expert who understands Mellow deeply and therefore explains it simply, precisely, and convincingly.`,
    `Your authority comes from clarity, not jargon. If a term is not necessary, do not use it.`,
    `You genuinely care about the buyer's problem. Do not treat the buyer like an objection machine. Track both the factual issue and the emotional pressure around it.`,
    `Write like a thoughtful human expert: attentive, calm, specific, commercially sharp, but never plastic, needy, or over-eager.`,
    `Do not sound like AI-generated copy. Avoid symmetrical phrasing, stacked buzzwords, empty transitions, and over-produced wording.`,
    `The buyer should feel: this person understands the product, understands my situation, and is trying to help me think clearly.`,
    ``,
    `## Buyer context`,
    `Persona: ${persona?.name || 'Unknown'} (${persona?.archetype || 'finance'} archetype)`,
    `Progression stage: ${progressionStage} (opening → diagnosis → proof → trust_repair → pre_ask → closing)`,
    `Required hint mode for this turn: ${policy.hintStage}`,
    `Active concern: ${concern || 'none — concerns addressed'}`,
    `Most recent buyer reply: ${latestBuyerReply || 'n/a'}`,
    `Resolved concerns: ${resolvedCount}`,
    `Buyer state:`,
    `  Trust: ${buyerState.trust}/100`,
    `  Clarity: ${buyerState.clarity}/100`,
    `  Interest: ${buyerState.interest}/100`,
    `  Patience: ${buyerState.patience}/100`,
    `  Reply likelihood: ${buyerState.reply_likelihood}`,
    `  Next-step likelihood: ${buyerState.next_step_likelihood}`,
    `Language: ${lang} — the hint MUST be written in ${lang}`,
    ``,
    `## Hint doctrine packet`,
    `Obstacle to progress: ${hintSchema.obstacle_to_progress}`,
    `Missing condition: ${hintSchema.missing_condition}`,
    `Recommended action: ${hintSchema.recommended_action}`,
    `Forbidden action: ${hintSchema.forbidden_action}`,
    `Exact concern discipline: answer the buyer's most recent question directly before doing anything else. If the buyer asked about mechanics / scope / payment flow / documents / incidents, answer those specifics directly. If the buyer asked about economics / premium / FX / total cost, answer that math directly. Do NOT switch to a neighboring concern just because it is relevant.`,
    `SPIN lane for this turn: ${spinLane}`,
    `SPIN instruction: ${spinInstruction}`,
    `Sandler instruction: ${sandlerInstruction}`,
    `Persona value priority: ${personaValueFrames}`,
    `Preferred bridge asset: ${personaSellingPolicy.bridge_label}`,
    `Available case snippet: ${assets.caseSnippet}`,
    `Available structured written proof asset: ${assets.writtenProof}`,
    `Available calculator asset: ${assets.calculator}`,
    `Asset use rule: use at most one main asset in this hint. Case snippet is for proof, written proof is for bounded next-step, calculator is mainly for economics/review stage, not for opener or generic pitch.`,
    doctrineGuidance ? `Compiled doctrine: ${doctrineGuidance.replace(/\n/g, ' | ')}` : '',
    `Critical seam rule: if the buyer already accepted a written step or said they will review the material, do NOT repeat the material offer. Answer the remaining doubt directly, then convert to one bounded 15-minute review call tied to that material.`,
    ``,
    ...(hintVariant !== 'first_attempt' ? [
      `## ⚠️ Retry variant: ${hintVariant}`,
      `Prior ${policy.hintStage} hints at this stage did not produce buyer progress.`,
      `You MUST use a meaningfully different angle, entry point, or framing than what was tried before.`,
      `Do NOT rephrase the previous hint cosmetically — generate a structurally distinct approach.`,
      `If prior hints asked a question, try a different question topic. If they used proof, try a different mechanism.`,
      ``,
    ] : []),
    policy.hintStage === 'direct_ask'
      ? [
          `⚡ ASK-READY: Conditions are met — propose the next step this turn.`,
          `Use SPIN Need-payoff, not a generic close: make the benefit of the short call explicit and concrete.`,
          `Use Sandler upfront contract: state exactly what the call is for, how narrow it is, and what the buyer gets from it.`,
          `Ask type for this persona+state: ${askTypeDescriptions[askType] || askTypeDescriptions.written_first}`,
          `Be direct and specific. Match the ask format to the persona: finance/legal personas prefer a written artifact first, ops personas can go direct.`,
        ].join('\n')
      : policy.hintStage === 'repair'
        ? `🔧 TRUST-REPAIR MODE: Trust dropped (miss_streak active, trust=${buyerState.trust}/100). Use SPIN Problem mode. Use Sandler low-pressure repair. Do NOT propose a meeting this turn. Sharpen the message, address the specific concern that caused the drop, and ask one focused question to rebuild momentum.`
        : policy.hintStage === 'bridge_step'
          ? `🪜 BRIDGE-STEP MODE: Use SPIN Need-payoff. Use Sandler upfront contract. Do NOT jump to a broad call ask unless it matches the required ask type. Offer exactly one bounded next step that earns the later meeting: ${askTypeDescriptions[askType] || askTypeDescriptions.written_first}. State purpose, scope, and expected outcome clearly.`
          : policy.hintStage === 'proof'
            ? `🧾 PROOF MODE: Use SPIN Implication. Use Sandler pain-first discipline. Do NOT ask for a meeting this turn. Resolve the active concern by sharpening consequence, mechanism, or downside, then ask one focused follow-up question if needed. If the latest buyer reply asks for a specific mechanism or cost explanation, the first sentence must answer that exact request directly. Prefer one concrete operational example over abstract assurance.`
            : `🔎 DIAGNOSIS MODE: Use SPIN ${spinLane === 'situation' ? 'Situation' : 'Problem'}. Use Sandler pain-first qualification. Do NOT pitch broadly and do NOT ask for a meeting. Ask one focused question that surfaces the next missing condition for progression.`,
  ];

  if (uiStrategy?.moveType || uiStrategy?.proofLayer) {
    const moveHint = {
      clarify: 'Bias toward clarification: one sharp question or one direct answer that narrows the real issue. Do not widen scope.',
      prove: 'Bias toward proof: use one concrete mechanism, example, or evidence layer instead of another abstract explanation.',
      ask: 'Bias toward ask: if stage rules allow, make the next step explicit and bounded. If stage rules do not allow, earn the ask instead of forcing it.',
    }[uiStrategy.moveType] || null;
    const proofHint = {
      case: 'Prefer case-snippet style proof when proof is warranted.',
      one_screen: 'Prefer one-screen written proof framing when a proof or bridge step is warranted.',
      calculator: 'Prefer calculator/economics framing only when the buyer is already in economics or review mode.',
    }[uiStrategy.proofLayer] || null;
    lines.push('', '## Operator framing preference', [moveHint, proofHint].filter(Boolean).join(' '));
  }

  if (uiStrategy?.moveType || uiStrategy?.proofLayer) {
    const moveHint = {
      clarify: 'operator wants a clarify move, so prefer sharper diagnosis and a narrower question',
      prove: 'operator wants a proof move, so prefer concrete mechanism or evidence over extra discovery',
      ask: 'operator wants an ask move, but opening-stage rules still win, so only lean toward a clearer direction of travel, not a meeting ask',
    }[uiStrategy.moveType] || null;
    const proofHint = {
      case: 'if proof is appropriate, prefer a tiny case snippet rather than abstract claims',
      one_screen: 'if proof is appropriate, orient toward a one-screen written proof as the likely next bounded asset',
      calculator: 'if proof is appropriate, orient toward economics structure, but do not jump into calculator mode in the opener unless the signal itself clearly justifies it',
    }[uiStrategy.proofLayer] || null;
    lines.push('', '## Operator framing preference', [moveHint, proofHint].filter(Boolean).join('; '));
  }

  if (contrastive.copy_from?.length) {
    lines.push(``, `## Successful hints to learn from (adapt structure and specificity, do not copy verbatim)`);
    for (const r of contrastive.copy_from) {
      const score = r.final_normalized_score != null ? r.final_normalized_score.toFixed(2) : '?';
      const mp = r.meeting_progress ? ', led to meeting progress' : '';
      lines.push(`- [score ${score}${mp}]: "${r.hint_text}"`);
    }
  }

  if (contrastive.avoid?.length) {
    lines.push(``, `## Failed hints to avoid (caused trust drop or disengagement — do not replicate)`);
    for (const r of contrastive.avoid) {
      const score = r.final_normalized_score != null ? r.final_normalized_score.toFixed(2) : '?';
      const flags = r.negative_flags?.join(', ') || '';
      lines.push(`- [score ${score}${flags ? `, flags: ${flags}` : ''}]: "${r.hint_text}"`);
    }
  }

  if (contrastive.winning_patterns?.length) {
    lines.push(``, `## Winning structural patterns (prioritize these in your hint)`);
    for (const p of contrastive.winning_patterns) {
      lines.push(`- ${p.dimension} (avg_score: ${p.avg_score}, delta vs failures: +${p.delta})`);
    }
  }

  if (contrastive.avoid_patterns?.length) {
    lines.push(``, `## Avoid patterns (found in failed hints — exclude from your output)`);
    for (const p of contrastive.avoid_patterns) {
      lines.push(`- ${p.flag} (appeared ${p.count}x in failures)`);
    }
  }

  // Step 7: Exploration policy — shape generation based on strategy
  const strategyInstructions = {
    exploit: [
      `## Generation mode: exploit`,
      `Follow the successful patterns above closely. Maximize similarity to the highest-scoring hints.`,
      `Prioritize proven structure: same specificity level, same proof elements, same next-step framing.`,
    ],
    adjacent: [
      `## Generation mode: adjacent variation`,
      `Take the best pattern above as your starting point but vary the angle or framing.`,
      `Try a different entry point or emphasis for the same concern — explore one step away from the best-known approach.`,
      `Do not copy the successful hint verbatim; introduce a meaningful structural variation.`,
    ],
    explore: [
      `## Generation mode: explore`,
      `Do not anchor to the historical patterns above. Generate a fresh approach.`,
      `Try a different angle entirely — different entry point, different framing, different emphasis.`,
      `The goal is to discover a new pattern that may outperform current best, not to replicate it.`,
    ],
  };
  lines.push(``, ...(strategyInstructions[strategy] || strategyInstructions.exploit));

  if (recentOpeners.length > 0) {
    lines.push(
      ``,
      `## Anti-repetition (do not reuse these recent openers)`,
      `Do not reproduce any of the following recently used seller lines verbatim or near-verbatim. Generate a meaningfully different approach — different angle, different entry point, or different emphasis:`,
      ...recentOpeners.map((o) => `- "${o}"`),
    );
  }

  if (contrastive.copy_from?.length) {
    lines.push(
      ``,
      `## Structural anchor requirement`,
      `Your hint MUST apply at least one structural move from the successful hints listed above.`,
      `Named structural moves: signal_led_open (reference a specific observable signal from context), mechanism_specificity (name the exact Mellow mechanism resolving the pain), scope_boundary (explicitly limit the claim to avoid overclaiming), proof_point (cite a concrete data point or outcome).`,
    );
  }

  lines.push(
    ``,
    `## Output format`,
    `Return ONLY the hint text. No preamble, no labels, no explanation, no quotes.`,
    `Write as if the SDR is sending this message directly to the buyer.`,
    `Use a human ToV: concise, grounded, commercially sharp, expert but easy to understand, and genuinely attentive to the buyer's pressure, with natural rhythm rather than generated symmetry.`,
    `Writing test: if the line sounds like polished AI sales copy, rewrite it mentally before answering. Prefer clear human phrasing over clever phrasing.`,
    `Voice test: the seller should sound like a deeply informed expert who genuinely cares and can explain difficult product reality simply, precisely, and with emotional attentiveness.`,
    `Hard rules: do not mix diagnosis + proof + ask in one hint. Do not include more than one question mark. Do not include a meeting ask unless the required hint mode is direct_ask or the allowed bridge-step form explicitly includes it. If you propose a next step, frame it as a Sandler-style upfront contract with clear purpose, scope, and expected outcome. In Russian, keep the wording fully Russian unless a fixed term is unavoidable. Never use vague trust language like "we are reliable" without a mechanism, owner, or concrete flow example. The seller must come across as sincerely trying to help, not as pushing toward a meeting for its own sake.`,
  );

  return lines.join('\n');
}

// Step 6: LLM-based hint generation conditioned on contrastive retrieval from Step 5.
// strategy (Step 7): 'exploit' | 'adjacent' | 'explore' — controls exploration policy.
// Returns a generated hint string, or null if LLM is unavailable or fails.
async function generateLlmHint(session, lang = null, snapshot = null, strategy = null, uiStrategy = null) {
  const client = getAnthropicClient();
  if (!client) return null;

  const recentOpeners = loadHintRecency();
  const snap = snapshot || buildHintMemorySnapshot(session, lang);
  const systemPrompt = buildHintGenerationSystemPrompt(session, snap, strategy || 'exploit', recentOpeners, uiStrategy);

  const recentBotMessages = (session.transcript || [])
    .filter((m) => m.role === 'bot')
    .slice(-2)
    .map((m) => m.text);

  const userMsg = recentBotMessages.length
    ? `The buyer's most recent replies:\n${recentBotMessages.join('\n')}\n\nWrite the next seller hint.`
    : `This is the opening turn. Write the first seller hint.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = response.content?.[0]?.text;
    if (!text) return null;
    const effectiveLang = session?.language === 'en' ? 'en' : 'ru';
    const hint = normalizeSellerLanguage(String(text).trim(), effectiveLang);
    // Track the opener for anti-repetition across sessions
    const firstLine = hint.split(/[.!?]/)[0].trim().slice(0, 120);
    if (firstLine) saveHintRecency([...recentOpeners, firstLine]);
    return hint;
  } catch (err) {
    console.error('[LLM] generateLlmHint error:', err?.message || err);
    return null;
  }
}

async function generateBotReply(session, sellerText) {
  const buyerStateReply = stateDrivenReplyOverride(session, sellerText);
  if (buyerStateReply !== undefined) {
    if (buyerStateReply === null) return null;
    return isEmailMode(session) ? wrapEmailReply(buyerStateReply, session) : buyerStateReply;
  }

  // Random factor check — may short-circuit to ghost/busy/defer
  const rfReply = randomFactorReply(session, sellerText);
  if (rfReply !== null) {
    if (rfReply === GHOST_MARKER) return null; // null = no reply this turn
    if (isEmailMode(session)) return wrapEmailReply(rfReply, session);
    return rfReply;
  }

  // Try LLM-based reply first (uses system_prompt + full conversation context)
  const llmReply = await generateLlmReply(session, sellerText);
  if (llmReply) return llmReply;

  // Fallback: rules-based engine (used when no ANTHROPIC_API_KEY or LLM fails)
  // Contradiction resolution takes priority — responds in character to "you said X but earlier..."
  if (detectContradictionProbe(sellerText) && (session.meta.bot_turns || 0) >= 1) {
    const contraFn = () => resolveContradiction(session);
    let reply = deduplicateReply(contraFn(), session, contraFn);
    if (isEmailMode(session)) reply = wrapEmailReply(reply, session);
    return reply;
  }
  const archetype = personaMeta(session).archetype;
  const isEN = session.language === 'en';
  let responder;
  if (isEN) {
    if (archetype === 'finance') responder = () => respondFinanceEN(session, sellerText);
    else if (archetype === 'legal') responder = () => respondLegalEN(session, sellerText);
    else responder = () => respondOpsEN(session, sellerText);
  } else {
    if (archetype === 'finance') responder = () => respondFinance(session, sellerText);
    else if (archetype === 'legal') responder = () => respondLegal(session, sellerText);
    else responder = () => respondOps(session, sellerText);
  }
  let reply = applyPromptStyleToReply(responder(), session);
  reply = deduplicateReply(reply, session, () => applyPromptStyleToReply(responder(), session));
  if (isEmailMode(session)) reply = wrapEmailReply(reply, session);
  return reply;
}

// ==================== ENGLISH RESPONSE ENGINE ====================

function respondFinanceEN(session, sellerText) {
  const lower = sellerText.toLowerCase();
  const turn = session.meta.bot_turns || 0;
  const claims = session.meta.claims || {};
  const persona = personaMeta(session);
  const trust = session.meta.trust || 1;
  const irritation = session.meta.irritation || 0;
  const flags = session.meta.flags || {};

  if (isMisclassificationBlocker(sellerText)) {
    session.meta.flags = { ...flags, blocker: true };
    return pick([
      "You're promising to remove misclassification risk? That kind of overclaim is exactly what destroys trust. What's actually in your scope?",
      "Stop. If you're guaranteeing misclassification protection — this conversation ends here. State your actual boundary of responsibility.",
      "That's the overclaim that kills credibility instantly. Where exactly does Mellow's responsibility end?",
    ]);
  }

  if (turn === 0) {
    if (!hasAny(lower, ['audit', 'review', 'due', 'diligence', 'round', 'series', 'invest', '23', 'wise', 'payoneer', 'contractor', 'reconcil'])) {
      return pick([
        "Too generic. What specifically in our situation made you reach out right now?",
        "Sounds like a standard vendor pitch. What did you actually see in our context before writing?",
        "I get these every week. What's different about yours — what do you know about our specific situation?",
        "Too vague. What exactly did you notice about us that led to this message?",
      ]);
    }
    if (persona.id === 'cfo_round') {
      return pick([
        "Ok, you noticed the round context. Right away then: what exactly does Mellow make more structured before diligence, and where does your scope end?",
        "Got it, you're tracking the fundraise. Concretely: what simplifies for the next diligence, and where does Mellow's control stop?",
        "You noticed the round. So directly: what part of contractor documentation do you cover, and what stays with me?",
      ]);
    }
    if (persona.id === 'head_finance') {
      return pick([
        "Context noted. I need the boundary: what's exactly in your scope, what's mine — clearly, without declarations.",
        "Ok. What specifically do you control — documents, reconciliation, audit? Where does your scope end?",
        "Good. But I need to explain this upward — in two sentences, no pitch. What's exactly your zone?",
      ]);
    }
    return pick([
      "Ok, you at least saw the context. Right away: what exactly does Mellow control, and where does your responsibility end?",
      "Fine. Straight to it: what's in your scope, what's not? Payment chain, documents, KYC?",
      "Good. Then without preamble: what Mellow controls, what it doesn't, and how that's substantiated?",
      "I see you did your homework. Immediate question: payment chain, documents, KYC — what's in your scope, what's not?",
    ]);
  }

  if (hasAny(lower, ['call', 'meeting', '15 minute', '20 minute', 'follow', 'material', 'memo', 'calculation', 'review'])) {
    if (session.meta._memo_requested) {
      session.meta._memo_follow_up_count = (session.meta._memo_follow_up_count || 0) + 1;
      if (session.meta._memo_follow_up_count >= 1) {
        return pick([
          "Ok. Send it and let's find 20 minutes to review.",
          "Fine. If the numbers are real, I'll do a 20-minute call.",
          "Sure, send it over — if it's concrete, let's schedule a call.",
        ]);
      }
      return pick([
        "Waiting for the materials. When will you send them?",
        "Agreed. Waiting for your email.",
        "Ok. Send it over — I'll review.",
      ]);
    }
    session.meta._memo_requested = true;
    if (persona.id === 'cfo_round') {
      return pick([
        "Ok. Send a short summary: payment flow, audit story, what simplifies before diligence. If it's grounded, I'll give you 20 minutes.",
        "Fine. Send the flow and audit story — brief, no fluff. If it's real, we can talk for 20 minutes.",
        "Send a written summary: what's in Mellow's scope, what's not, how it looks before the investor round. If it's clean — we'll find time.",
      ]);
    }
    if (persona.id === 'head_finance') {
      return pick([
        "Ok. Send flow, SLA and how manual reconciliation is reduced. If it's concrete, I'll find a slot this week.",
        "Fine. Send flow and SLA on one screen. If there's no fluff, we'll do 20 minutes.",
        "Send a summary: flow, SLA and what gets removed from manual reconciliation. If the numbers are real — we'll talk.",
      ]);
    }
    return pick([
      "Ok. Send me a brief written summary: payment flow, audit story, scope boundary. If it's concrete, I'll do a 20-minute call.",
      "Fine. Send the flow and SLA. If it's grounded, we can talk.",
      "Send a one-page summary: scope, documents, SLA on incidents. If it's without fluff — we'll find time.",
    ]);
  }

  // Jump-ahead concern resolution
  const order = session.meta.concern_order || [];
  const resolved = session.meta.resolved_concerns || {};
  for (const futureConcern of order) {
    if (!resolved[futureConcern] && futureConcern !== getActiveConcern(session) && sellerAdvancesConcernEN(futureConcern, lower)) {
      session.meta.resolved_concerns = { ...resolved, [futureConcern]: 'partial' };
    }
  }

  const concern = getActiveConcern(session);
  return respondFinanceByConcernEN(concern, session, persona, lower, claims, trust, irritation);
}

function respondFinanceByConcernEN(concern, session, persona, lower, claims, trust, irritation) {
  if (concern === 'scope') {
    if (irritation >= 2) {
      return pick([
        "Still not hearing where your scope ends.",
        "Again: what exactly does Mellow control? No declarations.",
        "Stop. What are you responsible for, and what are you not?",
        "Scope boundary. Asked three times now. Where is it?",
      ]);
    }
    if (trust >= 2) {
      return pick([
        "Ok, that's closer. What exactly does Mellow take on — documents, payment chain, anything else?",
        "Good, I'm starting to understand your scope. What exactly don't you take on — what stays with me?",
        "That's more precise. So documents and KYC are yours. What else? And what specifically remains on our side?",
      ]);
    }
    if (persona.id === 'cfo_round') {
      return pick([
        "Still not hearing a clear scope. What exactly is in Mellow's zone before diligence — docs, payment chain, what else?",
        "For diligence I need to know exactly: what's under your control, what's mine. No vague formulations.",
        "The investor will ask. What exactly can you show as structured — docs, KYC, payout trail?",
      ]);
    }
    return pick([
      "I already asked. What exactly does Mellow control, and where does your responsibility end?",
      "Didn't hear an answer. Payment chain, documents, KYC — what's in your scope, what's not?",
      "Again: Mellow's control zone — what specifically, without declarations?",
      "Half an answer. The other half: what exactly don't you take — where does my side begin?",
    ]);
  }

  if (concern === 'why_change') {
    if (persona.id === 'cfo_round') {
      return pick([
        "The next round isn't tomorrow. Why should I change the scheme now if the current one hasn't blown up?",
        "The current setup holds somehow. What exactly breaks without Mellow — and when?",
        "What specifically won't survive the next diligence without changes?",
      ]);
    }
    if (claims.days) {
      return pick([
        `You mentioned a ${claims.days} delay — that's concrete. But why change the whole setup if that happened once?`,
        `${claims.days} delay — I heard. Is that a systemic problem or a one-off? Why would Mellow fix it?`,
      ]);
    }
    if (irritation >= 2) {
      return pick([
        "Again: current setup somehow works. What specifically breaks without Mellow?",
        "Asked twice already. Why now? What's not working?",
      ]);
    }
    return pick([
      "That's closer. But why should I replace my current setup if it's worked for years, even if imperfectly?",
      "What specifically breaks without Mellow?",
      "I don't see why this is critical right now versus in six months.",
      "Ok but we have a setup that works — not perfectly, but predictably. Why switch?",
    ]);
  }

  if (concern === 'sla') {
    if (irritation >= 2) {
      return pick([
        "Payment stuck. What happens next? Who, in what timeframe?",
        "Operationally — what's the incident process? Specifics.",
        "Scenario: payment stuck for three days. My actions? Your actions?",
      ]);
    }
    return pick([
      "Ok. But if a payment gets stuck again, what's the operational process? Is there an SLA or just more promises?",
      "Concretely: if a payment hangs for a week, what happens? Who escalates, in what timeframe?",
      "Good setups work in ideal conditions. What happens when it doesn't? Walk me through the incident path.",
      "SLA isn't just a promise, it's a process. Is there a concrete escalation path for incidents?",
    ]);
  }

  if (concern === 'geo_tax') {
    if (persona.id === 'cfo_round') {
      return pick([
        "Separately: contractor docs, tax handling and how that's explained to the next investor on diligence?",
        "How does the audit story look on contractor docs and tax for the future investor?",
      ]);
    }
    return pick([
      "And separately — how do you handle tax and payments for contractors with Russian passports? I need the boundary, not the brochure.",
      "Another question: how does your setup work for contractors in sanctioned or grey jurisdictions? What's in your scope on tax?",
      "Half the team has Russian passports. That's not abstract. What exactly does Mellow do with tax handling in that configuration?",
    ]);
  }

  if (irritation >= 2) {
    return pick([
      "Not convincing. Where's the specifics on documents, scope boundary, and next step?",
      "Again without specifics. What exactly changes in my process?",
      "I hear declarations. I don't hear mechanisms. What actually changes?",
    ]);
  }
  return pick([
    "I haven't heard enough specifics. What exactly changes in the process, besides the nice words about compliance?",
    "Too many declarations. What specifically changes in my process, and in what timeframe?",
    "Sounds right. But the right words aren't an argument. What specifically will be different?",
  ]);
}

function respondLegalEN(session, sellerText) {
  const lower = sellerText.toLowerCase();
  const turn = session.meta.bot_turns || 0;
  const persona = personaMeta(session);
  const trust = session.meta.trust || 1;
  const irritation = session.meta.irritation || 0;
  const flags = session.meta.flags || {};

  if (isMisclassificationBlocker(sellerText)) {
    session.meta.flags = { ...flags, blocker: true };
    return pick([
      "If you're promising to remove misclassification risk — this conversation is over. State your actual scope boundary correctly.",
      "That's exactly the overclaim that destroys trust. Where exactly does Mellow's zone end?",
    ]);
  }

  if (turn === 0) {
    if (!hasAny(lower, ['audit', 'trail', 'document', 'boundary', 'responsible', 'review', 'legal', 'traceability', 'scope'])) {
      return pick([
        "Sounds like a vendor pitch. What exactly did you see in our legal context, and how do you define your scope boundary?",
        "Too generic. How exactly do you formulate your zone of responsibility — what do you take on, what not?",
        "Standard vendor approach. What exactly in our contractor/document context caught your attention?",
        "Lots of words, little specificity. How do you define the boundary of your responsibility?",
      ]);
    }
    if (persona.id === 'external_legal') {
      return pick([
        "Ok. Three things right away: what's in Mellow's scope, what's not, and where is that evidenced in process?",
        "Context noted. Straight to it: what's in Mellow's zone, what's not, and how is that proven in documentation?",
        "That's careful. But I need three things: what you take on, what you don't, how it's substantiated. Not declarations.",
      ]);
    }
    return pick([
      "Ok. What exactly does Mellow provide on documents, audit trail and process discipline, and where do you avoid overclaiming?",
      "Good. Concretely on documents and audit trail: what's in Mellow's zone, and where does your responsibility end?",
      "Context is visible. Then directly: documents, audit trail, responsibility boundaries — what's exactly in your scope?",
    ]);
  }

  if (hasAny(lower, ['call', 'review', 'walkthrough', '15 minute', '20 minute', 'follow-up', 'memo', 'material'])) {
    if (session.meta._memo_requested) {
      return pick([
        "Waiting for the materials. When will you send them?",
        "Agreed. Waiting for your email.",
        "Send it. If it's clean, we'll find time.",
      ]);
    }
    if (trust < 1.5 && (session.meta.bot_turns || 0) < 2) {
      return pick([
        "Wait. You haven't answered my question about responsibility boundaries. That first — then next steps.",
        "Too early. I'm not done with questions about your scope. What exactly does Mellow take on, what not?",
      ]);
    }
    session.meta._memo_requested = true;
    if (persona.id === 'external_legal') {
      return pick([
        "Ok. Send a short written follow-up with your scope boundary, process safeguards, and a sample flow. If the formulations are clean, I'll join a short review call.",
        "Send a memo: scope boundary, documents, safeguards, incident example. If the formulations are precise — we'll find 20 minutes.",
      ]);
    }
    return pick([
      "Ok. Send a short memo: documents, audit trail, limitations, incident process. If it's clean, we can do a short walkthrough.",
      "Fine. Send a summary: documents, audit trail, boundaries. If there's no overclaiming, we'll discuss details.",
      "Send a one-page summary: scope boundary, documents, incident SLA. If it's without fluff — we'll find time.",
    ]);
  }

  const order = session.meta.concern_order || [];
  const resolved = session.meta.resolved_concerns || {};
  for (const futureConcern of order) {
    if (!resolved[futureConcern] && futureConcern !== getActiveConcern(session) && sellerAdvancesConcernEN(futureConcern, lower)) {
      if (persona.id === 'external_legal' && futureConcern === 'grey_zones') continue;
      session.meta.resolved_concerns = { ...resolved, [futureConcern]: 'partial' };
    }
  }

  const concern = getActiveConcern(session);
  return respondLegalByConcernEN(concern, session, persona, lower, trust, irritation);
}

function respondLegalByConcernEN(concern, session, persona, lower, trust, irritation) {
  if (concern === 'scope') {
    if (irritation >= 2) {
      return pick([
        "Responsibility boundary — again. What do you take on, what not?",
        "Asked three times. Mellow's control zone — specifically.",
        "Stop. What's in Mellow's scope, what's not?",
        "Without decoration: what you take, what you don't. One sentence.",
      ]);
    }
    if (persona.id === 'external_legal') {
      return pick([
        "Still not hearing a clean boundary. Where exactly does Mellow's scope end — documents, KYC, payment chain?",
        "For us, a clear scope boundary is non-negotiable. What exactly do you control, and what stays with us?",
        "I need something I can put next to our contractor template and see where they align. What exactly is Mellow's scope?",
      ]);
    }
    return pick([
      "Responsibility boundary — again. What exactly do you take on, and what stays with the client?",
      "I need to explain this upward. What's exactly your zone — documents, reconciliation, audit trail?",
      "An unclear boundary is a problem in any audit. What's specifically in Mellow's scope, what's mine?",
      "Still no clear answer. Payment chain — yours or mine?",
    ]);
  }

  if (concern === 'grey_zones') {
    if (persona.id === 'external_legal') {
      return pick([
        "Where exactly does your zone end and ours begin? Who owns the gap between Mellow, our legal, and client?",
        "The grey zone question: when there's an overlap between your scope and ours — who owns that? What's the documented answer?",
        "Defensibility requires no grey zones. Show me exactly where your responsibility ends and ours begins.",
      ]);
    }
    return pick([
      "Let's be specific: where's the overlap between your zones and our legal side? Who owns the gap?",
      "I need to understand the grey zones — where your scope ends and ours begins. Is that documented anywhere?",
      "Three layers: Mellow, our legal, our finance — where do the lines run? Who owns the overlap?",
    ]);
  }

  if (concern === 'incident') {
    if (irritation >= 2) {
      return pick([
        "Incident scenario: payment stuck, documentation gap. What's the process — who, what, in what timeframe?",
        "Stop. Concrete incident process: who acts, in what timeframe, what's documented?",
      ]);
    }
    return pick([
      "Ok. If a contractor payment gets stuck or there's a documentation gap — what's the operational process step by step?",
      "What's the incident playbook? I need to know: who acts, in what timeframe, what gets documented.",
      "Before we go further: show me a real incident example — what happened, how Mellow responded, what was documented.",
    ]);
  }

  if (concern === 'proof') {
    return pick([
      "Can you show me a real example — an actual audit trail, an incident handled? Not a description, something concrete.",
      "I need to see it in practice, not hear about it. Do you have a documented process example I can review?",
    ]);
  }

  if (irritation >= 2) {
    return pick([
      "Still not hearing specifics. Documents, scope, incident process?",
      "Declarations. Where are the mechanisms?",
    ]);
  }
  return pick([
    "The words sound right. But I need to see the process, not just hear the formulations.",
    "That's the right framing. But I need to understand how it works in practice — documents, trail, incident path.",
    "Good. But 'clean scope' and 'audit trail' need to be demonstrated, not described.",
  ]);
}

function respondOpsEN(session, sellerText) {
  const lower = sellerText.toLowerCase();
  const turn = session.meta.bot_turns || 0;
  const claims = session.meta.claims || {};
  const persona = personaMeta(session);
  const trust = session.meta.trust || 1;
  const irritation = session.meta.irritation || 0;
  const flags = session.meta.flags || {};

  if (isMisclassificationBlocker(sellerText)) {
    session.meta.flags = { ...flags, blocker: true };
    return pick([
      "Promising to eliminate misclassification risk? That's an overclaim. What's actually in your zone?",
      "Stop. If you're guaranteeing misclassification protection — that's the end of this conversation. What do you actually control?",
    ]);
  }

  if (turn === 0) {
    const hasOpsContext = hasAny(lower, ['wise', 'crypto', 'delay', 'manual', 'ops', 'payment', 'escalat', 'team', 'coordinat', 'contractor']);
    if (!hasOpsContext) {
      if (persona.id === 'ops_manager') {
        return pick([
          "Still sounds like a template. What specifically did you see in our situation?",
          "This is a standard approach. What exactly do you know about our operational situation?",
          "I get messages like this every week. What specifically did you see before writing?",
        ]);
      }
      if (persona.id === 'eng_manager') {
        return pick([
          "Looks like a standard pitch. What specifically did you see in our situation?",
          "Without specifics you're just another vendor. What exactly do you know about us?",
        ]);
      }
      return pick([
        "Too generic. What specifically in our situation made you reach out?",
        "Sounds like a template. What exactly caught your attention about us?",
        "Another vendor pitch. What do you know about our specific situation — what did you see before writing?",
      ]);
    }

    if (persona.id === 'eng_manager') {
      return pick([
        "Ok, you spotted the pain. But I already had one vendor who promised the same. Why is this a different conversation?",
        "You got the problem right. But I need to bring this to finance — how do you help me make that case?",
        "Tired of being the middleman between finance and contractors. If this really removes manual escalations — what specifically gets removed and how much?",
      ]);
    }
    if (persona.id === 'ops_manager') {
      return pick([
        "Ok. But I hear this every time. What specifically stops being manual? Give me hours and steps, not words.",
        "I've built processes around multiple vendors. Each time it costs more than promised. What makes this one different in cost for ops?",
        "The current setup is slow but I own it. Switching has a cost too. What justifies it right now?",
        "You spotted the pain. But concretely: what stops happening manually, and how much time does that recover?",
      ]);
    }
    // alexey
    return pick([
      "Ok but crypto + Wise has worked for two years. Why do I need this specifically now?",
      "What exactly breaks if I don't change anything?",
      "Context noted. But while it works — why switch? What specifically does this unblock?",
    ]);
  }

  if (hasAny(lower, ['call', 'meeting', '15 minute', '20 minute', 'follow', 'material', 'case', 'calculation', 'pilot'])) {
    if (session.meta._memo_requested) {
      session.meta._memo_follow_up_count = (session.meta._memo_follow_up_count || 0) + 1;
      if (session.meta._memo_follow_up_count >= 1) {
        return pick([
          "Ok. Send it and let's do a short call — 20 minutes.",
          "Fine. If the flow is real, I'll do a 20-minute call.",
          "Sure, send it. If it's concrete, let's find 15 minutes.",
        ]);
      }
      return pick([
        "Waiting for the materials. When will you send them?",
        "Agreed. Waiting for your email.",
        "Send it. If it's concrete — I'll respond.",
      ]);
    }
    if (trust < 1.5 && (session.meta.bot_turns || 0) < 2) {
      return pick([
        "Too early. You haven't convinced me yet this isn't just another vendor. That question first.",
        "Wait. I still don't understand how to bring this to finance. That constraint first.",
      ]);
    }
    session.meta._memo_requested = true;
    if (persona.id === 'ops_manager') {
      return pick([
        "Send me one screen with the flow and what specifically stops being manual. If it's real, we can talk.",
        "Ok. Show me concretely: what step disappears from my day, how many hours, who handles it. If the numbers are real — let's talk.",
      ]);
    }
    if (persona.id === 'eng_manager') {
      return pick([
        "Ok. Send me something I can bring to finance without a long internal pitch. Flow, SLA, what manual escalations disappear. If it's clean — we'll move.",
        "Fine. Send flow and specifically what escalations get handled automatically. If it's real, I'll bring it to finance.",
      ]);
    }
    return pick([
      "Send me the flow on one screen. What specifically stops being manual, how much time that saves. If it's real — we can talk.",
      "Fine. Send a brief: what disappears from manual, case study, rough numbers. If it's concrete — we'll schedule 20 minutes.",
    ]);
  }

  const order = session.meta.concern_order || [];
  const resolved = session.meta.resolved_concerns || {};
  for (const futureConcern of order) {
    if (!resolved[futureConcern] && futureConcern !== getActiveConcern(session) && sellerAdvancesConcernEN(futureConcern, lower)) {
      session.meta.resolved_concerns = { ...resolved, [futureConcern]: 'partial' };
    }
  }

  const concern = getActiveConcern(session);
  return respondOpsByConcernEN(concern, session, persona, lower, claims, trust, irritation);
}

function respondOpsByConcernEN(concern, session, persona, lower, claims, trust, irritation) {
  if (concern === 'op_value') {
    if (irritation >= 2) {
      return pick([
        "Specifically: what stops happening manually? Hours, steps — not words.",
        "Third time: what exactly gets removed from my day?",
      ]);
    }
    if (trust >= 2) {
      return pick([
        "Ok, that's closer. What specifically comes off my plate — and how fast?",
        "Good, getting more concrete. What else changes in the daily process?",
      ]);
    }
    return pick([
      "Specifically: what stops being manual? Give me hours and steps, not marketing language.",
      "What exactly disappears from the daily process — payment statuses, manual coordination, what?",
      "I've heard 'upgrade your ops' before. What concretely stops happening manually?",
      "The current setup is slow but I understand it. What specifically becomes more predictable?",
    ]);
  }

  if (concern === 'cost') {
    if (irritation >= 2) {
      return pick([
        "What's the cost? Is there a trial?",
        "Price and trial option — concretely.",
      ]);
    }
    return pick([
      "And on cost: what does this actually run, and is there a trial or pilot option?",
      "The budget side: what's the pricing model and is there a way to test before committing?",
      "What does switching actually cost — in money and in team time during setup?",
    ]);
  }

  if (concern === 'internal_sell') {
    if (persona.id === 'eng_manager') {
      return pick([
        "Finance remembers the last vendor that didn't deliver. How do I explain to them this is a different conversation?",
        "I need to bring this to finance — how do you help me build the case without enterprise theatre?",
        "Give me the two-sentence version I can use with finance. Why Mellow, why now, what's the scope.",
      ]);
    }
    return pick([
      "I get the logic. But I need to justify this internally. What's the two-line pitch for my finance team?",
      "The team needs to buy in too. What's the argument for switching — in terms they'll care about?",
    ]);
  }

  if (concern === 'vendor_fatigue') {
    return pick([
      "I've tried similar vendors before. One promised the same and delivered nothing. What's mechanically different here?",
      "This sounds like every other vendor pitch. What's concretely different — not in words, but in the mechanism?",
    ]);
  }

  if (concern === 'proof') {
    return pick([
      "Can you show me an example — a real client, actual numbers, what changed in their ops? Not a description.",
      "Give me a case study. Not a vendor story — actual numbers, actual process change.",
    ]);
  }

  if (irritation >= 2) {
    return pick([
      "Not convincing. Where's the specifics on what changes manually?",
      "Again without specifics. What exactly changes in my day?",
    ]);
  }
  return pick([
    "Still not specific enough. What exactly stops being manual, how much time does that free up?",
    "The current setup — slow, but mine. Why is this worth the switching cost right now?",
    "I hear you. But 'upgrade ops' isn't a mechanism. What specifically is different tomorrow if we use Mellow?",
  ]);
}

// ==================== ASSESSMENT ====================

function firstContactMatchers(personaId, lang) {
  if (lang === 'en') {
    return {
      andrey: ['23', 'legal', 'review', 'wise', 'payoneer', 'contractor', 'reconcil', 'payment'],
      alexey: ['wise', 'crypto', 'delay', 'manual', 'ops', 'payment', 'team'],
      cfo_round: ['round', 'series', 'invest', 'diligence', 'due', 'audit', 'contractor'],
      eng_manager: ['escalat', 'team', 'engineer', 'engineering', 'contractor', 'payment'],
      ops_manager: ['ops', 'status', 'manual', 'follow', 'payment', 'chaos', 'coordinat'],
      head_finance: ['audit', 'reconcil', 'control', 'finance', 'document', 'report'],
      internal_legal: ['legal', 'document', 'audit', 'trail', 'boundary', 'traceability', 'scope'],
      external_legal: ['counsel', 'review', 'defensible', 'audit', 'trail', 'boundary', 'scope'],
      olga: ['counsel', 'review', 'traceability', 'defensible', 'audit', 'trail', 'boundary'],
      rate_floor_cfo: ['market', 'premium', 'benchmark', 'justified', 'rate', 'floor'],
      panic_churn_ops: ['panic', 'predictability', 'incidents', 'control', 'bank', 'compliance'],
      fx_trust_shock_finance: ['fx', 'total-cost', 'surprise', 'economics', 'invoice', 'trust'],
      cm_winback: ['trust', 'use case', 'fit', 'cm', 'cor', 'winback']
    }[personaId] || ['context'];
  }
  return {
    andrey: ['23', 'legal', 'review', 'wise', 'payoneer', 'подряд', 'сверк'],
    alexey: ['wise', 'crypto', 'задерж', 'ручн', 'ops', 'выплат'],
    cfo_round: ['раунд', 'series', 'invest', 'diligence', 'due', 'audit', 'contractor'],
    eng_manager: ['эскалац', 'команд', 'engineer', 'engineering', 'подряд', 'выплат'],
    ops_manager: ['ops', 'статус', 'ручн', 'follow', 'выплат', 'хаос'],
    head_finance: ['audit', 'сверк', 'control', 'контрол', 'finance', 'документ'],
    internal_legal: ['legal', 'документ', 'audit', 'trail', 'границ', 'traceability'],
    external_legal: ['counsel', 'review', 'defensible', 'audit', 'trail', 'границ'],
    olga: ['counsel', 'review', 'traceability', 'defensible', 'audit', 'trail'],
    rate_floor_cfo: ['рын', 'premium', 'бенчмарк', 'оправд', 'ставк', 'марж'],
    panic_churn_ops: ['паник', 'предсказуем', 'инцидент', 'контрол', 'bank', 'compliance'],
    fx_trust_shock_finance: ['fx', 'total-cost', 'surprise', 'invoice', 'довер', 'математ'],
    cm_winback: ['довер', 'use case', 'fit', 'cm', 'cor', 'возврат']
  }[personaId] || ['контекст'];
}

function assess(session) {
  ensureBuyerStateSessionFields(session);
  const seller = sellerMessages(session);
  const sellerText = seller.join('\n').toLowerCase();
  const firstMessage = (seller[0] || '').toLowerCase();
  const persona = personaMeta(session);
  const personaId = session.bot_id;
  const lang = session.language || 'ru';
  const isEN = lang === 'en';

  const k1Pass = hasAny(firstMessage, firstContactMatchers(personaId, lang));

  const blocker = seller.some((message) => isMisclassificationBlocker(message));
  const k2Pass = !blocker && (isEN
    ? hasAny(sellerText, ['document', 'kyc', 'audit', 'trail', 'payment chain', 'sla', 'tax', 'limit', 'warning', 'boundary', 'responsible', 'responsibility', 'scope'])
    : hasAny(sellerText, ['документ', 'kyc', 'audit', 'trail', 'платеж', 'цепоч', 'sla', 'налог', 'огранич', 'warning', 'предупреж', 'ответствен']));

  const marketingSlang = isEN
    ? hasAny(sellerText, ['market leader', 'best-in-class', 'reliable solution', 'scale without', 'innovative'])
    : hasAny(sellerText, ['лидер рынка', 'best-in-class', 'надежное решение', 'надёжное решение', 'масштабируйтесь без проблем']);
  const avgWords = seller.length ? seller.reduce((sum, m) => sum + countWords(m), 0) / seller.length : 0;

  const k3Pass = isEN
    ? persona.archetype === 'finance'
      ? hasAny(sellerText, ['risk', 'responsible', 'document', 'sla', 'tax', 'tco', 'process', 'audit', 'control', 'boundary'])
      : persona.archetype === 'legal'
      ? hasAny(sellerText, ['boundary', 'responsible', 'audit', 'trail', 'document', 'limit', 'warning', 'scope']) && !marketingSlang
      : avgWords <= 40 && !marketingSlang && hasAny(sellerText, ['fast', 'manual', 'chaos', 'ops', 'time', 'conven', 'escalat', 'process', 'quicker', 'saves'])
    : persona.archetype === 'finance'
    ? hasAny(sellerText, ['риск', 'ответствен', 'документ', 'sla', 'налог', 'tco', 'процесс', 'audit', 'control'])
    : persona.archetype === 'legal'
    ? hasAny(sellerText, ['границ', 'ответствен', 'audit', 'trail', 'документ', 'огранич', 'warning']) && !marketingSlang
    : avgWords <= 40 && !marketingSlang && hasAny(sellerText, ['быстр', 'ручн', 'бардак', 'ops', 'время', 'удоб', 'эскалац', 'процесс']);

  let objectionHits = 0;
  if (isEN) {
    if (persona.archetype === 'finance') {
      if (hasAny(sellerText, ['document', 'kyc', 'audit', 'chain', 'responsible', 'control', 'boundary'])) objectionHits++;
      if (hasAny(sellerText, ['sla', 'escalat', 'status', 'stuck', 'support', 'incident'])) objectionHits++;
      if (hasAny(sellerText, ['risk', 'manual', 'reconcil', 'tco', 'expensive', 'cost'])) objectionHits++;
      if (hasAny(sellerText, ['tax', 'russia', 'passport', 'diligence', 'invest', 'sanction'])) objectionHits++;
    } else if (persona.archetype === 'legal') {
      if (hasAny(sellerText, ['boundary', 'responsible', 'misclassification', 'overclaim', 'scope'])) objectionHits++;
      if (hasAny(sellerText, ['audit', 'trail', 'trace', 'document', 'warning', 'limit'])) objectionHits++;
      if (hasAny(sellerText, ['process', 'flow', 'chain', 'incident', 'escalat'])) objectionHits++;
      if (hasAny(sellerText, ['review', 'memo', 'walkthrough', 'follow-up', '15 minute', '20 minute'])) objectionHits++;
    } else {
      if (hasAny(sellerText, ['fast', 'manual', 'chaos', 'ops', 'payment', 'escalat', 'saves'])) objectionHits++;
      if (hasAny(sellerText, ['15 minute', '20 minute', 'short', 'quick', 'follow-up', 'call'])) objectionHits++;
      if (hasAny(sellerText, ['cost', 'econom', 'time', 'team', 'day', 'hour'])) objectionHits++;
      if (hasAny(sellerText, ['wise', 'crypto', 'upgrade', 'process', 'status', 'predictable'])) objectionHits++;
    }
  } else {
    if (persona.archetype === 'finance') {
      if (hasAny(sellerText, ['документ', 'kyc', 'audit', 'цепоч', 'ответствен', 'control'])) objectionHits++;
      if (hasAny(sellerText, ['sla', 'эскалац', 'статус', 'застр', 'поддерж', 'инцидент'])) objectionHits++;
      if (hasAny(sellerText, ['риск', 'ручн', 'сверк', 'tco', 'дорог', 'стоим'])) objectionHits++;
      if (hasAny(sellerText, ['ндфл', 'налог', 'россий', 'diligence', 'инвест'])) objectionHits++;
    } else if (persona.archetype === 'legal') {
      if (hasAny(sellerText, ['границ', 'ответствен', 'misclassification', 'overclaim'])) objectionHits++;
      if (hasAny(sellerText, ['audit', 'trail', 'trace', 'документ', 'warning', 'огранич'])) objectionHits++;
      if (hasAny(sellerText, ['процесс', 'flow', 'цепоч', 'инцидент', 'эскалац'])) objectionHits++;
      if (hasAny(sellerText, ['review', 'memo', 'walkthrough', 'follow-up', '15 минут', '20 минут'])) objectionHits++;
    } else {
      if (hasAny(sellerText, ['быстр', 'ручн', 'бардак', 'ops', 'выплат', 'эскалац'])) objectionHits++;
      if (hasAny(sellerText, ['15 минут', '20 минут', 'коротк', 'без долг', 'быстрый', 'follow-up'])) objectionHits++;
      if (hasAny(sellerText, ['стоим', 'эконом', 'время', 'команд', 'день', 'час'])) objectionHits++;
      if (hasAny(sellerText, ['wise', 'crypto', 'апгрейд', 'процесс', 'статус'])) objectionHits++;
    }
  }
  const k4Pass = objectionHits >= 2;

  const k5Pass = isEN
    ? hasAny(sellerText, ['call', 'meeting', '15 minute', '20 minute', 'follow-up', 'follow up', 'this week', 'tomorrow', 'material', 'calculation', 'memo', 'walkthrough', 'review', 'next step'])
    : hasAny(sellerText, ['созвон', 'звон', '15 минут', '20 минут', 'follow-up', 'follow up', 'на неделе', 'завтра', 'материал', 'расч', 'memo', 'walkthrough', 'review']);

  const isEmail = session.dialogue_type === 'email';
  const hasEmailGreeting = isEN
    ? seller.some((m) => /^(hi|hello|dear|good\s)/i.test(m.trim()))
    : seller.some((m) => /^(привет|добр|здравств|уважаем)/i.test(m.trim()));
  const hasEmailSignoff = isEN
    ? seller.some((m) => /(best|regards|thanks|sincerely|cheers|kind regards)[,\s]/i.test(m))
    : seller.some((m) => /(с уважением|с наилучшими|спасибо|удачи)[,\s]/i.test(m));
  const k6Pass = !isEmail || (hasEmailGreeting && hasEmailSignoff);

  const passCount = [k1Pass, k2Pass, k3Pass, k4Pass, k5Pass, ...(isEmail ? [k6Pass] : [])].filter(Boolean).length;
  const totalCriteria = isEmail ? 6 : 5;
  const verdict = blocker ? 'BLOCKER' : passCount >= totalCriteria - 1 ? 'PASS' : passCount >= totalCriteria - 2 ? 'PASS_WITH_NOTES' : 'FAIL';

  function quote(matchers, fallback) {
    const found = seller.find((m) => hasAny(m.toLowerCase(), matchers));
    return found || fallback;
  }

  const noFirstMsg = isEN ? 'No first message.' : 'Нет первого сообщения.';
  const noData = isEN ? 'No data.' : 'Нет данных.';

  const criteria = [
    {
      id: 'K1',
      name: 'Contextual first contact',
      status: k1Pass ? 'PASS' : 'FAIL',
      short_reason: isEN
        ? (k1Pass ? 'First message anchors to a specific signal from the card.' : 'First message is too generic and misses the signal context.')
        : (k1Pass ? 'Первое касание опирается на конкретный сигнал из карточки.' : 'Первое сообщение слишком общее и теряет контекст сигнала.'),
      evidence_quote: seller[0] || noFirstMsg
    },
    ...(isEmail ? [{
      id: 'K6',
      name: 'Email format',
      status: k6Pass ? 'PASS' : 'FAIL',
      short_reason: isEN
        ? (k6Pass
          ? 'Messages use correct email format: greeting and sign-off present.'
          : !hasEmailGreeting
          ? 'Missing email greeting (Hi / Hello / Dear). Cold email without salutation reads as unprofessional.'
          : 'Missing sign-off (Best / Regards / Thanks). Email without a closing feels abrupt.')
        : (k6Pass
          ? 'Письма оформлены правильно: есть приветствие и подпись.'
          : !hasEmailGreeting
          ? 'Нет приветствия (Здравствуйте / Добрый день). Email без обращения выглядит непрофессионально.'
          : 'Нет подписи (С уважением / Спасибо). Письмо без завершения выглядит обрезанным.'),
      evidence_quote: seller[0] || noFirstMsg
    }] : []),
    {
      id: 'K2',
      name: 'Compliance and boundary of responsibility',
      status: k2Pass ? 'PASS' : 'FAIL',
      short_reason: isEN
        ? (blocker ? 'Seller made a false promise about misclassification.' : k2Pass ? "Seller stated Mellow's control scope without overclaiming." : "No clear boundary of responsibility or specifics on Mellow's scope.")
        : (blocker ? 'Продавец дал ложное обещание про misclassification.' : k2Pass ? 'Продавец обозначил зону контроля Mellow без магических обещаний.' : 'Нет ясной границы ответственности и конкретики по зоне контроля Mellow.'),
      evidence_quote: quote(['misclassification', 'document', 'kyc', 'audit', 'sla', 'tax', 'trail', 'responsible', 'boundary', 'документ', 'налог', 'ответствен'], seller[1] || seller[0] || noData),
      blocking: blocker
    },
    {
      id: 'K3',
      name: 'Language fit',
      status: k3Pass ? 'PASS' : 'FAIL',
      short_reason: isEN
        ? (k3Pass ? 'Language is adapted to the chosen persona.' : 'Tone and delivery are not adapted to the chosen persona.')
        : (k3Pass ? 'Язык адаптирован под выбранную персону.' : 'Тон и подача не адаптированы под выбранную персону.'),
      evidence_quote: quote(['risk', 'responsible', 'chaos', 'fast', 'ops', 'audit', 'trail', 'escalat', 'риск', 'ответствен', 'бардак', 'быстр', 'эскалац'], seller[0] || noData)
    },
    {
      id: 'K4',
      name: 'Handling core objections',
      status: k4Pass ? 'PASS' : 'FAIL',
      short_reason: isEN
        ? (k4Pass ? 'At least two key objections addressed substantively.' : 'Objections addressed weakly or not followed through.')
        : (k4Pass ? 'Минимум два ключевых возражения закрыты содержательно.' : 'Возражения закрыты слабо или не дожаты.'),
      evidence_quote: quote(['sla', 'risk', 'manual', 'cost', 'time', 'upgrade', 'trail', 'process', 'риск', 'ручн', 'стоим', 'время', 'апгрейд', 'процесс'], seller[1] || seller[0] || noData),
      objections: botMessages(session).slice(0, 4).map((text) => ({
        objection: text,
        result: k4Pass ? 'answered' : 'partial'
      }))
    },
    {
      id: 'K5',
      name: 'Next step',
      status: k5Pass ? 'PASS' : 'FAIL',
      short_reason: isEN
        ? (k5Pass ? 'Next step stated concretely.' : 'Conversation ended without a clear next step.')
        : (k5Pass ? 'Следующий шаг зафиксирован конкретно.' : 'Разговор закончился без чёткого next step.'),
      evidence_quote: quote(['call', 'meeting', '15 minute', '20 minute', 'follow', 'material', 'memo', 'review', 'созвон', '15 минут', '20 минут', 'материал', 'расч'], seller[seller.length - 1] || noData)
    }
  ];

  const noTurningPoint = isEN ? 'No turning point.' : 'Переломного момента не было.';
  const turningPointQuote = quote(['sla', 'manual', 'document', 'audit', 'trail', 'process', 'бардак', 'ручн', '20 минут', '15 минут', 'документ'], seller[1] || seller[0] || noTurningPoint);
  const turningPointWhy = turningPointQuote === noTurningPoint
    ? (isEN ? "Seller didn't deliver a line that noticeably built trust." : 'Продавец не дал реплику, которая заметно усилила доверие.')
    : (isEN ? 'Here the seller got specific and started speaking the persona\'s language of pain.' : 'Здесь продавец ушёл в конкретику и начал говорить на языке боли собеседника.');

  const failCriteria = criteria.filter((c) => c.status === 'FAIL');
  const coaching_points = (failCriteria.length ? failCriteria : criteria.slice(0, 2)).slice(0, 2).map((c) => ({
    quote: c.evidence_quote,
    what_is_wrong: c.short_reason,
    better_version: isEN
      ? c.id === 'K2'
        ? "State directly that Mellow controls documents, KYC, payment chain and audit trail, but does NOT take on misclassification risk."
        : c.id === 'K5'
        ? "Lock in the next step explicitly: e.g., a 20-minute call this week, a review memo, or a walkthrough with the right stakeholder."
        : c.id === 'K1'
        ? "Open with a specific detail from the signal card, not a generic pitch."
        : c.id === 'K3'
        ? persona.archetype === 'finance'
          ? "Speak the language of risk, process, responsibility and cost of failure."
          : persona.archetype === 'legal'
          ? "Be precise: boundaries, documents, audit trail and no overclaiming."
          : "Keep messages concise and sell the ops upgrade without marketing slang."
        : c.id === 'K6'
        ? "Structure every message as a proper email: greeting (Hi [Name],), substantive body, and sign-off (Best, [Your name]). Email without structure reads as unprofessional in a formal channel."
        : "Answer the objection with a mechanism, not a repeat of general talking points."
      : c.id === 'K2'
      ? 'Скажи прямо, что Mellow контролирует документы, KYC, платёжную цепь и audit trail, но не берёт на себя misclassification риск.'
      : c.id === 'K5'
      ? 'Зафиксируй next step явно: например, 20-минутный созвон на неделе, review memo или walkthrough с нужной функцией.'
      : c.id === 'K1'
      ? 'Открой диалог конкретной деталью из сигнала, а не общим pitch.'
      : c.id === 'K3'
      ? persona.archetype === 'finance'
        ? 'Говори языком риска, процесса, ответственности и стоимости ошибки.'
        : persona.archetype === 'legal'
        ? 'Говори аккуратно: границы, документы, audit trail и без overclaiming.'
        : 'Укороти сообщение и продавай speed/ops upgrade без marketing slang.'
      : c.id === 'K6'
      ? 'Оформляй каждое письмо правильно: приветствие (Здравствуйте / Добрый день), суть, подпись (С уважением, [имя]). Email без структуры выглядит непрофессионально.'
      : 'Ответь на возражение механизмом, а не повтором общих тезисов.'
  }));

  const recommended_next_drill = blocker || (persona.archetype === 'finance' && !k2Pass)
    ? `repeat_${personaId}_boundary`
    : persona.archetype === 'ops' && !k3Pass
    ? `repeat_${personaId}_conciseness`
    : persona.archetype === 'legal' && !k2Pass
    ? `repeat_${personaId}_legal_scope`
    : 'advance_followup';
  const buyerStateReport = buildBuyerStateReport(session);

  return {
    assessment_id: randomId('assessment'),
    session_id: session.session_id,
    bot_id: personaId,
    language: lang,
    verdict,
    verdict_label: isEN
      ? { PASS: 'Ready for next step', PASS_WITH_NOTES: 'Good, but can be stronger', FAIL: 'Needs work', BLOCKER: 'Critical error' }[verdict] || verdict
      : verdictLabel(verdict),
    criteria: criteria.map((criterion) => ({
      ...criterion,
      label: isEN
        ? { K1: 'Contextual opening', K2: 'Scope & responsibility boundary', K3: 'Persona language fit', K4: 'Core objection handling', K5: 'Clear next step', K6: 'Email format' }[criterion.id] || criterionLabel(criterion.id)
        : criterionLabel(criterion.id)
    })),
    turning_point: { quote: turningPointQuote, why: turningPointWhy },
    coaching_points,
    summary_for_seller: isEN
      ? verdict === 'PASS'
        ? 'Good run: you held context, answered on-point, and brought the conversation to a next step.'
        : verdict === 'BLOCKER'
        ? 'Critical error: you promised something Mellow should not promise.'
        : 'Workable run, but trust and next step are not landing on all key points yet.'
      : verdict === 'PASS'
      ? 'Хороший прогон: ты держал контекст, отвечал по делу и довёл разговор до следующего шага.'
      : verdict === 'BLOCKER'
      ? 'Есть блокирующая ошибка: ты пообещал то, что Mellow не должен обещать.'
      : 'Прогон рабочий, но доверие и next step пока держатся не на всех ключевых местах.',
    buyer_state_report: buyerStateReport,
    recommended_next_drill,
    recommended_next_drill_label: isEN
      ? recommended_next_drill === 'advance_followup'
        ? 'Move to follow-up: briefly recap the flow, next step, and why continuing makes sense.'
        : recommended_next_drill.endsWith('_boundary')
        ? `Repeat the run with ${persona.name}: keep the conversation grounded in scope boundary, documents, payment flow, and no promises on external risk.`
        : recommended_next_drill.endsWith('_conciseness')
        ? `Repeat the run with ${persona.name}: shorten your messages and sell through speed, predictability, and removing manual work.`
        : `Repeat the run with ${persona.name}: be more precise on documents, audit trail, process safeguards, and responsibility boundaries.`
      : recommendationLabel(recommended_next_drill, persona),
    created_at: now()
  };
}

// ==================== API ROUTES ====================

app.get('/api/personas', (_req, res) => {
  res.json(Object.values(personas).filter((persona) => !isDeprecatedPersona(persona)).map((persona) => {
    const enriched = enrichPersonaWithScenario(persona);
    return {
      ...enriched,
      doctrine_family: persona.doctrine_family || getDoctrineFamilyForPersonaId(persona.id, persona.archetype || ''),
      doctrine_family_label: getDoctrineFamilyLabel(persona.doctrine_family || getDoctrineFamilyForPersonaId(persona.id, persona.archetype || '')),
    };
  }));
});

app.get('/api/signals', (_req, res) => {
  res.json(Object.values(doctrineConfig?.signal_types || {}));
});

app.get('/api/doctrine-config', (_req, res) => {
  res.json(doctrineConfig);
});

app.get('/api/playbooks', (req, res) => {
  const filters = normalizeSliceFilters({
    side: req.query.side,
    product: req.query.product,
    salesType: req.query.salesType,
    instrument: req.query.instrument,
    personaMode: req.query.personaMode,
    groupId: req.query.groupId,
    personaId: req.query.personaId,
    signalType: req.query.signalType,
  });
  res.json({
    filters,
    doctrine: resolveDoctrinePlaybook(filters),
    signals: resolveSignalPlaybook(filters),
  });
});

app.patch('/api/playbooks/doctrine', async (req, res) => {
  const filters = normalizeSliceFilters(req.body?.filters || {});
  const stages = Array.isArray(req.body?.stages) ? req.body.stages : [];
  const record = upsertDoctrinePlaybook(filters, stages);
  await saveDoctrineConfig();
  res.json({ ok: true, record, doctrine: resolveDoctrinePlaybook(filters) });
});

app.patch('/api/playbooks/signals', async (req, res) => {
  const filters = normalizeSliceFilters(req.body?.filters || {});
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  const record = upsertSignalPlaybook(filters, entries);
  await saveDoctrineConfig();
  res.json({ ok: true, record, signals: resolveSignalPlaybook(filters) });
});

app.patch('/api/doctrine-config/:layer/:id', async (req, res) => {
  const layer = String(req.params.layer || '').trim();
  const id = String(req.params.id || '').trim();
  if (!['sides', 'products', 'signal_types', 'dialogue_types', 'environments', 'groups', 'profiles'].includes(layer)) {
    return res.status(400).json({ error: 'Unknown doctrine layer' });
  }
  if (!id) return res.status(400).json({ error: 'Doctrine id is required' });
  const current = doctrineConfig?.[layer]?.[id];
  if (!current) return res.status(404).json({ error: 'Doctrine record not found' });
  doctrineConfig[layer][id] = { ...current, ...(req.body || {}), id };
  await saveDoctrineConfig();
  res.json(doctrineConfig[layer][id]);
});

app.post('/api/personas/extract-from-prompt', (req, res) => {
  const systemPrompt = String(req.body?.system_prompt || '').trim();
  if (!systemPrompt) return res.status(400).json({ error: 'system_prompt is required' });

  const draft = extractPromptDraft(systemPrompt);
  const extracted = Boolean(draft.role || draft.name || draft.intro || draft.styleLines?.length || draft.objections?.length);
  res.json({
    extracted,
    draft: {
      name: draft.name || '',
      role: draft.role || '',
      intro: draft.intro || '',
      required_fields: defaultRequiredFieldsTemplate(),
      prompt_style: draft.styleLines || [],
      prompt_objections: draft.objections || []
    }
  });
});

app.post('/api/personas', async (req, res) => {
  const payload = req.body || {};
  const baseId = sanitizePersonaId(payload.id || payload.name);
  let personaId = baseId || `persona_${crypto.randomUUID().slice(0, 8)}`;
  if (personas[personaId]) {
    personaId = `${personaId}_${crypto.randomUUID().slice(0, 4)}`;
  }
  const persona = normalizePersona({
    ...payload,
    id: personaId,
    cards: payload.cards
  }, personaId);
  personas[persona.id] = persona;
  await savePersonaStore();
  doctrineConfig.profiles[persona.id] = {
    ...(doctrineConfig.profiles[persona.id] || {}),
    id: persona.id,
    label: persona.name,
    description: persona.intro || persona.role,
    side: String(payload.market_side || payload.side || doctrineConfig.profiles[persona.id]?.side || 'demand'),
    product: String(payload.product || doctrineConfig.profiles[persona.id]?.product || 'cor'),
    dialogue_types: Array.isArray(payload.dialogue_types) ? payload.dialogue_types : (doctrineConfig.profiles[persona.id]?.dialogue_types || ['outbound']),
    environments: Array.isArray(payload.environments) ? payload.environments : (doctrineConfig.profiles[persona.id]?.environments || ['messenger', 'email']),
    group_id: String(payload.group_id || doctrineConfig.profiles[persona.id]?.group_id || persona.doctrine_family || 'custom'),
    role: persona.role,
    objective: doctrineConfig.profiles[persona.id]?.objective || 'Preserve the individual buyer behavior and objections of this profile.',
    value_frame: doctrineConfig.profiles[persona.id]?.value_frame || (persona.intro || persona.role),
    tone_rules: doctrineConfig.profiles[persona.id]?.tone_rules || (persona.prompt_style || []),
    forbidden_moves: doctrineConfig.profiles[persona.id]?.forbidden_moves || (persona.prompt_objections || []),
  };
  await saveDoctrineConfig();
  res.status(201).json(enrichPersonaWithScenario(persona));
});

app.patch('/api/personas/:id', async (req, res) => {
  const persona = personas[req.params.id];
  if (!persona) return res.status(404).json({ error: 'Persona not found' });

  const payload = req.body || {};
  const nextPersona = normalizePersona({
    ...persona,
    ...payload,
    id: persona.id,
    cards: payload.cards || persona.cards
  }, persona.id);

  personas[persona.id] = nextPersona;
  await savePersonaStore();
  doctrineConfig.profiles[persona.id] = {
    ...(doctrineConfig.profiles[persona.id] || {}),
    id: persona.id,
    label: nextPersona.name,
    description: nextPersona.intro || nextPersona.role,
    side: String(payload.market_side || payload.side || doctrineConfig.profiles[persona.id]?.side || 'demand'),
    product: String(payload.product || doctrineConfig.profiles[persona.id]?.product || 'cor'),
    dialogue_types: Array.isArray(payload.dialogue_types) ? payload.dialogue_types : (doctrineConfig.profiles[persona.id]?.dialogue_types || ['outbound']),
    environments: Array.isArray(payload.environments) ? payload.environments : (doctrineConfig.profiles[persona.id]?.environments || ['messenger', 'email']),
    group_id: String(payload.group_id || doctrineConfig.profiles[persona.id]?.group_id || nextPersona.doctrine_family || 'custom'),
    role: nextPersona.role,
  };
  await saveDoctrineConfig();
  res.json(enrichPersonaWithScenario(nextPersona));
});

app.delete('/api/personas/:id', async (req, res) => {
  const persona = personas[req.params.id];
  if (!persona) return res.status(404).json({ error: 'Persona not found' });
  delete personas[req.params.id];
  await savePersonaStore();
  delete doctrineConfig.profiles[req.params.id];
  await saveDoctrineConfig();
  res.json({ ok: true, id: req.params.id });
});

function normalizeRandomizerConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const config = {};
  config.variability = ['off', 'low', 'medium', 'high'].includes(raw.variability) ? raw.variability : 'medium';
  if (Array.isArray(raw.signal_types) && raw.signal_types.length) {
    config.signal_types = raw.signal_types.map(String).filter(Boolean);
  }
  config.random_factor_enabled = raw.random_factor_enabled === true;
  config.ghost_probability = Math.min(1, Math.max(0, Number(raw.ghost_probability ?? 0)));
  config.busy_probability = Math.min(1, Math.max(0, Number(raw.busy_probability ?? 0)));
  config.defer_probability = Math.min(1, Math.max(0, Number(raw.defer_probability ?? 0)));
  return config;
}

app.post('/api/sessions', async (req, res) => {
  const { personaId, sellerId = 'pavel', dialogueType = 'messenger', randomizerConfig: rawConfig, language, difficultyTier, scenarioSelection = null } = req.body || {};
  if (!personaId || !personas[personaId]) {
    return res.status(400).json({ error: 'Unknown personaId' });
  }
  const session = createSalesSession({
    personaId,
    sellerId,
    dialogueType,
    randomizerConfig: rawConfig,
    language,
    difficultyTier,
    scenarioSelection,
  });
  await saveSession(session);
  res.json(session);
});

app.get('/api/sessions/:id', async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.get('/api/analytics', async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const personaModeFilter = req.query.personaMode ? String(req.query.personaMode) : null;
  const personaFilter = req.query.personaId ? getCanonicalPersonaId(String(req.query.personaId)) : null;
  const outcomeFilter = req.query.outcome ? String(req.query.outcome) : null;
  const verdictFilter = req.query.verdict ? String(req.query.verdict) : null;
  const sideFilter = req.query.side ? String(req.query.side) : null;
  const productFilter = req.query.product ? String(req.query.product) : null;
  const signalTypeFilter = req.query.signalType ? normalizeSignalTypeId(String(req.query.signalType)) : null;
  const salesTypeFilter = req.query.salesType ? String(req.query.salesType) : null;
  const instrumentFilter = req.query.instrument ? String(req.query.instrument) : null;
  const groupFilter = req.query.groupId ? String(req.query.groupId) : null;
  const aggregateBy = req.query.aggregateBy ? String(req.query.aggregateBy) : 'average';
  res.json(await buildAnalyticsSummary({ limit, offset, personaFilter, outcomeFilter, verdictFilter, sideFilter, productFilter, signalTypeFilter, salesTypeFilter, instrumentFilter, groupFilter, personaModeFilter, aggregateBy }));
});

app.get('/api/hint-memory/summary', (req, res) => {
  const personaId = req.query.personaId ? String(req.query.personaId) : null;
  res.json(buildHintMemorySummary(personaId));
});

app.post('/api/sessions/:id/message', async (req, res) => {
  const session = ensureBuyerStateSessionFields(await loadSession(req.params.id));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'in_progress') return res.status(400).json({ error: 'Session already finished' });
  if (dialogueMessageBudgetRemaining(session) < 2) {
    await finalizeSession(session, 'max_dialogue_messages');
    return res.status(400).json({ error: `Dialogue reached ${MAX_DIALOGUE_MESSAGES} visible messages and was auto-finished`, session });
  }

  const { text, hintId = null } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required' });

  const normalizedSellerText = text.trim();
  if (!session.meta?.language_locked) {
    session.language = detectMessageLanguage(normalizedSellerText, session.language);
    session.meta.language_locked = true;
    session.meta.initial_seller_language = session.language;
  }
  const sellerEntry = { role: 'seller', text: normalizedSellerText, ts: now() };
  const matchedHint = findHintMemoryAttempt(session, hintId, normalizedSellerText);
  if (matchedHint) {
    sellerEntry.hint_memory_id = matchedHint.id;
    sellerEntry.hint_memory_context = matchedHint.retrieval_context || null;
  }
  session.transcript.push(sellerEntry);
  trackSellerTurnMetadata(session, sellerEntry, normalizedSellerText);

  const transition = evaluateBuyerStateDelta(session, normalizedSellerText);
  session.buyer_state = normalizeBuyerState({
    ...transition.state_after,
  }, session);
  sellerEntry.buyer_state_transition = transition;

  // Update behavior state before generating reply so tone adjustments apply
  updateBehaviorState(session, normalizedSellerText);
  syncLegacyBehaviorState(session);

  const reply = await generateBotReply(session, normalizedSellerText);
  updateSessionClaims(session, normalizedSellerText);
  session.meta.bot_turns += 1;
  if (reply !== null) {
    session.transcript.push({ role: 'bot', text: reply, ts: now() });
    sellerEntry.buyer_reply_outcome = 'replied';
    applyBuyerAcceptanceOutcome(session, sellerEntry, reply);
  } else {
    // Ghost turn: persona went silent. Mark in transcript so seller knows to follow up.
    session.transcript.push({ role: 'system', text: '[No reply — the prospect went silent. Try a follow-up.]', ts: now() });
    session.meta.ghost_turns = (session.meta.ghost_turns || 0) + 1;
    sellerEntry.buyer_reply_outcome = 'silent';
  }
  if (reply && !session.meta.meeting_booked && (detectBuyerMeetingAcceptance(reply, session.language) || detectConditionalLegalReviewAcceptance(reply, sellerText, personaMeta(session)?.id))) {
    session.meta.meeting_booked = true;
    session.meta.meeting_booked_turn = sellerMessages(session).length;
  }
  updateHintMemoryAttempt(session, sellerEntry, sellerEntry.hint_memory_id || hintId || null);
  if (visibleDialogueMessageCount(session) >= MAX_DIALOGUE_MESSAGES) {
    await finalizeSession(session, 'max_dialogue_messages');
  } else {
    await saveSession(session);
  }
  res.json({ reply, session });
});

app.post('/api/sessions/:id/finish', async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status === 'finished') return res.json(session);
  if (sellerMessages(session).length === 0) {
    return res.status(400).json({ error: 'Send at least one seller message before finishing the run' });
  }
  await finalizeSession(session, 'final_state');
  res.json(session);
});

// GET /api/sessions/:id/seller-suggest — return a contextual seller message suggestion
// without committing it to the transcript. Useful for coaching or auto-play seeding.
app.get('/api/sessions/:id/seller-suggest', async (req, res) => {
  const session = ensureBuyerStateSessionFields(await loadSession(req.params.id));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'in_progress') {
    return res.json({
      suggestion: null,
      auto_finished: true,
      terminal_reason: session.dialogue_summary?.failure_reason || 'session_already_finished',
      error: 'Session already finished',
      session,
    });
  }
  if (dialogueMessageBudgetRemaining(session) < 2) {
    await finalizeSession(session, 'max_dialogue_messages');
    return res.json({
      suggestion: null,
      auto_finished: true,
      terminal_reason: 'max_dialogue_messages',
      error: `Dialogue reached ${MAX_DIALOGUE_MESSAGES} visible messages and was auto-finished`,
      session,
    });
  }

  const lang = req.query.lang === 'en' || req.query.lang === 'ru' ? req.query.lang : null;
  const uiStrategy = normalizeUiStrategy(
    typeof req.query.moveType === 'string' ? req.query.moveType : null,
    typeof req.query.proofLayer === 'string' ? req.query.proofLayer : null,
  );
  const contrastiveSnapshot = buildHintMemorySnapshot(session, lang);
  const explorationStrategy = pickExplorationStrategy();
  const suggestion = await generateSellerSuggestion(session, lang, contrastiveSnapshot, explorationStrategy, uiStrategy);
  const hintAttempt = createHintMemoryAttempt(session, suggestion, lang, 'hint', contrastiveSnapshot, explorationStrategy);
  res.json({
    suggestion,
    hint_id: hintAttempt.record.id,
    memory_context: hintAttempt.retrieval,
    ui_strategy: uiStrategy,
  });
});

// POST /api/sessions/:id/auto-message — generate and commit a seller message automatically,
// then return the full session including the bot reply. Enables programmatic simulation runs.
app.post('/api/sessions/:id/auto-message', async (req, res) => {
  const session = ensureBuyerStateSessionFields(await loadSession(req.params.id));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'in_progress') {
    return res.json({
      seller_text: null,
      reply: null,
      auto_finished: true,
      terminal_reason: session.dialogue_summary?.failure_reason || 'session_already_finished',
      error: 'Session already finished',
      session,
    });
  }
  if (dialogueMessageBudgetRemaining(session) < 2) {
    await finalizeSession(session, 'max_dialogue_messages');
    return res.json({
      seller_text: null,
      reply: null,
      auto_finished: true,
      terminal_reason: 'max_dialogue_messages',
      error: `Dialogue reached ${MAX_DIALOGUE_MESSAGES} visible messages and was auto-finished`,
      session,
    });
  }

  const result = await commitAutoMessageTurn(session);
  res.json(result);
});

app.post('/api/evals/runs', async (req, res) => {
  try {
    const run = createEvaluationRun(req.body || {});
    await saveEvaluationRun(run);
    const processed = await advanceEvaluationRun(run, req.body || {});
    res.status(201).json(processed);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/evals/runs', async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  res.json(await listEvaluationRuns(limit));
});

app.get('/api/evals/runs/:id', async (req, res) => {
  const run = await loadEvaluationRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Evaluation run not found' });
  res.json(run);
});

app.post('/api/evals/runs/:id/advance', async (req, res) => {
  const run = await loadEvaluationRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Evaluation run not found' });
  if (['completed', 'completed_with_errors', 'failed'].includes(run.status)) {
    return res.json(run);
  }
  const processed = await advanceEvaluationRun(run, req.body || {});
  res.json(processed);
});

// POST /api/sessions/:id/send-result — email the finished run result.
// Requires env: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, RESULT_EMAIL
// Returns 503 with a named blocker if SMTP is not configured.
app.post('/api/sessions/:id/send-result', async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'finished') return res.status(400).json({ error: 'Session must be finished before sending results' });

  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || 'simulator@mellow.io';
  const resultEmail = process.env.RESULT_EMAIL || 'onboarding-simulations@mellow.io';

  if (!smtpHost || !smtpUser || !smtpPass) {
    return res.status(503).json({
      error: 'Result delivery not configured',
      blocker: 'SMTP credentials missing. Set SMTP_HOST, SMTP_USER, SMTP_PASS in environment.',
      required_vars: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'RESULT_EMAIL']
    });
  }

  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    return res.status(503).json({
      error: 'nodemailer not installed',
      blocker: 'Run: npm install nodemailer in the simulator directory'
    });
  }

  const { createTransport } = nodemailer;
  const transporter = createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: smtpUser, pass: smtpPass }
  });

  const a = session.assessment || {};
  const criteria = (a.criteria || []).map((c) => `${c.id}. ${c.label || c.id}: ${c.status}`).join('\n');
  const transcript = (session.transcript || [])
    .filter((m) => m.role !== 'system')
    .map((m) => `[${m.role === 'seller' ? 'Seller' : session.bot_name}] ${m.text}`)
    .join('\n');

  const subject = `[Sales Sim v2] ${session.session_id} — ${session.bot_name} — ${(session.finished_at || '').slice(0, 10)}`;
  const body = [
    `Seller: ${session.seller_username}`,
    `Persona: ${session.bot_name} / ${session.bot_id}`,
    `SDE Card: ${session.sde_card_id} — ${session.sde_card?.signal_type} — ${session.sde_card?.heat}`,
    `Started: ${session.started_at}`,
    `Finished: ${session.finished_at}`,
    `Verdict: ${a.verdict || 'N/A'}`,
    '',
    '── Criteria ──',
    criteria,
    '',
    '── Transcript ──',
    transcript
  ].join('\n');

  try {
    await transporter.sendMail({ from: smtpFrom, to: resultEmail, subject, text: body });
    res.json({ ok: true, sent_to: resultEmail, session_id: session.session_id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email', detail: err.message });
  }
});

// GET /api/sessions — compact list of finished sessions for История бесед
app.get('/api/sessions', async (_req, res) => {
  const sessions = (await listStoredSessions())
    .filter((s) => s.status === 'finished')
    .map((s) => ({
      session_id: s.session_id,
      seller_username: s.seller_username || s.seller_id || '',
      bot_name: s.bot_name || '',
      bot_id: s.bot_id || '',
      sde_card_id: s.sde_card_id || '',
      signal_type: s.sde_card?.signal_type || '',
      dialogue_type: s.dialogue_type || 'messenger',
      language: s.language || 'ru',
      started_at: s.started_at || null,
      finished_at: s.finished_at || null,
      verdict: s.assessment?.verdict || null,
      verdict_label: s.assessment?.verdict_label || null,
    }));
  res.json({ sessions, total: sessions.length });
});

// GET /api/sessions/:id/download — download a single finished session as Markdown
app.get('/api/sessions/:id/download', async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'finished') return res.status(400).json({ error: 'Session not finished' });

  const a = session.assessment || {};
  const date = (session.finished_at || session.started_at || '').slice(0, 10);

  const criteriaLines = (a.criteria || []).map((c) =>
    `- **${c.id}. ${c.label || c.name || c.id}**: ${c.status}${c.short_reason ? ` — ${c.short_reason}` : ''}`
  ).join('\n');

  const coachingLines = (a.coaching_points || []).map((p, i) => [
    `### Coaching ${i + 1}`,
    `> "${p.quote}"`,
    '',
    `**Issue:** ${p.what_is_wrong}`,
    '',
    `**Better:** ${p.better_version}`,
  ].join('\n')).join('\n\n');

  const transcriptLines = (session.transcript || [])
    .filter((m) => m.role !== 'system')
    .map((m) => `**${m.role === 'seller' ? 'Seller' : session.bot_name}:** ${m.text}`)
    .join('\n\n');

  const md = [
    `# Sales Simulator — ${session.bot_name}`,
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| Session | ${session.session_id} |`,
    `| Date | ${date} |`,
    `| Seller | ${session.seller_username || session.seller_id || '—'} |`,
    `| Persona | ${session.bot_name} (${session.bot_id}) |`,
    `| Signal card | ${session.sde_card_id} |`,
    `| Dialogue type | ${session.dialogue_type || 'messenger'} |`,
    `| Started | ${session.started_at || '—'} |`,
    `| Finished | ${session.finished_at || '—'} |`,
    '',
    `## Verdict: ${a.verdict || '—'}`,
    a.verdict_label ? `*${a.verdict_label}*` : '',
    '',
    a.summary_for_seller ? `## Summary\n\n${a.summary_for_seller}` : '',
    '',
    criteriaLines ? `## Criteria\n\n${criteriaLines}` : '',
    '',
    a.turning_point?.quote ? `## Turning point\n\n> "${a.turning_point.quote}"\n\n${a.turning_point.why || ''}` : '',
    '',
    coachingLines ? `## Coaching notes\n\n${coachingLines}` : '',
    '',
    '## Transcript',
    '',
    transcriptLines,
  ].filter((line) => line !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();

  const filename = `sim-${session.session_id}-${date}.md`;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(md);
});

// POST /api/sessions/bulk-download — download selected (or recent) finished sessions as JSON bundle.
// Streams output to avoid V8 string-length limits on large datasets.
app.post('/api/sessions/bulk-download', async (req, res) => {
  const { session_ids } = req.body || {};
  const BULK_LIMIT = 500;
  let sessions;

  if (Array.isArray(session_ids) && session_ids.length > 0) {
    sessions = (await Promise.all(session_ids.map((id) => loadSession(id)))).filter(Boolean).filter((s) => s.status === 'finished');
  } else {
    sessions = (await listStoredSessions()).filter((s) => s.status === 'finished').slice(0, BULK_LIMIT);
  }

  if (sessions.length === 0) return res.status(404).json({ error: 'No sessions found' });

  const date = new Date().toISOString().slice(0, 10);
  const filename = `sim-export-${date}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  res.write(`{"exported_at":${JSON.stringify(new Date().toISOString())},"count":${sessions.length},"sessions":[\n`);
  sessions.forEach((session, i) => {
    res.write(JSON.stringify(session) + (i < sessions.length - 1 ? ',\n' : '\n'));
  });
  res.end(']}');
});

// GET /api/artifacts — list all saved artifacts (metadata only, no transcript)
app.get('/api/artifacts', async (_req, res) => {
  try {
    const artifacts = await storage.listArtifacts();
    res.json({ artifacts, total: artifacts.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list artifacts', detail: err.message });
  }
});

// GET /api/artifacts/:id/download — download single artifact as JSON file
app.get('/api/artifacts/:id/download', async (req, res) => {
  const artifact = await storage.loadArtifact(req.params.id);
  if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="mellow-sim-${req.params.id}.json"`);
  res.send(JSON.stringify(artifact, null, 2));
});

// GET /api/artifacts/:id/export — download single artifact as Markdown
app.get('/api/artifacts/:id/export', async (req, res) => {
  const markdown = await storage.loadArtifactMarkdown(req.params.id);
  if (!markdown) return res.status(404).json({ error: 'Artifact not found' });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mellow-sim-${req.params.id}.md"`);
  res.send(markdown);
});

// POST /api/artifacts/bulk-download — bulk download as single JSON file.
// Streams to avoid V8 string-length limits when many artifacts are selected.
app.post('/api/artifacts/bulk-download', async (req, res) => {
  const { ids } = req.body || {};
  const BULK_LIMIT = 500;
  let targetIds;

  try {
    if (Array.isArray(ids) && ids.length > 0) {
      targetIds = ids;
    } else {
      targetIds = await storage.listArtifactIds(BULK_LIMIT);
    }
    if (!Array.isArray(targetIds) || targetIds.length === 0) return res.status(404).json({ error: 'No artifacts found' });

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mellow-sim-conversations-${date}.json"`);

    const hydrated = (await Promise.all(targetIds.map((id) => storage.loadArtifact(id))))
      .filter(Boolean);
    if (hydrated.length === 0) return res.status(404).json({ error: 'No artifacts found' });

    res.write(`{"generated_at":${JSON.stringify(new Date().toISOString())},"count":${hydrated.length},"conversations":[\n`);
    hydrated.forEach((artifact, i) => {
      res.write(JSON.stringify(artifact) + (i < hydrated.length - 1 ? ',\n' : '\n'));
    });
    res.end(']}');
  } catch (err) {
    res.status(500).json({ error: 'Failed to build bulk download', detail: err.message });
  }
});

// GET /download/:sessionId — public stable download link for a single artifact
app.get('/download/:sessionId', async (req, res) => {
  const artifact = await storage.loadArtifact(req.params.sessionId);
  if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="mellow-sim-${req.params.sessionId}.json"`);
  res.send(JSON.stringify(artifact, null, 2));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function backfillHintMemoryScores() {
  try {
    const records = loadHintMemoryStore();
    if (records.some((r) => !Number.isFinite(Number(r.final_normalized_score)) && r.was_used)) {
      saveHintMemoryStore(records);
      console.log(`[hint-memory] backfilled final_normalized_score for ${records.filter((r) => r.was_used).length} records`);
    }
  } catch (err) {
    console.error('[hint-memory] backfill error:', err.message);
  }
}

async function backfillArtifacts() {
  try {
    const sessions = (await listStoredSessions()).filter((s) => s.status === 'finished');
    let count = 0;
    for (const session of sessions) {
      const existing = await storage.loadArtifact(session.session_id);
      if (!existing) {
        saveArtifact(session);
        count++;
      }
    }
    if (count > 0) console.log(`[artifacts] backfilled ${count} artifacts`);
  } catch (err) {
    console.error('[artifacts] backfill error:', err.message);
  }
}

export default app;

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(PORT, () => {
    console.log(`Mellow Sales Sim listening on http://localhost:${PORT}`);
    backfillHintMemoryScores();
    backfillArtifacts();
  });
}
