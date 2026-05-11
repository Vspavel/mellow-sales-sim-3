const state = {
  personas: [],
  doctrineConfig: null,
  selectedPersonaId: '',
  selectedSide: 'demand',
  selectedProduct: 'cor',
  selectedSignalType: 'general',
  selectedScenarioDialogueType: 'outbound',
  selectedGroupId: '',
  workspaceFilters: {
    side: 'demand',
    product: 'cor',
    salesType: 'outbound',
    instrument: 'messenger',
    personaMode: 'general',
    groupId: '',
    personaId: '',
    signalType: 'general',
  },
  settingsMode: 'doctrine',
  settingsLayer: 'sides',
  settingsRecordId: '',
  session: null,
  lastHint: null,
  appliedHintId: null,
  editorMode: 'create',
  dialogueType: 'messenger',
  moveType: 'clarify',
  proofLayer: 'one_screen',
  // Randomizer & random-factor settings (persisted to localStorage)
  phase: 'setup',
  replayMode: false,
  fromHistory: false,
  randomizerConfig: {
    variability: 'medium',       // 'off' | 'low' | 'medium' | 'high'
    signal_types: [],            // [] = all types allowed
    random_factor_enabled: false,
    ghost_probability: 0.15,
    busy_probability: 0.10,
    defer_probability: 0.10,
  }
};

const personaSelect = document.getElementById('personaSelect');
const sideSelect = document.getElementById('sideSelect');
const productSelect = document.getElementById('productSelect');
const signalTypeSelect = document.getElementById('signalTypeSelect');
const scenarioDialogueTypeSelect = document.getElementById('scenarioDialogueTypeSelect');
const groupSelect = document.getElementById('groupSelect');
const navRunBtn = document.getElementById('navRunBtn');
const openDoctrineSettingsBtn = document.getElementById('openDoctrineSettingsBtn');
const openSignalSettingsBtn = document.getElementById('openSignalSettingsBtn');
const openPersonaSettingsBtn = document.getElementById('openPersonaSettingsBtn');
const createPersonaBtn = document.getElementById('createPersonaBtn');
const personaEditor = document.getElementById('personaEditor');
const personaEditorTitle = document.getElementById('personaEditorTitle');
const personaForm = document.getElementById('personaForm');
const promptExtractBtn = document.getElementById('promptExtractBtn');
const promptExtractStatus = document.getElementById('promptExtractStatus');
const cancelPersonaBtn = document.getElementById('cancelPersonaBtn');
const savePersonaBtn = document.getElementById('savePersonaBtn');
const setupPanel = document.getElementById('setupPanel');
const selectedPersonaMeta = document.getElementById('selectedPersonaMeta');
const selectedPersonaPrompt = document.getElementById('selectedPersonaPrompt');
const requiredFieldsList = document.getElementById('requiredFieldsList');
const signalBrief = document.getElementById('signalBrief');
const signalCard = document.getElementById('signalCard');
const setupCta = document.getElementById('setupCta');
const startConvBtn = document.getElementById('startConversationBtn');
const runPanel = document.getElementById('runPanel');
const transcript = document.getElementById('transcript');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const reviewPanel = document.getElementById('reviewPanel');
const assessment = document.getElementById('assessment');
const finishBtn = document.getElementById('finishBtn');
const backToSetupBtn = document.getElementById('backToSetupBtn');
const resetBtn = document.getElementById('resetBtn');
const openAnalyticsBtn = document.getElementById('openAnalyticsBtn');
const analyticsPanel = document.getElementById('analyticsPanel');
const settingsPanel = document.getElementById('settingsPanel');
const analyticsGeneratedAt = document.getElementById('analyticsGeneratedAt');
const analyticsSuccessRate = document.getElementById('analyticsSuccessRate');
const analyticsFinishedRuns = document.getElementById('analyticsFinishedRuns');
const analyticsSuccessfulDialogs = document.getElementById('analyticsSuccessfulDialogs');
const analyticsPersonaTable = document.getElementById('analyticsPersonaTable');
const analyticsSignalTable = document.getElementById('analyticsSignalTable');
const analyticsRecentRuns = document.getElementById('analyticsRecentRuns');
const analyticsDialogueCount = document.getElementById('analyticsDialogueCount');
const analyticsFunnelTable = document.getElementById('analyticsFunnelTable');
const analyticsWinReasons = document.getElementById('analyticsWinReasons');
const analyticsLoseReasons = document.getElementById('analyticsLoseReasons');
const analyticsStageReasons = document.getElementById('analyticsStageReasons');
const analyticsBrief = document.getElementById('analyticsBrief');
const analyticsSideFilter = document.getElementById('analyticsSideFilter');
const analyticsProductFilter = document.getElementById('analyticsProductFilter');
const analyticsSignalTypeFilter = document.getElementById('analyticsSignalTypeFilter');
const analyticsSalesTypeFilter = document.getElementById('analyticsSalesTypeFilter');
const analyticsInstrumentFilter = document.getElementById('analyticsInstrumentFilter');
const analyticsPersonaModeFilter = document.getElementById('analyticsPersonaModeFilter');
const analyticsGroupFilter = document.getElementById('analyticsGroupFilter');
const analyticsPersonaFilter = document.getElementById('analyticsPersonaFilter');
const analyticsAggregateBy = document.getElementById('analyticsAggregateBy');
const analyticsExactSliceNote = document.getElementById('analyticsExactSliceNote');
const filterPersona = document.getElementById('filterPersona');
const filterOutcome = document.getElementById('filterOutcome');
const filterVerdict = document.getElementById('filterVerdict');
const sortDialogues = document.getElementById('sortDialogues');
const refreshAnalyticsBtn = document.getElementById('refreshAnalyticsBtn');
const backFromAnalyticsBtn = document.getElementById('backFromAnalyticsBtn');
const runStatus = document.getElementById('runStatus');
const runFocus = document.getElementById('runFocus');
const runScenarioMeta = document.getElementById('runScenarioMeta');
const runRequestedSignal = document.getElementById('runRequestedSignal');
const runActualSignal = document.getElementById('runActualSignal');
const runSignalConfirmation = document.getElementById('runSignalConfirmation');
const suggestBtn = document.getElementById('suggestBtn');
const hintLangSelect = document.getElementById('hintLangSelect');
const suggestionPanel = document.getElementById('suggestionPanel');
const suggestionMeta = document.getElementById('suggestionMeta');
const suggestionText = document.getElementById('suggestionText');
const useSuggestionBtn = document.getElementById('useSuggestionBtn');
const editPersonaBtn = document.getElementById('editPersonaBtn');
const deletePersonaBtn = document.getElementById('deletePersonaBtn');
const cancelPersonaBtn2 = document.getElementById('cancelPersonaBtn2');
const sendResultBtn = document.getElementById('sendResultBtn');
const sendResultStatus = document.getElementById('sendResultStatus');
const reviewTitle = document.getElementById('reviewTitle');
const dialogueTypeMessengerBtn = document.getElementById('dialogueTypeMessenger');
const dialogueTypeEmailBtn = document.getElementById('dialogueTypeEmail');
const dialogueTypeHint = document.getElementById('dialogueTypeHint');
const channelBadge = document.getElementById('channelBadge');
const selectedPersonaEmailPrompt = document.getElementById('selectedPersonaEmailPrompt');
const startAnotherBtn = document.getElementById('startAnotherBtn');
const addPersonaInlineBtn = document.getElementById('addPersonaInlineBtn');
const randomizerToggle = document.getElementById('randomizerToggle');
const randomizerPanel = document.getElementById('randomizerPanel');
const variabilitySelect = document.getElementById('variabilitySelect');
const signalTypeCheckboxes = () => [...document.querySelectorAll('.signal-type-cb')];
const randomFactorToggle = document.getElementById('randomFactorToggle');
const randomFactorPanel = document.getElementById('randomFactorPanel');
const ghostProbInput = document.getElementById('ghostProbInput');
const busyProbInput = document.getElementById('busyProbInput');
const deferProbInput = document.getElementById('deferProbInput');
const runSignalBadge = document.getElementById('runSignalBadge');
const runSignalPanel = document.getElementById('runSignalPanel');
const buyerBriefCard = document.getElementById('buyerBriefCard');
const runSignalCard = document.getElementById('runSignalCard');
const buyerStateTurnMeta = document.getElementById('buyerStateTurnMeta');
const buyerStateLivePanel = document.getElementById('buyerStateLivePanel');
const buyerBriefPanel = document.getElementById('buyerBriefPanel');
const nextMovePanel = document.getElementById('nextMovePanel');
const progressRail = document.getElementById('progressRail');
const progressStageMeta = document.getElementById('progressStageMeta');
const composerFocus = document.getElementById('composerFocus');
const moveTypeButtons = () => [...document.querySelectorAll('[data-move-type]')];
const proofLayerButtons = () => [...document.querySelectorAll('[data-proof-layer]')];
const runMetaPersona = document.getElementById('runMetaPersona');
const messageForm_el = document.getElementById('messageForm');
const runComposerSlot = document.getElementById('runComposerSlot');
const runEndCard = document.getElementById('runEndCard');
const hintNote = document.getElementById('hintNote');
const sendBtn = document.getElementById('sendBtn');
const endRunConfirmDialog = document.getElementById('endRunConfirmDialog');
const endRunConfirmBtn = document.getElementById('endRunConfirmBtn');
const endRunCancelBtn = document.getElementById('endRunCancelBtn');
const runReplayBackBtn = document.getElementById('runReplayBackBtn');

let analyticsData = null;

const historyPanel = document.getElementById('historyPanel');
const historyMeta = document.getElementById('historyMeta');
const historyList = document.getElementById('historyList');
const historyBulkActions = document.getElementById('historyBulkActions');
const openHistoryBtn = document.getElementById('openHistoryBtn');
const backFromHistoryBtn = document.getElementById('backFromHistoryBtn');
const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');
const historySelectAllBtn = document.getElementById('historySelectAllBtn');
const historyDeselectAllBtn = document.getElementById('historyDeselectAllBtn');
const historyDownloadSelectedBtn = document.getElementById('historyDownloadSelectedBtn');
const historyDownloadAllBtn = document.getElementById('historyDownloadAllBtn');
const historyViewModal = document.getElementById('historyViewModal');
const historyViewTitle = document.getElementById('historyViewTitle');
const historyViewMeta = document.getElementById('historyViewMeta');
const historyViewVerdict = document.getElementById('historyViewVerdict');
const historyViewCriteria = document.getElementById('historyViewCriteria');
const historyViewTranscript = document.getElementById('historyViewTranscript');
const historyViewDownloadJson = document.getElementById('historyViewDownloadJson');
const historyViewDownloadMd = document.getElementById('historyViewDownloadMd');
const historyViewClose = document.getElementById('historyViewClose');
const backToHistoryBtn = document.getElementById('backToHistoryBtn');
const downloadResultBtn = document.getElementById('downloadResultBtn');
const copyShareLinkBtn = document.getElementById('copyShareLinkBtn');
const appVersion = document.getElementById('appVersion');
const settingsPanelTitle = document.getElementById('settingsPanelTitle');
const settingsLayerField = document.getElementById('settingsLayerField');
const settingsLayerSelect = document.getElementById('settingsLayerSelect');
const settingsRecordList = document.getElementById('settingsRecordList');
const doctrineForm = document.getElementById('doctrineForm');
const doctrineEditorTitle = document.getElementById('doctrineEditorTitle');
const doctrineInheritancePreview = document.getElementById('doctrineInheritancePreview');
const saveDoctrineBtn = document.getElementById('saveDoctrineBtn');

const doctrineLabelInput = document.getElementById('doctrineLabel');
const doctrineDescriptionInput = document.getElementById('doctrineDescription');
const doctrineSideInput = document.getElementById('doctrineSide');
const doctrineProductInput = document.getElementById('doctrineProduct');
const doctrineGroupInput = document.getElementById('doctrineGroup');
const doctrineDialogueTypesInput = document.getElementById('doctrineDialogueTypes');
const doctrineEnvironmentsInput = document.getElementById('doctrineEnvironments');
const doctrineObjectiveInput = document.getElementById('doctrineObjective');
const doctrineValueFrameInput = document.getElementById('doctrineValueFrame');
const doctrineProofPolicyInput = document.getElementById('doctrineProofPolicy');
const doctrineAskPolicyInput = document.getElementById('doctrineAskPolicy');
const doctrineSuccessCriteriaInput = document.getElementById('doctrineSuccessCriteria');
const doctrineAllowedMovesInput = document.getElementById('doctrineAllowedMoves');
const doctrineForbiddenMovesInput = document.getElementById('doctrineForbiddenMoves');
const doctrineToneRulesInput = document.getElementById('doctrineToneRules');
const sliceWorkbench = document.getElementById('sliceWorkbench');
const legacyDoctrineSettings = document.getElementById('legacyDoctrineSettings');
const sliceWorkbenchTitle = document.getElementById('sliceWorkbenchTitle');
const saveSliceWorkbenchBtn = document.getElementById('saveSliceWorkbenchBtn');
const sliceWorkbenchMeta = document.getElementById('sliceWorkbenchMeta');
const sliceWorkbenchEditor = document.getElementById('sliceWorkbenchEditor');
const workbenchSideFilter = document.getElementById('workbenchSideFilter');
const workbenchProductFilter = document.getElementById('workbenchProductFilter');
const workbenchSalesTypeFilter = document.getElementById('workbenchSalesTypeFilter');
const workbenchInstrumentFilter = document.getElementById('workbenchInstrumentFilter');
const workbenchPersonaModeFilter = document.getElementById('workbenchPersonaModeFilter');
const workbenchGroupFilter = document.getElementById('workbenchGroupFilter');
const workbenchPersonaFilter = document.getElementById('workbenchPersonaFilter');
const workbenchSignalTypeFilter = document.getElementById('workbenchSignalTypeFilter');

const navPhaseButtons = [
  [navRunBtn, 'run'],
  [openAnalyticsBtn, 'analytics'],
  [openHistoryBtn, 'history'],
  [openDoctrineSettingsBtn, 'settings'],
  [openSignalSettingsBtn, 'settings'],
  [openPersonaSettingsBtn, 'settings'],
].filter(([el]) => el);

let historyData = [];
let historySelectedIds = new Set();

const LIVE_BUYER_STATE_DIMENSIONS = [
  ['patience', 'Patience'],
  ['trust', 'Trust'],
  ['interest', 'Interest'],
  ['perceived_value', 'Perceived value'],
  ['conversation_capacity', 'Conversation capacity'],
  ['clarity', 'Clarity'],
];

const LIVE_BUYER_METRIC_KEYS = [
  ['reply_likelihood', 'Reply likelihood'],
  ['next_step_likelihood', 'Next-step likelihood'],
  ['disengagement_risk', 'Disengagement risk'],
];

async function api(path, options = {}) {
  // Normalize to absolute path so calls work under nested routes (e.g. /share/<id>)
  // where a relative `api/...` would resolve against /share/ and fall through to
  // the SPA catch-all, returning index.html instead of JSON.
  const url = path.startsWith('/') ? path : `/${path}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Request failed');
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sellerMessages() {
  return state.session?.transcript?.filter((m) => m.role === 'seller') || [];
}

function buildUrlForState() {
  const params = new URLSearchParams();
  if (state.selectedPersonaId) params.set('persona', state.selectedPersonaId);
  if (state.dialogueType) params.set('dialogueType', state.dialogueType);
  if (state.selectedSide) params.set('side', state.selectedSide);
  if (state.selectedProduct) params.set('product', state.selectedProduct);
  if (state.selectedSignalType) params.set('signalType', state.selectedSignalType);
  if (state.selectedScenarioDialogueType) params.set('scenarioDialogueType', state.selectedScenarioDialogueType);
  if (state.selectedGroupId) params.set('group', state.selectedGroupId);
  if (state.phase === 'run' && state.session?.session_id) params.set('session', state.session.session_id);

  const query = params.toString();
  if (state.phase === 'analytics') return '/analytics';
  if (state.phase === 'history') return '/history';
  if (state.phase === 'settings') return `/settings${query ? `?${query}` : ''}`;
  if (state.phase === 'review' && state.session?.session_id) return `/share/${encodeURIComponent(state.session.session_id)}`;
  if (state.phase === 'run') return `/run${query ? `?${query}` : ''}`;
  return `/${query ? `?${query}` : ''}`;
}

function syncRoute(replace = false) {
  const nextUrl = buildUrlForState();
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl === currentUrl) return;
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({ phase: state.phase, sessionId: state.session?.session_id || null }, '', nextUrl);
}

function showPhase(phase, options = {}) {
  const { replace = false, skipRoute = false } = options;
  state.phase = phase;
  setupPanel.classList.toggle('hidden', phase !== 'setup');
  runPanel.classList.toggle('hidden', phase !== 'run');
  reviewPanel.classList.toggle('hidden', phase !== 'review');
  analyticsPanel.classList.toggle('hidden', phase !== 'analytics');
  historyPanel.classList.toggle('hidden', phase !== 'history');
  settingsPanel.classList.toggle('hidden', phase !== 'settings');
  updateSidebarNav();
  if (!skipRoute) syncRoute(replace);
}

function sidebarActivePhase() {
  if (state.phase === 'analytics') return 'analytics';
  if (state.phase === 'history') return 'history';
  if (state.phase === 'settings') return 'settings';
  return 'run';
}

function updateSidebarNav() {
  const active = sidebarActivePhase();
  navPhaseButtons.forEach(([button, phase]) => {
    const isSettingsButton = phase === 'settings';
    const settingsMatch = active === 'settings' && (
      (button === openDoctrineSettingsBtn && state.settingsMode === 'doctrine')
      || (button === openSignalSettingsBtn && state.settingsMode === 'signal')
      || (button === openPersonaSettingsBtn && state.settingsMode === 'persona')
    );
    const isActive = isSettingsButton ? settingsMatch : phase === active;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}

function updateComposerStrategyChips() {
  moveTypeButtons().forEach((button) => {
    button.classList.toggle('is-active', button.dataset.moveType === state.moveType);
  });
  proofLayerButtons().forEach((button) => {
    button.classList.toggle('is-active', button.dataset.proofLayer === state.proofLayer);
  });
}

async function loadVersionInfo() {
  if (!appVersion) return;
  try {
    const response = await fetch('/version.json');
    if (!response.ok) throw new Error('Version unavailable');
    const payload = await response.json();
    const label = payload.display_version || payload.version || 'unknown';
    appVersion.textContent = `Version ${label}`;
  } catch {
    appVersion.textContent = 'Version unavailable';
  }
}

function badgeClass(status) {
  if (status === 'PASS') return 'pass';
  if (status === 'PASS_WITH_NOTES') return 'note';
  return status === 'BLOCKER' ? 'blocker' : 'fail';
}

function heatLabel(value) {
  return {
    hot: 'Hot',
    warm: 'Warm',
    cold: 'Cold'
  }[String(value || '').toLowerCase()] || value;
}

function statusLabel(status) {
  return {
    PASS: 'Strong',
    PASS_WITH_NOTES: 'Good',
    FAIL: 'Weak',
    BLOCKER: 'Critical'
  }[status] || status;
}

function formatSignedDelta(value) {
  const numeric = Number(value || 0);
  if (!numeric) return '0';
  return numeric > 0 ? `+${numeric}` : `${numeric}`;
}

function formatProbability(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  return `${Math.round(numeric * 100)}%`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${(numeric * 100).toFixed(1)}%`;
}

function buyerSignalLabel(signal) {
  return {
    healthy: 'Healthy',
    watch: 'Watch',
    risk: 'Risk',
    steady: 'Steady'
  }[signal] || signal;
}

function hintStageLabel(value) {
  return {
    opening: 'opening',
    follow_up: 'follow-up',
    closing: 'next-step'
  }[value] || value;
}

function latestBuyerStateTransition() {
  const sellerTurns = (state.session?.transcript || []).filter((message) => message.role === 'seller' && message.buyer_state_transition);
  return sellerTurns.length ? sellerTurns[sellerTurns.length - 1].buyer_state_transition : null;
}

function verdictBadgeClass(verdict) {
  if (verdict === 'PASS') return 'pass';
  if (verdict === 'PASS_WITH_NOTES') return 'note';
  if (verdict === 'BLOCKER') return 'blocker';
  return 'fail';
}

function renderDialogueCards(items, total) {
  if (!items.length) {
    analyticsRecentRuns.innerHTML = '<p class="muted">No dialogues match the current filter.</p>';
    analyticsDialogueCount.textContent = '';
    return;
  }
  const shown = items.length;
  const totalCount = total != null ? total : shown;
  analyticsDialogueCount.textContent = shown < totalCount
    ? `Showing ${shown} of ${totalCount} dialogues (most recent)`
    : `${shown} dialogue${shown !== 1 ? 's' : ''}`;

  const html = items.map((item) => {
    const successCriteria = (item.assessment_criteria || []).filter((c) => c.status === 'PASS' || c.status === 'PASS_WITH_NOTES');
    const failCriteria = (item.assessment_criteria || []).filter((c) => c.status === 'FAIL' || c.status === 'BLOCKER');
    const hasTactics = successCriteria.length > 0 || failCriteria.length > 0;
    const turningPoint = item.turning_point;

    const successList = successCriteria.length
      ? `<ul class="tactics-list tactics-list--success">${successCriteria.map((c) =>
          `<li><strong>${escapeHtml(c.label)}</strong>${c.short_reason ? ` — <span class="muted">${escapeHtml(c.short_reason)}</span>` : ''}</li>`
        ).join('')}</ul>`
      : '';

    const failList = failCriteria.length
      ? `<ul class="tactics-list tactics-list--fail">${failCriteria.map((c) =>
          `<li><strong>${escapeHtml(c.label)}</strong>${c.short_reason ? ` — <span class="muted">${escapeHtml(c.short_reason)}</span>` : ''}</li>`
        ).join('')}</ul>`
      : '';

    const tacticsSection = hasTactics ? `
      <div class="dialogue-tactics">
        ${successList ? `<div class="tactics-section"><span class="tactics-label tactics-label--success">What worked</span>${successList}</div>` : ''}
        ${failList ? `<div class="tactics-section"><span class="tactics-label tactics-label--fail">What didn't work</span>${failList}</div>` : ''}
      </div>` : '';

    const turningPointSection = turningPoint?.quote
      ? `<div class="turning-point-block"><span class="tactics-label">Turning point</span><blockquote class="turning-point-quote">${escapeHtml(turningPoint.quote)}</blockquote>${turningPoint.why ? `<p class="muted turning-point-why">${escapeHtml(turningPoint.why)}</p>` : ''}</div>`
      : '';

    const summarySection = item.assessment_summary
      ? `<p class="dialogue-assessment-summary muted">${escapeHtml(item.assessment_summary)}</p>`
      : '';

    const dialogueTypeBadge = item.dialogue_type === 'email'
      ? '<span class="channel-badge channel-badge--email">Email</span>'
      : '<span class="channel-badge channel-badge--messenger">Messenger</span>';

    const signalBadge = item.signal_type
      ? `<span class="signal-type-badge">${escapeHtml(item.signal_type.replace(/_/g, ' ').toLowerCase())}</span>`
      : '';

    const progressionScore = Number(item.progression_score);
    const progressionBadge = Number.isFinite(progressionScore)
      ? `<span class="progression-score-badge progression-score-badge--${progressionScore >= 70 ? 'high' : progressionScore >= 40 ? 'mid' : 'low'}">Score ${Math.round(progressionScore)}</span>`
      : '';

    const failureReasonBadge = item.failure_reason && item.failure_reason !== 'none' && !item.meeting_booked
      ? `<span class="signal-type-badge">${escapeHtml(item.failure_reason.replace(/_/g, ' '))}</span>`
      : '';

    return `
      <div class="analytics-dialogue-card">
        <div class="dialogue-card-header">
          <div class="dialogue-card-title">
            <strong>${escapeHtml(item.persona_name || item.persona_id || 'Unknown')}</strong>
            <div class="dialogue-card-meta muted">${escapeHtml(item.session_id || '')} · Turns: ${Number(item.seller_turns || 0)} · ${item.finished_at ? new Date(item.finished_at).toLocaleString() : ''}</div>
          </div>
          <div class="dialogue-card-badges">
            ${item.meeting_booked ? '<span class="badge pass">Meeting booked</span>' : '<span class="badge fail">No meeting</span>'}
            <span class="badge ${verdictBadgeClass(item.assessment_verdict)}">${escapeHtml(item.assessment_verdict || 'N/A')}</span>
            ${progressionBadge}
          </div>
        </div>
        <div class="dialogue-card-tags">${dialogueTypeBadge}${signalBadge}${failureReasonBadge}</div>
        ${summarySection}
        ${tacticsSection}
        ${turningPointSection}
        <details class="transcript-drilldown">
          <summary class="transcript-drilldown-toggle" data-session-id="${escapeHtml(item.session_id)}">Show transcript</summary>
          <div class="transcript-drilldown-body" id="transcript-body-${escapeHtml(item.session_id)}">
            <p class="muted">Loading…</p>
          </div>
        </details>
      </div>
    `;
  }).join('');

  analyticsRecentRuns.innerHTML = html;

  // Client-side sort within the loaded slice
  const sortVal = sortDialogues?.value || 'date_desc';
  const cards = analyticsRecentRuns.querySelectorAll('.analytics-dialogue-card');
  const cardArray = [...cards];
  const sortedItems = [...items];
  if (sortVal === 'date_asc') {
    sortedItems.sort((a, b) => new Date(a.finished_at || 0) - new Date(b.finished_at || 0));
  } else if (sortVal === 'persona') {
    sortedItems.sort((a, b) => (a.persona_name || '').localeCompare(b.persona_name || ''));
  } else if (sortVal === 'outcome') {
    sortedItems.sort((a, b) => Number(b.meeting_booked) - Number(a.meeting_booked));
  } else if (sortVal === 'score_desc') {
    sortedItems.sort((a, b) => Number(b.progression_score || 0) - Number(a.progression_score || 0));
  } else if (sortVal === 'score_asc') {
    sortedItems.sort((a, b) => Number(a.progression_score || 0) - Number(b.progression_score || 0));
  }
  // Re-order DOM if sort changed from default
  if (sortVal !== 'date_desc') {
    const indexMap = new Map(sortedItems.map((item, i) => [item.session_id, i]));
    cardArray.sort((a, b) => {
      const ia = indexMap.get(a.querySelector('[data-session-id]')?.dataset.sessionId) ?? 0;
      const ib = indexMap.get(b.querySelector('[data-session-id]')?.dataset.sessionId) ?? 0;
      return ia - ib;
    });
    cardArray.forEach((card) => analyticsRecentRuns.appendChild(card));
  }

  analyticsRecentRuns.querySelectorAll('.transcript-drilldown').forEach((details) => {
    details.addEventListener('toggle', async () => {
      if (!details.open) return;
      const summary = details.querySelector('summary');
      const sessionId = summary?.dataset.sessionId;
      if (!sessionId) return;
      const body = document.getElementById(`transcript-body-${sessionId}`);
      if (!body || body.dataset.loaded) return;
      try {
        const session = await api(`api/sessions/${sessionId}`);
        const messages = (session.transcript || []).filter((m) => m.role !== 'system');
        body.innerHTML = messages.length
          ? `<div class="transcript-messages">${messages.map((m) => `
              <div class="transcript-msg transcript-msg--${m.role}">
                <span class="transcript-msg-role">${m.role === 'seller' ? 'Seller' : 'Buyer'}</span>
                <p>${escapeHtml(m.text || '')}</p>
              </div>`).join('')}</div>`
          : '<p class="muted">No messages.</p>';
        body.dataset.loaded = '1';
      } catch {
        body.innerHTML = '<p class="muted">Failed to load transcript.</p>';
      }
    });
  });
}

function renderReasonList(container, items, emptyText, options = {}) {
  if (!container) return;
  if (!items?.length) {
    container.innerHTML = `<p class="muted">${escapeHtml(emptyText)}</p>`;
    return;
  }
  container.innerHTML = `<div class="reason-list">${items.map((item) => {
    const rate = Number(item.rate);
    const count = Number(item.count);
    const meta = [Number.isFinite(count) ? `${count} runs` : null, Number.isFinite(rate) ? formatPercent(rate) : null].filter(Boolean).join(' · ');
    return `
      <article class="reason-card${options.tone ? ` reason-card--${options.tone}` : ''}">
        <div class="reason-card-head">
          <strong>${escapeHtml(item.label || item.reason || 'Unknown reason')}</strong>
          ${meta ? `<span class="muted">${escapeHtml(meta)}</span>` : ''}
        </div>
        ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}
      </article>
    `;
  }).join('')}</div>`;
}

function renderFunnelVisual(funnel = []) {
  if (!analyticsFunnelTable) return;
  if (!funnel.length) {
    analyticsFunnelTable.innerHTML = '<p class="muted">No funnel data for this slice yet.</p>';
    return;
  }
  const maxEntered = Math.max(...funnel.map((stage) => Number(stage.entered) || 0), 1);
  analyticsFunnelTable.innerHTML = `<div class="funnel-visual">${funnel.map((stage) => {
    const entered = Number(stage.entered) || 0;
    const conversion = stage.conversion_to_next === null || stage.conversion_to_next === undefined ? null : Number(stage.conversion_to_next);
    const width = Math.max(10, Math.round((entered / maxEntered) * 100));
    return `
      <article class="funnel-stage-card">
        <div class="funnel-stage-head">
          <strong>${escapeHtml(acceptanceStageLabel(stage.stage) || String(stage.stage || '').replace(/_/g, ' '))}</strong>
          <span>${entered}</span>
        </div>
        <div class="funnel-stage-bar"><span style="width:${width}%"></span></div>
        <div class="funnel-stage-meta">
          <span>Entered: ${entered}</span>
          <span>${conversion === null || !Number.isFinite(conversion) ? 'Final stage' : `To next: ${formatPercent(conversion)}`}</span>
        </div>
      </article>
    `;
  }).join('')}</div>`;
}

function renderStageReasons(funnel = []) {
  if (!analyticsStageReasons) return;
  if (!funnel.length) {
    analyticsStageReasons.innerHTML = '<p class="muted">No stage-transition data for this slice yet.</p>';
    return;
  }
  const renderReasonItems = (items = [], emptyText) => items.length
    ? `<ul class="stage-reason-list">${items.map((item) => `<li><strong>${escapeHtml(item.label)}</strong>${item.count ? ` <span class="muted">· ${escapeHtml(String(item.count))}</span>` : ''}${item.summary ? `<p class="muted">${escapeHtml(item.summary)}</p>` : ''}</li>`).join('')}</ul>`
    : `<p class="muted">${emptyText}</p>`;
  analyticsStageReasons.innerHTML = `<div class="stage-reason-stack">${funnel.map((stage) => `
    <article class="stage-reason-card">
      <div class="stage-reason-head">
        <strong>${escapeHtml(acceptanceStageLabel(stage.stage) || String(stage.stage || '').replace(/_/g, ' '))}</strong>
        <span class="muted">${stage.conversion_to_next === null || stage.conversion_to_next === undefined ? 'Final stage' : `To next: ${formatPercent(stage.conversion_to_next)}`}</span>
      </div>
      ${stage.summary ? `<p class="stage-reason-summary">${escapeHtml(stage.summary)}</p>` : ''}
      <div class="stage-reason-grid">
        <div>
          <p class="phase-label">What moved it forward</p>
          ${renderReasonItems(stage.win_reasons || [], 'No clear forward driver captured yet.')}
        </div>
        <div>
          <p class="phase-label">What blocked progress</p>
          ${renderReasonItems(stage.lose_reasons || [], 'No clear blocker captured yet.')}
        </div>
      </div>
    </article>
  `).join('')}</div>`;
}

function applyAnalyticsFilters() {
  const personaModeVal = analyticsPersonaModeFilter?.value || 'general';
  const nextFilters = syncWorkspaceFilterState({
    side: analyticsSideFilter?.value || '',
    product: analyticsProductFilter?.value || '',
    salesType: analyticsSalesTypeFilter?.value || '',
    instrument: analyticsInstrumentFilter?.value || '',
    personaMode: personaModeVal,
    groupId: analyticsGroupFilter?.value || '',
    personaId: analyticsPersonaFilter?.value || '',
    signalType: analyticsSignalTypeFilter?.value || 'general',
  });
  const aggregateByVal = analyticsAggregateBy?.value || 'average';
  const personaVal = filterPersona?.value || '';
  const outcomeVal = filterOutcome?.value || '';
  const verdictVal = filterVerdict?.value || '';

  loadAnalytics({
    ...nextFilters,
    aggregateBy: aggregateByVal || undefined,
    outcome: outcomeVal || undefined,
    verdict: verdictVal || undefined,
  }).catch((err) => {
    if (analyticsGeneratedAt) analyticsGeneratedAt.textContent = err.message || 'Failed to filter';
  });
}

async function loadAnalytics(options = {}) {
  analyticsGeneratedAt.textContent = 'Loading analytics...';
  analyticsPersonaTable.innerHTML = '';
  if (analyticsSignalTable) analyticsSignalTable.innerHTML = '';
  analyticsRecentRuns.innerHTML = '';
  if (analyticsFunnelTable) analyticsFunnelTable.innerHTML = '';
  if (analyticsWinReasons) analyticsWinReasons.innerHTML = '';
  if (analyticsLoseReasons) analyticsLoseReasons.innerHTML = '';
  if (analyticsStageReasons) analyticsStageReasons.innerHTML = '';
  if (analyticsBrief) analyticsBrief.innerHTML = '';
  analyticsData = null;

  const params = new URLSearchParams({ limit: '100' });
  if (options.side) params.set('side', options.side);
  if (options.product) params.set('product', options.product);
  if (options.signalType) params.set('signalType', options.signalType);
  if (options.salesType) params.set('salesType', options.salesType);
  if (options.instrument) params.set('instrument', options.instrument);
  if (options.personaMode) params.set('personaMode', options.personaMode);
  if (options.groupId) params.set('groupId', options.groupId);
  if (options.aggregateBy) params.set('aggregateBy', options.aggregateBy);
  if (options.personaId) params.set('personaId', options.personaId);
  if (options.outcome) params.set('outcome', options.outcome);
  if (options.verdict) params.set('verdict', options.verdict);

  const data = await api(`api/analytics?${params}`);
  analyticsData = data;

  const baselineNote = data.baseline_reset_at ? `, baseline ${new Date(data.baseline_reset_at).toLocaleString()}` : '';
  analyticsGeneratedAt.textContent = `Updated ${new Date(data.generated_at).toLocaleString()}${baselineNote}`;
  const sliceTotals = data.slice?.totals || data.totals || {};
  analyticsSuccessRate.textContent = formatPercent(sliceTotals.meeting_booked_rate);
  analyticsFinishedRuns.textContent = String(sliceTotals.finished_sessions ?? 0);
  analyticsSuccessfulDialogs.textContent = String(sliceTotals.meeting_booked_count ?? 0);

  const renderFilterSelect = (el, items, current, placeholder) => {
    if (!el) return;
    el.innerHTML = `<option value="">${placeholder}</option>` + items.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === current ? ' selected' : ''}>${escapeHtml(item.label || item.id)}</option>`).join('');
  };

  syncWorkspaceFilterState({
    side: options.side || state.workspaceFilters.side,
    product: options.product || state.workspaceFilters.product,
    salesType: options.salesType || state.workspaceFilters.salesType,
    instrument: options.instrument || state.workspaceFilters.instrument,
    personaMode: options.personaMode || state.workspaceFilters.personaMode,
    groupId: options.groupId || state.workspaceFilters.groupId,
    personaId: options.personaId || state.workspaceFilters.personaId,
    signalType: options.signalType || state.workspaceFilters.signalType,
  });
  renderWorkspaceFilterControls('analytics');
  if (analyticsPersonaModeFilter) analyticsPersonaModeFilter.value = state.workspaceFilters.personaMode;
  if (analyticsAggregateBy) analyticsAggregateBy.value = options.aggregateBy || 'average';

  // Populate persona filter
  if (filterPersona) {
    const currentPersonaVal = options.personaId || '';
    const personas = data.slice?.by_persona || data.persona_stats || [];
    filterPersona.innerHTML = '<option value="">All personas</option>' +
      personas.map((p) => `<option value="${escapeHtml(p.persona_id)}"${p.persona_id === currentPersonaVal ? ' selected' : ''}>${escapeHtml((p.doctrine_family_label ? `${p.doctrine_family_label} / ` : '') + (p.persona_name || p.persona_id))}</option>`).join('');
  }
  if (filterOutcome && options.outcome) filterOutcome.value = options.outcome;
  if (filterVerdict && options.verdict) filterVerdict.value = options.verdict;

  const doctrineRows = (data.doctrine_stats || []).map((item) => {
    const funnel = (item.funnel || []).map((stage) => `${stage.stage}: ${stage.entered}${stage.conversion_to_next !== null ? ` → ${formatPercent(stage.conversion_to_next)}` : ''}`).join('<br>');
    return `
      <div class="analytics-row">
        <div>
          <strong>${escapeHtml(item.doctrine_family_label || item.doctrine_family)}</strong>
          <div class="muted">${item.persona_count} personas</div>
        </div>
        <div>${item.runs}</div>
        <div>${formatPercent(item.meeting_booked_rate)}</div>
        <div>${item.meeting_booked_count}</div>
        <div class="muted">${funnel}</div>
      </div>
    `;
  }).join('');

  const personaRowsSource = (options.aggregateBy === 'group' ? (data.slice?.by_group || []) : options.aggregateBy === 'persona' ? (data.slice?.by_persona || []) : (data.persona_stats || []));
  const personaRows = personaRowsSource.map((item) => `
    <div class="analytics-row">
      <div>
        <strong>${escapeHtml(item.persona_name || item.label || item.persona_id || item.group_id)}</strong>
        <div class="muted">${escapeHtml(item.persona_id || item.group_id || '')}${item.doctrine_family_label ? ` · ${escapeHtml(item.doctrine_family_label)}` : ''}</div>
      </div>
      <div>${item.runs}</div>
      <div>${formatPercent(item.meeting_booked_rate)}</div>
      <div>${item.meeting_booked_count}</div>
      <div>${item.avg_turns ?? '—'}</div>
    </div>
  `).join('');

  analyticsPersonaTable.innerHTML = (doctrineRows || personaRows)
    ? `${doctrineRows ? `<div class="analytics-table analytics-table--personas">
        <div class="analytics-row analytics-row--head">
          <div>Doctrine</div>
          <div>Runs</div>
          <div>Booked %</div>
          <div>Meetings</div>
          <div>Funnel</div>
        </div>
        ${doctrineRows}
      </div>` : ''}
      <div class="analytics-table analytics-table--personas">
        <div class="analytics-row analytics-row--head">
          <div>Persona</div>
          <div>Runs</div>
          <div>Booked %</div>
          <div>Meetings</div>
          <div>Avg turns</div>
        </div>
        ${personaRows}
      </div>`
    : '<p class="muted">No finished runs yet.</p>';

  const funnel = data.slice?.funnel || [];
  renderFunnelVisual(funnel);
  renderStageReasons(funnel);

  const brief = data.slice?.analytical_brief;
  if (analyticsExactSliceNote) {
    analyticsExactSliceNote.innerHTML = `<p class="analytics-brief-text">${escapeHtml(brief?.exact_slice_note || 'No exact-slice note yet.')}</p>`;
  }

  if (analyticsBrief) {
    analyticsBrief.innerHTML = brief ? `
      <div class="analytics-brief-block">
        <p class="analytics-brief-text">${escapeHtml(brief.overall || '')}</p>
        <div class="coaching-list">${(brief.stage_summaries || []).map((item) => `<div class="coaching-item"><strong>${escapeHtml(acceptanceStageLabel(item.stage) || item.stage.replace(/_/g, ' '))}</strong><p>${escapeHtml(item.summary || '')}</p></div>`).join('')}</div>
      </div>
    ` : '<p class="muted">No analytical brief for this slice yet.</p>';
  }

  if (analyticsSignalTable) {
    const rows = (data.slice?.by_signal_type || []).map((item) => `
      <div class="analytics-row">
        <div>
          <strong>${escapeHtml(item.label || item.signal_type)}</strong>
          <div class="muted">${escapeHtml(item.signal_type || '')}</div>
        </div>
        <div>${item.runs}</div>
        <div>${formatPercent(item.first_buyer_reply_rate)}</div>
        <div>${item.first_buyer_reply_count ?? '—'}</div>
        <div>${formatPercent(item.meeting_booked_rate)}</div>
      </div>
    `).join('');
    analyticsSignalTable.innerHTML = rows
      ? `<div class="analytics-table analytics-table--personas"><div class="analytics-row analytics-row--head"><div>Signal</div><div>Runs</div><div>First reply %</div><div>Replies</div><div>Booked %</div></div>${rows}</div>`
      : '<p class="muted">No signal analytics for this slice yet.</p>';
  }

  renderDialogueCards(data.recent_finished || [], data.recent_finished_total ?? (data.recent_finished || []).length);
}

function buyerStateSignalForMetric(key, value, buyerState = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'steady';
  if (key === 'conversation_capacity') {
    return numeric <= 1 ? 'risk' : numeric <= 2 ? 'watch' : 'healthy';
  }
  if (key === 'reply_likelihood' || key === 'next_step_likelihood') {
    return numeric < 0.2 ? 'risk' : numeric < 0.45 ? 'watch' : 'healthy';
  }
  if (key === 'disengagement_risk') {
    return numeric >= 0.7 ? 'risk' : numeric >= 0.4 ? 'watch' : 'healthy';
  }
  return numeric <= 25 ? 'risk' : numeric <= 45 ? 'watch' : 'healthy';
}

function formatBuyerMetricValue(key, value, buyerState = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  if (key === 'conversation_capacity') {
    const capacityMax = Number(buyerState.capacity_max);
    return Number.isFinite(capacityMax) ? `${Math.round(numeric)}/${Math.round(capacityMax)}` : String(Math.round(numeric));
  }
  if (key === 'reply_likelihood' || key === 'next_step_likelihood' || key === 'disengagement_risk') {
    return formatProbability(numeric);
  }
  return String(Math.round(numeric));
}

function formatBuyerMetricDelta(key, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'Baseline';
  if (key === 'reply_likelihood' || key === 'next_step_likelihood' || key === 'disengagement_risk') {
    const points = Math.round(numeric * 100);
    return points > 0 ? `+${points}pp` : points < 0 ? `${points}pp` : '0pp';
  }
  return formatSignedDelta(Math.round(numeric));
}

function actualBuyerStateDelta(transition, key) {
  if (!transition) return null;
  const before = Number(transition.state_before?.[key]);
  const after = Number(transition.state_after?.[key]);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return Math.round(after - before);
}

function currentDesiredStep() {
  const stage = state.session?.dialogue_summary?.acceptance_stage || state.session?.meta?.acceptance_stage || 'not_started';
  return {
    not_started: 'Open with a specific signal and narrow the problem',
    mechanics_engaged: 'Clarify the operating problem before proving value',
    economics_engaged: 'Introduce one proof layer, not a broad pitch',
    written_step_requested: 'Offer one-screen proof before asking for a call',
    written_step_accepted: 'Convert accepted material into a bounded review call',
    written_step_then_call: 'Land the short review call clearly and narrowly',
    review_call_ready: 'Ask for the 15-minute review call, nothing broader',
    meeting_booked: 'Meeting booked, preserve clarity and stop selling',
  }[stage] || 'Move one disciplined step forward';
}

function currentAvoidPattern() {
  const persona = selectedPersona();
  if (!state.session) return 'Avoid generic pitching.';
  const stage = state.session?.dialogue_summary?.acceptance_stage || state.session?.meta?.acceptance_stage || 'not_started';
  if (stage === 'written_step_accepted' || stage === 'written_step_then_call') return 'Do not reopen the proof loop after material was accepted.';
  if (persona?.archetype === 'finance') return 'Do not sell trust abstractly, stay on math, control, and payout path.';
  if (persona?.doctrine_family === 'transition_winback') return 'Do not relaunch the whole old conversation, keep the slice narrow.';
  return 'Do not widen scope before the buyer is ready.';
}

function currentMoveWhy() {
  const count = sellerMessages().length;
  const stage = state.session?.dialogue_summary?.acceptance_stage || state.session?.meta?.acceptance_stage || 'not_started';
  if (count === 0) return 'First move should explain why this conversation exists at all.';
  if (stage === 'written_step_accepted') return 'Buyer accepted proof, now the job is to land a bounded review call.';
  if (stage === 'economics_engaged') return 'Buyer is in the logic, but still needs one concrete proof layer.';
  return 'Advance the conversation by one disciplined step, not three.';
}

function renderBuyerBriefPanel() {
  if (!buyerBriefPanel) return;
  const card = state.session?.sde_card;
  if (!card) {
    buyerBriefPanel.innerHTML = '<p class="muted">Start a session to see the buyer brief.</p>';
    return;
  }
  const contact = card.contact || {};
  const company = card.company || {};
  const persona = selectedPersona();
  buyerBriefPanel.innerHTML = `
    <div class="meta-grid run-signal-meta">
      ${[
        contact.name ? ['Buyer', contact.name] : null,
        contact.title ? ['Role', contact.title] : null,
        company.name ? ['Company', company.name] : null,
        company.hq ? ['Location', company.hq] : null,
      ].filter(Boolean).map(([label, value]) => `<div class="meta-item"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`).join('')}
    </div>
    <div class="detail-row"><strong>Doctrine</strong><span>${escapeHtml(persona?.doctrine_family_label || persona?.doctrine_family || 'Custom')}</span></div>
    <div class="detail-row"><strong>Role essence</strong><span>${escapeHtml(roleEssence(persona))}</span></div>
    <div class="detail-row"><strong>What matters now</strong><span>${escapeHtml(card.probable_pain || card.what_happened || 'Narrow the real problem before you pitch.')}</span></div>
  `;
}

function renderRunSignalPanel() {
  if (!runSignalPanel) return;
  const card = state.session?.sde_card;
  if (!card) {
    if (runSignalBadge) runSignalBadge.textContent = '';
    runSignalPanel.innerHTML = '';
    if (runSignalCard) runSignalCard.classList.add('is-hidden');
    return;
  }

  if (runSignalCard) runSignalCard.classList.remove('is-hidden');
  if (runSignalBadge) runSignalBadge.textContent = signalTypeOptionLabel(card.signal_type);
  const hasSellerTurns = (state.session?.transcript || []).some((m) => m.role === 'seller');
  const hintLine = !hasSellerTurns ? (card.first_touch_hint || card.probable_pain || '') : '';
  const chips = [heatLabel(card.heat), card.outreach_window].filter(Boolean);
  runSignalPanel.innerHTML = `
    ${chips.length ? `<div class="run-signal-chip-card__chips">${chips.map((c) => `<span class="run-signal-pill">${escapeHtml(c)}</span>`).join('')}</div>` : ''}
    ${hintLine ? `<p class="signal-hint-line">${escapeHtml(hintLine)}</p>` : ''}
    <details class="signal-details-expand">
      <summary>Details</summary>
      <div class="signal-details-body">
        <div class="detail-row"><strong>What happened</strong><span>${escapeHtml(card.what_happened || '')}</span></div>
        <div class="detail-row"><strong>Probable pain</strong><span>${escapeHtml(card.probable_pain || '')}</span></div>
      </div>
    </details>
  `;
}

function renderBuyerStateLivePanel() {
  if (!buyerStateLivePanel) return;
  const buyerState = state.session?.buyer_state;
  if (!buyerState) {
    buyerStateLivePanel.innerHTML = '<p class="muted">Start a session to see live buyer-state metrics.</p>';
    if (buyerStateTurnMeta) buyerStateTurnMeta.textContent = 'No active session';
    return;
  }

  const latestTransition = latestBuyerStateTransition();
  const turnIndex = Number(latestTransition?.turn_index || 0);
  const readinessLabel = readinessSentence(buyerState.next_step_likelihood);
  if (buyerStateTurnMeta) {
    buyerStateTurnMeta.textContent = turnIndex
      ? `Synced to engine state after seller turn ${turnIndex}`
      : 'Baseline before first seller turn';
  }

  buyerStateLivePanel.innerHTML = `
    <div class="buyer-state-summary buyer-state-summary--live">
      <p class="readiness-summary">${escapeHtml(readinessLabel)}</p>
      <div class="buyer-state-grid">
        ${LIVE_BUYER_METRIC_KEYS.map(([key, label]) => {
          const currentValue = buyerState[key];
          const deltaValue = latestTransition?.derived_metrics_delta?.[key];
          const signal = buyerStateSignalForMetric(key, currentValue, buyerState);
          return `
            <article class="buyer-state-card">
              <div class="buyer-state-card-top">
                <strong>${escapeHtml(label)}</strong>
                <span class="badge ${signal === 'risk' ? 'blocker' : signal === 'watch' ? 'note' : 'pass'}">${escapeHtml(buyerSignalLabel(signal))}</span>
              </div>
              <div class="buyer-state-value-row">
                <span class="buyer-state-value">${escapeHtml(formatBuyerMetricValue(key, currentValue, buyerState))}</span>
                <span class="buyer-state-delta ${Number(deltaValue) > 0 ? 'buyer-state-delta--up' : Number(deltaValue) < 0 ? 'buyer-state-delta--down' : ''}">${escapeHtml(formatBuyerMetricDelta(key, deltaValue))}</span>
              </div>
            </article>
          `;
        }).join('')}
      </div>
      <details class="buyer-state-breakdown">
        <summary>State breakdown</summary>
        <div class="buyer-state-grid">
          ${LIVE_BUYER_STATE_DIMENSIONS.map(([key, label]) => {
            const currentValue = buyerState[key];
            const deltaValue = actualBuyerStateDelta(latestTransition, key);
            const signal = buyerStateSignalForMetric(key, currentValue, buyerState);
            return `
              <article class="buyer-state-card">
                <div class="buyer-state-card-top">
                  <strong>${escapeHtml(label)}</strong>
                  <span class="badge ${signal === 'risk' ? 'blocker' : signal === 'watch' ? 'note' : 'pass'}">${escapeHtml(buyerSignalLabel(signal))}</span>
                </div>
                <div class="buyer-state-value-row">
                  <span class="buyer-state-value">${escapeHtml(formatBuyerMetricValue(key, currentValue, buyerState))}</span>
                  <span class="buyer-state-delta ${Number(deltaValue) > 0 ? 'buyer-state-delta--up' : Number(deltaValue) < 0 ? 'buyer-state-delta--down' : ''}">${escapeHtml(formatBuyerMetricDelta(key, deltaValue))}</span>
                </div>
              </article>
            `;
          }).join('')}
        </div>
      </details>
    </div>
  `;
}

function renderNextMovePanel() {
  if (!nextMovePanel) return;
  nextMovePanel.innerHTML = `
    <div class="detail-row"><strong>Why now</strong><span>${escapeHtml(currentMoveWhy())}</span></div>
    <div class="detail-row"><strong>Current move type</strong><span>${escapeHtml({ clarify: 'Clarify', prove: 'Prove', ask: 'Ask narrowly' }[state.moveType] || 'Clarify')}</span></div>
    <div class="detail-row"><strong>Proof layer</strong><span>${escapeHtml({ case: 'Case snippet', one_screen: 'One-screen proof', calculator: 'Calculator snapshot' }[state.proofLayer] || 'One-screen proof')}</span></div>
    <div class="detail-row"><strong>Avoid</strong><span>${escapeHtml(currentAvoidPattern())}</span></div>
  `;
}

function renderProgressRail() {
  if (!progressRail) return;
  const summary = state.session?.dialogue_summary || {};
  const history = new Set((summary.acceptance_stage_history || []).map((item) => item.stage).filter(Boolean));
  if (summary.acceptance_stage) history.add(summary.acceptance_stage);
  const currentStage = summary.acceptance_stage || 'not_started';
  const stages = [
    ['not_started', 'Context'],
    ['mechanics_engaged', 'Problem'],
    ['economics_engaged', 'Proof logic'],
    ['written_step_accepted', 'Written step'],
    ['review_call_ready', 'Review call'],
    ['meeting_booked', 'Meeting booked'],
  ];
  progressRail.innerHTML = stages.map(([id, label]) => {
    const isCurrent = currentStage === id;
    const isDone = !isCurrent && history.has(id);
    const stateClass = isCurrent ? 'is-current' : isDone ? 'is-done' : '';
    const aria = isCurrent ? ' aria-current="step"' : '';
    return `<div class="progress-step ${stateClass}" role="listitem"${aria}><span class="progress-step-dot"></span><span class="progress-step-label">${escapeHtml(label)}</span></div>`;
  }).join('');
  if (progressStageMeta) progressStageMeta.textContent = currentDesiredStep();
}

function renderRunOverview() {
  renderBuyerBriefPanel();
  renderRunSignalPanel();
  renderBuyerStateLivePanel();
  renderNextMovePanel();
  renderProgressRail();
}

function isLanguageRu() {
  const lang = (hintLangSelect && hintLangSelect.value) || state.session?.language || 'ru';
  return lang === 'ru';
}

function buildSystemSignalCopy(card, persona) {
  const ru = isLanguageRu();
  const headline = (() => {
    const raw = card?.rendered_text || card?.what_happened || '';
    if (!raw) return '';
    const dot = raw.indexOf('.');
    const trimmed = dot > 0 && dot < 100 ? raw.slice(0, dot + 1) : raw.slice(0, 80);
    return trimmed.trim();
  })();
  const signalLabel = card ? signalTypeOptionLabel(card.signal_type) : '';
  const heat = card?.heat ? heatLabel(card.heat) : '';
  const heatChip = heat ? (ru ? `Heat: ${heat}` : `Heat: ${heat}`) : '';
  const window = card?.outreach_window || '';
  const windowChip = window ? (ru ? `Окно: ${window}` : `Window: ${window}`) : '';
  const personaName = card?.contact?.name || persona?.name || '';
  const personaRole = card?.contact?.title || persona?.role || '';
  const personaEssence = persona ? roleEssence(persona) : '';
  const companyLine = card?.company?.name
    ? `${card.company.name}${card.company.hq ? ` · ${card.company.hq}` : ''}`
    : '';
  return {
    eyebrow: ru ? 'Система · Бриф сигнала' : 'System · Signal briefing',
    headline,
    chips: [signalLabel, heatChip, windowChip].filter(Boolean),
    personaTitle: [personaName, personaRole].filter(Boolean).join(' · '),
    personaEssence,
    companyLine,
    openerLabel: ru ? 'Как начать' : 'Suggested opener',
    opener: card?.first_touch_hint || buildFirstTouchFallback(card, persona, ru),
    useDraftLabel: ru ? 'В черновик' : 'Use as draft',
    skeletonLabel: ru ? 'Готовим бриф сигнала…' : 'Preparing signal briefing…',
  };
}

function buildFirstTouchFallback(card, persona, ru) {
  const pain = String(card?.probable_pain || card?.what_happened || '').slice(0, 80);
  if (!pain) {
    return ru
      ? 'Стартуйте с одного конкретного сигнала и одного уточняющего вопроса.'
      : 'Start with one specific signal and one narrow clarifying question.';
  }
  const family = persona?.archetype || persona?.doctrine_family || 'default';
  if (family === 'finance') {
    return ru
      ? `Откройтесь конкретной операционной болью: ${pain}. Не предлагайте продукт сразу — спросите, как они сейчас её закрывают.`
      : `Open with a specific operational pain: ${pain}. Don't pitch — ask how they currently handle it.`;
  }
  if (family === 'legal') {
    return ru
      ? `Сошлитесь на текущий compliance-сигнал: ${pain}. Цель — быстрая 15-минутная проверка процесса, а не презентация.`
      : `Reference the live compliance signal: ${pain}. Aim for a 15-minute process check, not a pitch.`;
  }
  return ru
    ? `Стартуйте с конкретного сигнала: ${pain}. Один уточняющий вопрос, не три.`
    : `Start with a concrete signal: ${pain}. One clarifying question, not three.`;
}

function renderSystemSignalBubble() {
  const card = state.session?.sde_card;
  const persona = selectedPersona();
  const wrap = document.createElement('section');
  wrap.className = 'bubble bubble--system';
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', isLanguageRu() ? 'Бриф сигнала' : 'Signal briefing');

  if (!card) {
    const ru = isLanguageRu();
    wrap.innerHTML = `
      <p class="bubble--system__eyebrow">${escapeHtml(ru ? 'Система · Бриф сигнала' : 'System · Signal briefing')}</p>
      <div class="bubble--system__skeleton" aria-hidden="true">
        <span class="bubble--system__skeleton-line"></span>
        <span class="bubble--system__skeleton-line"></span>
        <span class="bubble--system__skeleton-line bubble--system__skeleton-line--short"></span>
      </div>
    `;
    return wrap;
  }

  const copy = buildSystemSignalCopy(card, persona);
  const ru = isLanguageRu();
  const signalType = card.signal_type ? signalTypeOptionLabel(card.signal_type) : '';
  const heat = card.heat ? heatLabel(card.heat) : '';
  const signalVal = [signalType, heat, copy.headline].filter(Boolean).join(' · ');
  const personaVal = [copy.personaTitle, copy.companyLine].filter(Boolean).join(' · ');
  const labels = {
    signal: ru ? 'Сигнал' : 'Signal',
    persona: ru ? 'Персона' : 'Contact',
    hint: ru ? 'Рекомендация' : 'Recommendation',
  };
  wrap.innerHTML = `
    <p class="bubble--system__eyebrow">${escapeHtml(copy.eyebrow)}</p>
    <div class="brief-lines">
      ${signalVal ? `<div class="brief-line"><span class="brief-label">${escapeHtml(labels.signal)}</span><span class="brief-value">${escapeHtml(signalVal)}</span></div>` : ''}
      ${personaVal ? `<div class="brief-line brief-line--persona"><span class="brief-label">${escapeHtml(labels.persona)}</span><span class="brief-value">${escapeHtml(personaVal)}</span></div>` : ''}
      ${copy.opener ? `<div class="brief-line"><span class="brief-label">${escapeHtml(labels.hint)}</span><span class="brief-value">${escapeHtml(copy.opener)}</span></div>` : ''}
    </div>
    ${copy.opener ? `<button type="button" class="ghost-btn bubble--system__use-draft" data-action="use-as-draft" data-draft="${escapeHtml(copy.opener)}">${escapeHtml(copy.useDraftLabel)}</button>` : ''}
  `;
  return wrap;
}

const REACTION_DELTA_MIN_FRACTION = 0.05;
const REACTION_DELTA_MIN_INTEGER = 1;
const REACTION_METRIC_LABELS = [
  ['next_step_likelihood', 'Next step', 'fraction'],
  ['reply_likelihood', 'Reply', 'fraction'],
  ['disengagement_risk', 'Risk', 'fraction'],
  ['trust', 'Trust', 'integer'],
  ['clarity', 'Clarity', 'integer'],
  ['interest', 'Interest', 'integer'],
  ['perceived_value', 'Value', 'integer'],
  ['patience', 'Patience', 'integer'],
];

function buildReactionDeltas(transition) {
  if (!transition) return [];
  const out = [];
  for (const [key, label, kind] of REACTION_METRIC_LABELS) {
    const fromDerived = transition.derived_metrics_delta?.[key];
    const fromPredicted = transition.predicted_delta?.[key];
    let raw = Number.isFinite(Number(fromDerived)) ? Number(fromDerived) : Number(fromPredicted);
    if (!Number.isFinite(raw)) {
      const before = Number(transition.state_before?.[key]);
      const after = Number(transition.state_after?.[key]);
      if (Number.isFinite(before) && Number.isFinite(after)) raw = after - before;
    }
    if (!Number.isFinite(raw) || raw === 0) continue;
    const threshold = kind === 'fraction' ? REACTION_DELTA_MIN_FRACTION : REACTION_DELTA_MIN_INTEGER;
    if (Math.abs(raw) < threshold) continue;
    out.push({ key, label, kind, value: raw });
  }
  out.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return out;
}

function readinessSentence(nextStep) {
  const ru = isLanguageRu();
  const v = Number(nextStep);
  if (!Number.isFinite(v)) return ru ? 'Покупатель ещё формирует мнение.' : 'Buyer is still forming a view.';
  if (v >= 0.66) return ru ? 'Готов к ограниченному следующему шагу.' : 'Ready for a bounded next step.';
  if (v >= 0.4) return ru ? 'Интерес формируется, нужны доказательства.' : 'Interest is forming, still needs proof.';
  return ru ? 'Рано — сужайте проблему и уточняйте.' : 'Still early, keep narrowing and clarifying.';
}

function formatReactionDelta(delta) {
  if (delta.kind === 'fraction') {
    const pp = Math.round(delta.value * 100);
    return pp > 0 ? `+${pp}pp` : `${pp}pp`;
  }
  const intVal = Math.round(delta.value);
  return intVal > 0 ? `+${intVal}` : `${intVal}`;
}

function renderReactionStrip(transition) {
  if (!transition) return null;
  const deltas = buildReactionDeltas(transition);
  const stageBefore = transition.acceptance_stage_before || transition.state_before?.acceptance_stage;
  const stageAfter = transition.acceptance_stage_after || transition.state_after?.acceptance_stage;
  const stageAdvanced = stageAfter && stageBefore && stageAfter !== stageBefore;
  if (!deltas.length && !stageAdvanced) return null;

  const ru = isLanguageRu();
  const readiness = readinessSentence(transition.state_after?.next_step_likelihood);
  const visible = deltas.slice(0, 3);
  const overflow = deltas.length - visible.length;

  const wrap = document.createElement('div');
  wrap.className = 'bubble-reaction';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');

  const stagePill = stageAdvanced
    ? `<span class="bubble-reaction__stage-pill">${escapeHtml((ru ? 'Перешли к ' : 'Advanced to ') + (acceptanceStageLabel(stageAfter) || String(stageAfter).replace(/_/g, ' ')))}</span>`
    : '';

  const deltasHtml = visible.map((d) => {
    const text = formatReactionDelta(d);
    const arrow = d.value > 0 ? '▲' : '▼';
    const tone = d.value > 0 ? 'is-up' : 'is-down';
    return `<span class="bubble-reaction__delta ${tone}"><span class="bubble-reaction__delta-label">${escapeHtml(d.label)}</span><span class="bubble-reaction__delta-value">${escapeHtml(arrow)} ${escapeHtml(text)}</span></span>`;
  }).join('');

  const overflowHtml = overflow > 0
    ? `<button type="button" class="bubble-reaction__overflow" aria-expanded="false" data-overflow>${ru ? `+${overflow} ещё` : `+${overflow} more`}</button>`
    : '';

  const overflowList = overflow > 0
    ? `<ul class="bubble-reaction__overflow-list hidden">${deltas.slice(3).map((d) => {
        const text = formatReactionDelta(d);
        const arrow = d.value > 0 ? '▲' : '▼';
        return `<li>${escapeHtml(d.label)} ${escapeHtml(arrow)} ${escapeHtml(text)}</li>`;
      }).join('')}</ul>`
    : '';

  wrap.innerHTML = `
    <p class="bubble-reaction__readiness">${escapeHtml(readiness)}</p>
    <div class="bubble-reaction__row">
      <div class="bubble-reaction__deltas">${deltasHtml}${overflowHtml}</div>
      ${stagePill}
    </div>
    ${overflowList}
  `;

  if (overflow > 0) {
    const btn = wrap.querySelector('[data-overflow]');
    const list = wrap.querySelector('.bubble-reaction__overflow-list');
    btn.addEventListener('click', () => {
      const isOpen = !list.classList.contains('hidden');
      list.classList.toggle('hidden', isOpen);
      btn.setAttribute('aria-expanded', String(!isOpen));
    });
  }

  return wrap;
}

function isRunFinishedSession() {
  const status = state.session?.status;
  if (status === 'finished') return true;
  const stage = state.session?.dialogue_summary?.acceptance_stage;
  return stage === 'meeting_booked';
}

// Mirrors server.js detectBuyerMeetingAcceptance (kept in lockstep). Detects
// explicit buyer ACCEPTANCE of a meeting/call (stronger than a bare mention).
function detectBuyerMeetingAcceptance(text, lang) {
  const lower = String(text || '').toLowerCase();
  const isEN = lang === 'en';
  if (isEN) {
    if (/\b(let'?s\s+(do\s+it|talk|connect|meet|schedule|chat|book)|sounds\s+good|that\s+works|i'?m\s+in|works\s+for\s+me|happy\s+to\s+(connect|meet|talk|chat)|sure,?\s*(let'?s|i'?d|we\s+can)|yes,?\s*(let'?s|sounds\s+good|absolutely)|absolutely,?\s*let'?s|great,?\s*let'?s|i'?d\s+be\s+(happy|glad|open)\s+to|book\s+it|set\s+it\s+up|schedule\s+(a\s+)?(call|meeting))\b/i.test(lower)) return true;
    if (/\b(yes|ok|okay|sure|great|good|fine|alright|works)\b/i.test(lower) && /(15|20)[- ]minute|\bcall\b|\bmeeting\b|\bwalkthrough\b/i.test(lower)) return true;
    if (/\b(send|share)\b/i.test(lower) && /\b(brief|memo|one-pager|implementation plan|cost breakdown)\b/i.test(lower) && /\b(then|after that|right after|we can)\b/i.test(lower) && /\b(call|meeting|review)\b/i.test(lower)) return true;
    if (/\b(find|book|hold|set)\b/i.test(lower) && /\b(slot|time)\b/i.test(lower) && /\b(call|meeting|review)\b/i.test(lower)) return true;
    if (/\b(i'?ll|i will|can|could)\b/i.test(lower) && /\b(find|make|give)\b/i.test(lower) && /(15|20)[- ]minute|\bcall\b|\bmeeting\b|\breview\b/i.test(lower)) return true;
    return false;
  } else {
    if (/(рано|не\s+сейчас|не\s+готов|не\s+готова|пока\s+не|позже|подождите|пришлите\s+материал|отправьте\s+материал|для\s+начала)/.test(lower)) return false;
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

function endRunVerdict() {
  const session = state.session;
  if (!session) return { kind: 'fail' };
  const stage = session?.dialogue_summary?.acceptance_stage;
  const lastBuyer = (session.transcript || []).filter((m) => m.role === 'bot' || m.role === 'buyer').slice(-1)[0];
  const detected = lastBuyer?.text && detectBuyerMeetingAcceptance(lastBuyer.text, session.language || 'ru');
  return { kind: stage === 'meeting_booked' || detected ? 'success' : 'fail' };
}

function renderEndCard({ fromHistory = false } = {}) {
  if (!runEndCard) return;
  const a = state.session?.assessment;
  if (!a) {
    runEndCard.classList.add('hidden');
    runEndCard.innerHTML = '';
    return;
  }
  const ru = isLanguageRu();
  const verdict = endRunVerdict();
  const success = verdict.kind === 'success';
  const verdictLine = success
    ? (ru ? 'Встреча назначена' : 'Meeting booked')
    : (ru ? 'Диалог закрыт без встречи' : 'Run closed without a meeting');
  const verdictDotClass = success ? 'run-end__dot run-end__dot--success' : 'run-end__dot run-end__dot--muted';

  const summary = a.summary_for_seller
    || (success
      ? (ru ? 'Покупатель подтвердил следующий шаг.' : 'The buyer confirmed the next step.')
      : (ru ? 'Покупатель не подтвердил встречу — посмотрим, что можно улучшить.' : 'The buyer did not commit — here is what to refine.'));

  const strengths = (a.criteria || []).filter((c) => c.status === 'PASS' || c.status === 'PASS_WITH_NOTES').slice(0, 3);
  const weaknesses = (a.criteria || []).filter((c) => c.status === 'FAIL' || c.status === 'BLOCKER').slice(0, 3);
  const improvements = (() => {
    if (Array.isArray(a.improvements) && a.improvements.length) {
      return a.improvements.slice(0, 3).map((item) => ({
        title: item.label || item.title || (ru ? 'Что улучшить' : 'What to try'),
        reason: item.reason || item.short_reason || ''
      }));
    }
    if (weaknesses.length) {
      return weaknesses.slice(0, 3).map((c) => ({
        title: c.label || c.name || c.id,
        reason: ru
          ? `Потренируйте этот момент в следующем диалоге: ${c.short_reason || ''}`.trim()
          : `Rehearse this in the next run: ${c.short_reason || ''}`.trim(),
      }));
    }
    return [{
      title: ru ? 'Держите дисциплину' : 'Keep the discipline',
      reason: ru
        ? 'Ведите один сигнал → один шаг. Не расширяйте контекст до подтверждённой готовности.'
        : 'One signal, one step. Do not widen scope before readiness is earned.',
    }];
  })();

  const renderItem = (item) => `
    <li class="run-end__item">
      <strong>${escapeHtml(item.title)}</strong>
      ${item.reason ? `<p>${escapeHtml(item.reason)}</p>` : ''}
      ${item.evidence ? `<p class="muted">${escapeHtml(ru ? 'Из диалога: ' : 'Evidence: ')}${escapeHtml(item.evidence)}</p>` : ''}
    </li>
  `;

  const goodItems = strengths.map((c) => ({ title: c.label || c.name || c.id, reason: c.short_reason || '', evidence: c.evidence_quote || '' }));
  const offItems = weaknesses.map((c) => ({ title: c.label || c.name || c.id, reason: c.short_reason || '', evidence: c.evidence_quote || '' }));

  const labels = ru
    ? { good: 'Что получилось', off: 'Что сбоило', next: 'Что улучшить', startAnother: 'Запустить ещё', download: 'Скачать', share: 'Скопировать ссылку', back: 'Назад в историю' }
    : { good: 'What was good', off: 'What was off', next: 'What to try next time', startAnother: 'Start another', download: 'Download', share: 'Share link', back: 'Back to history' };

  const emptyCopy = ru
    ? { good: 'Без явных сильных моментов в этой сессии — вернёмся в следующий раз.', off: 'Серьёзных провалов нет — дальше держим планку.' }
    : { good: 'No clear strengths this run — keep building them next time.', off: 'No major slips this run — keep the bar where it is.' };

  const renderBlock = (label, items, fallbackLine) => {
    const body = items.length
      ? `<ul class="run-end__list">${items.map(renderItem).join('')}</ul>`
      : `<p class="run-end__empty muted">${escapeHtml(fallbackLine)}</p>`;
    return `<section class="run-end__block"><p class="run-end__label">${escapeHtml(label)}</p>${body}</section>`;
  };

  runEndCard.innerHTML = `
    <p class="run-end__verdict"><span class="${verdictDotClass}" aria-hidden="true"></span>${escapeHtml(verdictLine)}</p>
    <p class="run-end__summary muted">${escapeHtml(summary)}</p>
    ${renderBlock(labels.good, goodItems, emptyCopy.good)}
    ${renderBlock(labels.off, offItems, emptyCopy.off)}
    <section class="run-end__block"><p class="run-end__label">${escapeHtml(labels.next)}</p><ul class="run-end__list">${improvements.map(renderItem).join('')}</ul></section>
    <div class="run-end__actions">
      <button type="button" class="launch-btn" data-end-action="start-another">${escapeHtml(labels.startAnother)}</button>
      <button type="button" class="ghost-btn" data-end-action="download">${escapeHtml(labels.download)}</button>
      <button type="button" class="ghost-btn" data-end-action="share">${escapeHtml(labels.share)}</button>
      ${fromHistory ? `<button type="button" class="ghost-btn" data-end-action="back-to-history">${escapeHtml(labels.back)}</button>` : ''}
    </div>
  `;
  runEndCard.classList.remove('hidden');
  wireEndCardActions();
}

function wireEndCardActions() {
  if (!runEndCard) return;
  runEndCard.querySelectorAll('[data-end-action]').forEach((btn) => {
    const action = btn.dataset.endAction;
    btn.addEventListener('click', () => {
      if (action === 'start-another') {
        resetToSetup();
      } else if (action === 'download' && state.session?.session_id) {
        const a = document.createElement('a');
        a.href = `api/sessions/${state.session.session_id}/download`;
        a.download = '';
        a.click();
      } else if (action === 'share' && state.session?.session_id) {
        const url = `${location.origin}/share/${state.session.session_id}`;
        navigator.clipboard?.writeText(url).then(() => {
          const orig = btn.textContent;
          btn.textContent = isLanguageRu() ? 'Скопировано' : 'Copied!';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        }).catch(() => prompt(isLanguageRu() ? 'Ссылка:' : 'Share link:', url));
      } else if (action === 'back-to-history') {
        showPhase('history');
      }
    });
  });
}

function setComposerVisibility() {
  if (!runComposerSlot || !messageForm_el || !runEndCard) return;
  const finished = isRunFinishedSession();
  const replay = !!state.replayMode;
  if (finished || replay) {
    messageForm_el.classList.add('hidden');
  } else {
    messageForm_el.classList.remove('hidden');
  }
  if (suggestBtn) suggestBtn.disabled = !state.session || replay || finished;
  if (sendBtn) sendBtn.disabled = !state.session || replay || finished || !messageInput?.value?.trim();
  if (finishBtn) {
    if (replay) {
      finishBtn.classList.add('hidden');
    } else {
      finishBtn.classList.remove('hidden');
    }
    finishBtn.disabled = sellerMessages().length === 0 || finished;
  }
  if (runReplayBackBtn) {
    runReplayBackBtn.classList.toggle('hidden', !(replay && state.fromHistory));
  }
  if (finished && state.session?.assessment) {
    renderEndCard({ fromHistory: state.fromHistory || replay });
  } else {
    runEndCard.classList.add('hidden');
    runEndCard.innerHTML = '';
  }
}

function clearHintNoteSilently() {
  if (!hintNote) return;
  hintNote.classList.add('hidden');
  hintNote.innerHTML = '';
}

function formatHintMemoryMeta(memoryContext) {
  if (!memoryContext || typeof memoryContext !== 'object') {
    return 'Memory loop: no prior examples yet.';
  }
  const wins = Array.isArray(memoryContext.successful) ? memoryContext.successful.length : 0;
  const losses = Array.isArray(memoryContext.unsuccessful) ? memoryContext.unsuccessful.length : 0;
  const best = wins ? memoryContext.successful[0] : null;
  const avoid = losses ? memoryContext.unsuccessful[0] : null;
  const parts = [`Memory loop: ${wins} win${wins === 1 ? '' : 's'}, ${losses} loss${losses === 1 ? '' : 'es'}.`];
  if (best) {
    parts.push(`Best match: ${hintStageLabel(best.turn_stage)}${best.active_concern ? ` / ${best.active_concern}` : ''}.`);
  }
  if (avoid) {
    parts.push(`Avoid repeating: ${hintStageLabel(avoid.turn_stage)}${avoid.active_concern ? ` / ${avoid.active_concern}` : ''}.`);
  }
  return parts.join(' ');
}

function roleEssence(persona) {
  return persona.intro || persona.prompt_style?.[0] || 'Custom buyer persona';
}

function listToTextarea(value) {
  return (Array.isArray(value) ? value : []).join('\n');
}

function textareaToList(value) {
  return String(value || '').split('\n').map((item) => item.trim()).filter(Boolean);
}

async function loadDoctrineConfig() {
  state.doctrineConfig = await api('api/doctrine-config');
}

function doctrineEntries(layer) {
  return Object.values(state.doctrineConfig?.[layer] || {});
}

function normalizeSignalTypeId(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'general';
  return ({ event_reengagement: 're_engagement_signal' }[normalized] || normalized);
}

function signalTypeOptionLabel(id = '') {
  const normalized = normalizeSignalTypeId(id);
  return state.doctrineConfig?.signal_types?.[normalized]?.label
    || String(id || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
    || 'General';
}

function signalSystemMessage() {
  const card = state.session?.sde_card;
  if (!card) return null;
  const signalLabel = signalTypeOptionLabel(card.signal_type || state.selectedSignalType || 'general');
  const core = card.rendered_text || card.what_happened || '';
  const pain = card.probable_pain ? `Pressure point: ${card.probable_pain}.` : '';
  const hint = (!sellerMessages().length && card.first_touch_hint) ? `First angle: ${card.first_touch_hint}.` : '';
  return {
    role: 'system',
    text: [`Signal: ${signalLabel}.`, core, pain, hint].filter(Boolean).join(' '),
  };
}

function filteredSignalTypes() {
  const doctrineSignals = doctrineEntries('signal_types').filter((signal) => {
    if (signal.side && signal.side !== state.selectedSide) return false;
    if (signal.product && signal.product !== state.selectedProduct) return false;
    return true;
  }).map((signal) => ({ id: signal.id, label: signal.label }));

  const personaSignals = [...new Set(state.personas
    .filter((persona) => persona.market_side === state.selectedSide && persona.product === state.selectedProduct)
    .flatMap((persona) => Array.isArray(persona.available_signal_types) ? persona.available_signal_types : []))]
    .map((id) => ({ id, label: signalTypeOptionLabel(id) }));

  const merged = new Map();
  [...doctrineSignals, ...personaSignals].forEach((item) => {
    if (!item?.id) return;
    if (!merged.has(item.id)) merged.set(item.id, item);
  });
  return [...merged.values()];
}

function filteredProducts() {
  return doctrineEntries('products').filter((product) => product.side === state.selectedSide);
}

function filteredGroups() {
  return doctrineEntries('groups').filter((group) => {
    if (group.side && group.side !== state.selectedSide) return false;
    if (group.product && group.product !== state.selectedProduct) return false;
    if (Array.isArray(group.dialogue_types) && group.dialogue_types.length && !group.dialogue_types.includes(state.selectedScenarioDialogueType)) return false;
    if (Array.isArray(group.environments) && group.environments.length && !group.environments.includes(state.dialogueType)) return false;

    const matchingProfiles = state.personas.filter((persona) => {
      if (persona.market_side !== state.selectedSide) return false;
      if (persona.product !== state.selectedProduct) return false;
      if ((persona.group_id || persona.doctrine_family || 'custom') !== group.id) return false;
      if (Array.isArray(persona.dialogue_types) && persona.dialogue_types.length && !persona.dialogue_types.includes(state.selectedScenarioDialogueType)) return false;
      if (Array.isArray(persona.environments) && persona.environments.length && !persona.environments.includes(state.dialogueType)) return false;
      return true;
    });

    return matchingProfiles.length > 0;
  });
}

function filteredPersonas() {
  return state.personas.filter((persona) => {
    if (persona.market_side !== state.selectedSide) return false;
    if (persona.product !== state.selectedProduct) return false;
    if (Array.isArray(persona.dialogue_types) && persona.dialogue_types.length && !persona.dialogue_types.includes(state.selectedScenarioDialogueType)) return false;
    if (Array.isArray(persona.environments) && persona.environments.length && !persona.environments.includes(state.dialogueType)) return false;
    if (state.selectedGroupId && persona.group_id !== state.selectedGroupId) return false;
    return true;
  });
}

function ensureScenarioSelection() {
  const sideIds = doctrineEntries('sides').map((item) => item.id);
  if (!sideIds.includes(state.selectedSide)) state.selectedSide = sideIds[0] || 'demand';

  const products = filteredProducts();
  if (!products.some((item) => item.id === state.selectedProduct)) state.selectedProduct = products[0]?.id || '';

  const signalTypes = filteredSignalTypes();
  if (!signalTypes.some((item) => item.id === state.selectedSignalType)) state.selectedSignalType = signalTypes[0]?.id || 'general';

  const dialogueTypes = doctrineEntries('dialogue_types');
  if (!dialogueTypes.some((item) => item.id === state.selectedScenarioDialogueType)) state.selectedScenarioDialogueType = dialogueTypes[0]?.id || 'outbound';

  const groups = filteredGroups();
  if (state.selectedGroupId && !groups.some((item) => item.id === state.selectedGroupId)) state.selectedGroupId = '';

  const personas = filteredPersonas();
  if (state.selectedPersonaId && !personas.some((item) => item.id === state.selectedPersonaId)) state.selectedPersonaId = '';
}

function renderSelectOptions(selectEl, items, valueKey = 'id', labelKey = 'label', placeholder = '') {
  if (!selectEl) return;
  selectEl.innerHTML = placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : '';
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item[valueKey];
    opt.textContent = item[labelKey] || item[valueKey];
    selectEl.appendChild(opt);
  });
}

function canonicalWorkspaceFilters(overrides = {}) {
  const next = { ...state.workspaceFilters, ...overrides };
  return {
    side: next.side || 'demand',
    product: next.product || 'cor',
    salesType: next.salesType || 'outbound',
    instrument: next.instrument || 'messenger',
    personaMode: ['general', 'group', 'persona'].includes(next.personaMode) ? next.personaMode : 'general',
    groupId: next.personaMode === 'group' ? (next.groupId || '') : '',
    personaId: next.personaMode === 'persona' ? (next.personaId || '') : '',
    signalType: next.signalType || 'general',
  };
}

function personaOptionsForWorkspace(filters = state.workspaceFilters) {
  const current = canonicalWorkspaceFilters(filters);
  return state.personas.filter((persona) => {
    if (persona.market_side !== current.side) return false;
    if (persona.product !== current.product) return false;
    if (Array.isArray(persona.dialogue_types) && persona.dialogue_types.length && !persona.dialogue_types.includes(current.salesType)) return false;
    if (Array.isArray(persona.environments) && persona.environments.length && !persona.environments.includes(current.instrument)) return false;
    return true;
  });
}

function groupOptionsForWorkspace(filters = state.workspaceFilters) {
  const current = canonicalWorkspaceFilters(filters);
  const personaOptions = personaOptionsForWorkspace(current);
  const groupIds = [...new Set(personaOptions.map((persona) => persona.group_id || 'custom'))];
  return groupIds.map((id) => ({ id, label: state.doctrineConfig?.groups?.[id]?.label || id }));
}

function signalOptionsForWorkspace(filters = state.workspaceFilters) {
  const current = canonicalWorkspaceFilters(filters);
  const doctrineSignals = doctrineEntries('signal_types').filter((item) => {
    if (item.side && item.side !== current.side) return false;
    if (item.product && item.product !== current.product) return false;
    return true;
  }).map((item) => ({ id: item.id, label: item.label || item.id }));
  const personaSignals = current.personaMode === 'persona'
    ? [...new Set(state.personas.find((persona) => persona.id === current.personaId)?.available_signal_types || [])].map((id) => ({ id, label: signalTypeOptionLabel(id) }))
    : [];
  const merged = [{ id: 'general', label: 'General' }];
  [...doctrineSignals, ...personaSignals].forEach((item) => {
    if (!merged.some((existing) => existing.id === item.id)) merged.push(item);
  });
  return merged;
}

function syncWorkspaceFilterState(overrides = {}) {
  const next = canonicalWorkspaceFilters(overrides);
  const products = doctrineEntries('products').filter((item) => item.side === next.side);
  if (!products.some((item) => item.id === next.product)) next.product = products[0]?.id || 'cor';

  const personas = personaOptionsForWorkspace(next);
  const groups = groupOptionsForWorkspace(next);
  if (next.personaMode === 'group' && !groups.some((item) => item.id === next.groupId)) next.groupId = groups[0]?.id || '';
  if (next.personaMode === 'persona' && !personas.some((item) => item.id === next.personaId)) next.personaId = personas[0]?.id || '';

  const signals = signalOptionsForWorkspace(next);
  if (!signals.some((item) => item.id === next.signalType)) next.signalType = 'general';
  state.workspaceFilters = next;
  return next;
}

function renderWorkspaceFilterControls(prefix = 'analytics') {
  const filters = syncWorkspaceFilterState();
  const map = prefix === 'workbench'
    ? {
        side: workbenchSideFilter,
        product: workbenchProductFilter,
        salesType: workbenchSalesTypeFilter,
        instrument: workbenchInstrumentFilter,
        personaMode: workbenchPersonaModeFilter,
        group: workbenchGroupFilter,
        persona: workbenchPersonaFilter,
        signal: workbenchSignalTypeFilter,
      }
    : {
        side: analyticsSideFilter,
        product: analyticsProductFilter,
        salesType: analyticsSalesTypeFilter,
        instrument: analyticsInstrumentFilter,
        personaMode: analyticsPersonaModeFilter,
        group: analyticsGroupFilter,
        persona: analyticsPersonaFilter,
        signal: analyticsSignalTypeFilter,
      };

  renderSelectOptions(map.side, doctrineEntries('sides'), 'id', 'label');
  map.side.value = filters.side;
  renderSelectOptions(map.product, doctrineEntries('products').filter((item) => item.side === filters.side), 'id', 'label');
  map.product.value = filters.product;
  renderSelectOptions(map.salesType, doctrineEntries('dialogue_types'), 'id', 'label');
  map.salesType.value = filters.salesType;
  renderSelectOptions(map.instrument, doctrineEntries('environments'), 'id', 'label');
  map.instrument.value = filters.instrument;
  if (map.personaMode) map.personaMode.value = filters.personaMode;
  renderSelectOptions(map.group, groupOptionsForWorkspace(filters), 'id', 'label', 'Persona group');
  map.group.value = filters.groupId || '';
  renderSelectOptions(map.persona, personaOptionsForWorkspace(filters).map((item) => ({ id: item.id, label: item.name })), 'id', 'label', 'Persona');
  map.persona.value = filters.personaId || '';
  renderSelectOptions(map.signal, signalOptionsForWorkspace(filters), 'id', 'label');
  map.signal.value = filters.signalType;
  if (map.group) map.group.classList.toggle('hidden', filters.personaMode !== 'group');
  if (map.persona) map.persona.classList.toggle('hidden', filters.personaMode !== 'persona');
}

async function loadPlaybooks(filters = state.workspaceFilters) {
  const current = syncWorkspaceFilterState(filters);
  const params = new URLSearchParams({
    side: current.side,
    product: current.product,
    salesType: current.salesType,
    instrument: current.instrument,
    personaMode: current.personaMode,
    signalType: current.signalType,
  });
  if (current.groupId) params.set('groupId', current.groupId);
  if (current.personaId) params.set('personaId', current.personaId);
  return api(`api/playbooks?${params}`);
}

function workbenchScopeLabel(filters = state.workspaceFilters) {
  if (filters.personaMode === 'persona') return state.personas.find((persona) => persona.id === filters.personaId)?.name || 'persona';
  if (filters.personaMode === 'group') return state.doctrineConfig?.groups?.[filters.groupId]?.label || 'persona group';
  return 'general slice';
}

function renderSliceWorkbenchEditor(payload) {
  if (!sliceWorkbenchEditor) return;
  const filters = syncWorkspaceFilterState(payload?.filters || state.workspaceFilters);
  const title = state.settingsMode === 'signal' ? 'Signals slice' : 'Doctrine slice';
  if (sliceWorkbenchTitle) sliceWorkbenchTitle.textContent = title;
  if (sliceWorkbenchMeta) sliceWorkbenchMeta.textContent = `${filters.side} → ${filters.product} → ${filters.salesType} → ${filters.instrument} → ${workbenchScopeLabel(filters)} → ${filters.signalType}`;

  if (state.settingsMode === 'signal') {
    const entries = payload?.signals?.entries || [];
    sliceWorkbenchEditor.innerHTML = `<div class="reason-list">${entries.map((entry, index) => `
      <article class="reason-card">
        <div class="reason-card-head"><strong>${escapeHtml(signalTypeOptionLabel(entry.signal_type || `signal_${index + 1}`))}</strong></div>
        <label class="field-group"><span class="field-label">Conversation initiation</span><textarea class="text-input playbook-signal-input" data-signal-type="${escapeHtml(entry.signal_type)}" rows="5">${escapeHtml(entry.conversation_initiation || '')}</textarea></label>
      </article>`).join('')}</div>`;
    return;
  }

  const stages = payload?.doctrine?.stages || [];
  sliceWorkbenchEditor.innerHTML = `<div class="stage-reason-stack">${stages.map((stage) => `
    <article class="stage-reason-card">
      <div class="stage-reason-head"><strong>${escapeHtml(acceptanceStageLabel(stage.stage) || stage.stage.replace(/_/g, ' '))}</strong></div>
      <label class="field-group"><span class="field-label">Seller behavior doctrine</span><textarea class="text-input playbook-stage-behavior" data-stage="${escapeHtml(stage.stage)}" rows="4">${escapeHtml(stage.seller_behavior || '')}</textarea></label>
      <label class="field-group"><span class="field-label">Tone of voice</span><textarea class="text-input playbook-stage-tone" data-stage="${escapeHtml(stage.stage)}" rows="3">${escapeHtml(stage.tone_of_voice || '')}</textarea></label>
    </article>`).join('')}</div>`;
}

async function refreshSliceWorkbench() {
  renderWorkspaceFilterControls('workbench');
  const payload = await loadPlaybooks();
  renderSliceWorkbenchEditor(payload);
}

async function saveSliceWorkbench() {
  if (!saveSliceWorkbenchBtn) return;
  saveSliceWorkbenchBtn.disabled = true;
  try {
    const filters = syncWorkspaceFilterState();
    if (state.settingsMode === 'signal') {
      const entries = [...sliceWorkbenchEditor.querySelectorAll('.playbook-signal-input')].map((node) => ({
        signal_type: node.dataset.signalType,
        conversation_initiation: node.value.trim(),
      }));
      await api('api/playbooks/signals', { method: 'PATCH', body: JSON.stringify({ filters, entries }) });
    } else {
      const stages = [...sliceWorkbenchEditor.querySelectorAll('.playbook-stage-behavior')].map((node) => ({
        stage: node.dataset.stage,
        seller_behavior: node.value.trim(),
        tone_of_voice: sliceWorkbenchEditor.querySelector(`.playbook-stage-tone[data-stage="${CSS.escape(node.dataset.stage)}"]`)?.value?.trim() || '',
      }));
      await api('api/playbooks/doctrine', { method: 'PATCH', body: JSON.stringify({ filters, stages }) });
    }
    await refreshSliceWorkbench();
  } catch (error) {
    alert(`Failed to save slice guidance: ${error.message}`);
  } finally {
    saveSliceWorkbenchBtn.disabled = false;
  }
}

function renderScenarioSelectors() {
  ensureScenarioSelection();
  renderSelectOptions(sideSelect, doctrineEntries('sides'), 'id', 'label');
  sideSelect.value = state.selectedSide;
  renderSelectOptions(productSelect, filteredProducts(), 'id', 'label');
  productSelect.value = state.selectedProduct;
  renderSelectOptions(signalTypeSelect, filteredSignalTypes(), 'id', 'label');
  signalTypeSelect.value = state.selectedSignalType;
  renderSelectOptions(scenarioDialogueTypeSelect, doctrineEntries('dialogue_types'), 'id', 'label');
  scenarioDialogueTypeSelect.value = state.selectedScenarioDialogueType;
  renderSelectOptions(groupSelect, filteredGroups(), 'id', 'label');
  groupSelect.value = state.selectedGroupId;
}

function renderPersonaDropdown() {
  const options = filteredPersonas();
  personaSelect.innerHTML = '<option value="">Choose a profile...</option>';
  options.forEach((persona) => {
    const opt = document.createElement('option');
    opt.value = persona.id;
    opt.textContent = `${persona.name} · ${persona.role}`;
    if (persona.id === state.selectedPersonaId) opt.selected = true;
    personaSelect.appendChild(opt);
  });
}

function selectedScenarioSummary(persona) {
  if (!persona) return '';
  const side = state.doctrineConfig?.sides?.[persona.market_side || state.selectedSide]?.label || state.selectedSide;
  const product = state.doctrineConfig?.products?.[persona.product || state.selectedProduct]?.label || state.selectedProduct;
  const signalType = state.doctrineConfig?.signal_types?.[state.selectedSignalType]?.label || state.selectedSignalType;
  const dialogue = state.doctrineConfig?.dialogue_types?.[state.selectedScenarioDialogueType]?.label || state.selectedScenarioDialogueType;
  const env = state.doctrineConfig?.environments?.[state.dialogueType]?.label || state.dialogueType;
  const group = state.doctrineConfig?.groups?.[persona.group_id || state.selectedGroupId]?.label || persona.group_label || state.selectedGroupId;
  return `${side} / ${product} / ${signalType} / ${dialogue} / ${env} / ${group}`;
}

function selectedPersona() {
  return state.personas.find((persona) => persona.id === state.selectedPersonaId) || null;
}

function renderSetupPersona() {
  const persona = selectedPersona();
  if (!persona) {
    selectedPersonaMeta.textContent = '';
    startConvBtn.disabled = true;
    runDetailsBtn?.setAttribute('disabled', '');
    editPersonaBtn.classList.add('hidden');
    signalBrief.classList.add('hidden');
    if (selectedPersonaPrompt) selectedPersonaPrompt.textContent = '';
    if (selectedPersonaEmailPrompt) selectedPersonaEmailPrompt.textContent = '';
    requiredFieldsList.innerHTML = '';
    return;
  }

  selectedPersonaMeta.textContent = `${selectedScenarioSummary(persona)} · ${roleEssence(persona)}`;
  editPersonaBtn.classList.remove('hidden');
  if (selectedPersonaPrompt) {
    selectedPersonaPrompt.textContent = persona.system_prompt || 'No system prompt yet. Add one in the persona editor.';
  }
  if (selectedPersonaEmailPrompt) {
    selectedPersonaEmailPrompt.textContent = persona.email_prompt || 'No email behavior layer. Add one in the persona editor.';
  }
  requiredFieldsList.innerHTML = (persona.required_fields || []).length
    ? persona.required_fields.map((field) => `<li><strong>${escapeHtml(field.label)}</strong><span>${escapeHtml(field.helpText || 'Required field for managed editing.')}</span></li>`).join('')
    : '<li><span>No field schema yet.</span></li>';
}

function setDialogueType(type, options = {}) {
  const { skipSessionRefresh = false, replaceRoute = false } = options;
  state.dialogueType = type === 'email' ? 'email' : 'messenger';
  dialogueTypeMessengerBtn?.classList.toggle('is-active', state.dialogueType === 'messenger');
  dialogueTypeEmailBtn?.classList.toggle('is-active', state.dialogueType === 'email');
  if (dialogueTypeHint) {
    dialogueTypeHint.textContent = state.dialogueType === 'email'
      ? 'Formal email format. Include greeting, structured body, and sign-off in every message.'
      : 'Short, conversational turns. Think LinkedIn DM or Telegram.';
  }
  // Recreate session with new dialogue type if persona already selected
  if (skipSessionRefresh) {
    renderScenarioSelectors();
    renderPersonaDropdown();
    renderSetupPersona();
    syncRoute(replaceRoute);
    return;
  }
  if (state.selectedPersonaId) {
    syncScenarioFlow(true);
  } else {
    syncRoute(replaceRoute);
  }
}

function renderSignalCard() {
  const { sde_card: card, bot_name } = state.session;
  const ru = isLanguageRu();

  const eyebrow = ru ? 'Система · Бриф сигнала' : 'System · Signal briefing';

  // Signal line: signalType · heat · first sentence of rendered_text (≤80 chars)
  const signalType = signalTypeOptionLabel(card.signal_type) || '';
  const heat = card.heat ? heatLabel(card.heat) : '';
  const rawText = card?.rendered_text || card?.what_happened || '';
  const dot = rawText.indexOf('.');
  const firstSentence = rawText
    ? (dot > 0 && dot < 100 ? rawText.slice(0, dot + 1) : rawText.slice(0, 80)).trim() + (rawText.length > 80 && dot < 0 ? '…' : '')
    : '';
  const signalVal = [signalType, heat, firstSentence].filter(Boolean).join(' · ');

  // Persona line: name · title · company · hq
  const personaName = card.contact?.name ?? bot_name ?? '';
  const personaTitle = card.contact?.title ?? '';
  const companyName = card.company?.name ?? '';
  const hq = card.company?.hq ?? '';
  const personaVal = [personaName, personaTitle, companyName, hq].filter(Boolean).join(' · ');

  // Recommendation line: first_touch_hint (always non-empty via fallback)
  const hint = card.first_touch_hint || buildFirstTouchFallback(card, null, ru);

  const labels = {
    signal: ru ? 'Сигнал' : 'Signal',
    persona: ru ? 'Персона' : 'Contact',
    hint: ru ? 'Рекомендация' : 'Recommendation',
  };

  signalCard.innerHTML = `
    <section class="bubble bubble--system" role="region" aria-label="${escapeHtml(ru ? 'Бриф сигнала' : 'Signal briefing')}">
      <p class="bubble--system__eyebrow">${escapeHtml(eyebrow)}</p>
      <div class="brief-lines">
        ${signalVal ? `<div class="brief-line"><span class="brief-label">${escapeHtml(labels.signal)}</span><span class="brief-value">${escapeHtml(signalVal)}</span></div>` : ''}
        ${personaVal ? `<div class="brief-line brief-line--persona"><span class="brief-label">${escapeHtml(labels.persona)}</span><span class="brief-value">${escapeHtml(personaVal)}</span></div>` : ''}
        ${hint ? `<div class="brief-line"><span class="brief-label">${escapeHtml(labels.hint)}</span><span class="brief-value">${escapeHtml(hint)}</span></div>` : ''}
      </div>
    </section>
  `;
}

function formatBubbleTime(message) {
  const ts = message?.created_at || message?.timestamp;
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function buyerInitials(persona) {
  const name = state.session?.sde_card?.contact?.name || persona?.name || '';
  if (!name) return '·';
  return name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '·';
}

function bubble(message) {
  const frag = document.createDocumentFragment();
  if (message.role === 'system') {
    const el = document.createElement('div');
    el.className = 'bubble system-note';
    el.textContent = message.text;
    frag.appendChild(el);
    return frag;
  }
  const isSeller = message.role === 'seller';
  const wrap = document.createElement('div');
  wrap.className = `bubble-row ${isSeller ? 'bubble-row--seller' : 'bubble-row--buyer'}`;

  if (!isSeller) {
    const persona = selectedPersona();
    const avatar = document.createElement('span');
    avatar.className = 'bubble__avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = buyerInitials(persona);
    wrap.appendChild(avatar);
  }

  const el = document.createElement('div');
  el.className = `bubble ${isSeller ? 'bubble--seller' : 'bubble--buyer'}`;
  const body = document.createElement('p');
  body.className = 'bubble__body';
  body.textContent = message.text || '';
  el.appendChild(body);
  const time = formatBubbleTime(message);
  if (time) {
    const t = document.createElement('span');
    t.className = 'bubble__time muted';
    t.textContent = time;
    el.appendChild(t);
  }
  wrap.appendChild(el);
  frag.appendChild(wrap);
  return frag;
}

function stageLabel(stage) {
  return {
    opening: 'Opening',
    diagnosis: 'Diagnosis',
    proof: 'Proof',
    trust_repair: 'Trust repair',
    pre_ask: 'Pre-ask',
    closing: 'Closing',
  }[stage] || stage || 'Stage';
}

function transcriptHintStageLabel(stage) {
  return {
    diagnosis: 'Clarify',
    proof: 'Prove',
    bridge_step: 'Bounded next step',
    direct_ask: 'Ask narrowly',
    repair: 'Repair trust',
  }[stage] || stageLabel(stage);
}

function acceptanceStageLabel(stage) {
  return {
    mechanics_engaged: 'Problem engaged',
    economics_engaged: 'Economics engaged',
    written_step_requested: 'Written step requested',
    written_step_accepted: 'Written step accepted',
    written_step_then_call: 'Written step, then call',
    review_call_ready: 'Review call ready',
    meeting_booked: 'Meeting booked',
  }[stage] || null;
}

function inferProofLayer(message) {
  const text = String(message?.text || '').toLowerCase();
  if (!text) return null;
  if (/(calculator|calc|калькулятор|расчет|расчёт|модель стоимости|cost breakdown|unit economics)/.test(text)) return 'Calculator snapshot';
  if (/(one.?screen|одн(им|ом) экран|1.?pager|one.?pager|brief|memo|note|summary|схем|таблиц|written)/.test(text)) return 'One-screen proof';
  if (/(case|example|пример|кейс|истор)/.test(text)) return 'Case snippet';
  return null;
}

function formatDeltaChip(label, value) {
  if (!Number.isFinite(Number(value)) || Number(value) === 0) return null;
  const num = Number(value);
  const klass = num > 0 ? 'is-up' : 'is-down';
  return `<span class="annotation-chip ${klass}">${escapeHtml(label)} ${escapeHtml(formatSignedDelta(num))}</span>`;
}

function buildTranscriptAnnotation(message) {
  if (message.role !== 'seller' && message.role !== 'bot') return null;
  const wrap = document.createElement('div');
  wrap.className = `transcript-annotation transcript-annotation--${message.role}`;

  if (message.role === 'seller') {
    const transition = message.buyer_state_transition || {};
    const chips = [
      message.hint_stage ? `<span class="annotation-chip">${escapeHtml(transcriptHintStageLabel(message.hint_stage))}</span>` : null,
      message.turn_stage ? `<span class="annotation-chip">${escapeHtml(stageLabel(message.turn_stage))}</span>` : null,
      message.ask_type && message.ask_type !== 'premature_ask' ? `<span class="annotation-chip">${escapeHtml(message.ask_type.replace(/_/g, ' '))}</span>` : null,
      inferProofLayer(message) ? `<span class="annotation-chip">${escapeHtml(inferProofLayer(message))}</span>` : null,
      formatDeltaChip('Trust', transition?.predicted_delta?.trust),
      formatDeltaChip('Clarity', transition?.predicted_delta?.clarity),
      formatDeltaChip('Next step', transition?.derived_metrics_delta?.next_step_likelihood),
    ].filter(Boolean);

    const notes = [];
    if (message.premature_ask_bool) notes.push('This moved into ask mode before readiness was earned.');
    if (message.acceptance_stage_after) notes.push(`Buyer moved to: ${acceptanceStageLabel(message.acceptance_stage_after) || message.acceptance_stage_after.replace(/_/g, ' ')}`);
    if (message.buyer_reply_outcome === 'silent') notes.push('This turn produced silence, not a reply.');
    if ((transition.coaching_notes || []).length) notes.push(...transition.coaching_notes.slice(0, 2));

    if (!chips.length && !notes.length) return null;
    wrap.innerHTML = `
      ${chips.length ? `<div class="annotation-chip-row">${chips.join('')}</div>` : ''}
      ${notes.length ? `<div class="annotation-notes">${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}</div>` : ''}
    `;
    return wrap;
  }

  const buyerSignals = [];
  if (message.text && detectBuyerMeetingAcceptance(message.text, state.session?.language || 'ru')) {
    buyerSignals.push('Buyer explicitly accepted the meeting.');
  }
  const lastStage = state.session?.meta?.acceptance_stage || state.session?.dialogue_summary?.acceptance_stage;
  if (lastStage && ['written_step_accepted', 'review_call_ready', 'meeting_booked'].includes(lastStage)) {
    buyerSignals.push(`Current acceptance stage: ${acceptanceStageLabel(lastStage) || lastStage.replace(/_/g, ' ')}`);
  }
  if (!buyerSignals.length) return null;
  wrap.innerHTML = `<div class="annotation-notes">${buyerSignals.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}</div>`;
  return wrap;
}

function runStatusCopy(count) {
  const ru = isLanguageRu();
  if (!state.session) return ru ? 'Подготовка' : 'Preparing';
  if (isRunFinishedSession()) {
    return endRunVerdict().kind === 'success'
      ? (ru ? 'Встреча назначена' : 'Meeting booked')
      : (ru ? 'Диалог закрыт' : 'Run closed');
  }
  if (count === 0) return ru ? 'Ждёт первого сообщения' : 'Waiting for first move';
  if (count === 1) return ru ? 'Первое касание отправлено' : 'First touch sent';
  return ru ? `Идёт диалог · ${count} сообщений` : `Active · ${count} messages`;
}

function updateRunState() {
  const count = sellerMessages().length;
  const persona = selectedPersona();

  if (runStatus) runStatus.textContent = runStatusCopy(count);

  if (channelBadge) {
    const type = state.session?.dialogue_type || 'messenger';
    channelBadge.textContent = type === 'email' ? 'Email' : 'Messenger';
    channelBadge.className = `channel-badge channel-badge--${type}`;
  }

  if (runMetaPersona) {
    const name = state.session?.sde_card?.contact?.name || persona?.name || (isLanguageRu() ? 'Покупатель' : 'Buyer');
    const role = state.session?.sde_card?.contact?.title || persona?.role || '';
    runMetaPersona.textContent = role ? `${name} · ${role}` : name;
  }

  if (composerFocus) {
    const move = { clarify: 'Clarify', prove: 'Prove', ask: 'Ask narrowly' }[state.moveType] || 'Clarify';
    const proof = { case: 'case snippet', one_screen: 'one-screen proof', calculator: 'calculator snapshot' }[state.proofLayer] || 'one-screen proof';
    composerFocus.textContent = isLanguageRu()
      ? `Текущий фрейм: ${move} через ${proof}.`
      : `Currently framing: ${move} via ${proof}.`;
  }

  if (messageInput) {
    const ru = isLanguageRu();
    const isEmail = state.session?.dialogue_type === 'email';
    messageInput.placeholder = isEmail
      ? (ru ? 'Напишите письмо: приветствие, тело, подпись…' : 'Compose your email — greeting, body, sign-off…')
      : (ru ? 'Напишите следующее сообщение…' : 'Write your next move…');
  }

  setComposerVisibility();
  renderRunOverview();
}

function renderTranscript() {
  if (!transcript) return;
  transcript.innerHTML = '';
  transcript.appendChild(renderSystemSignalBubble());
  wireSystemBubbleActions();
  const messages = state.session?.transcript || [];
  messages.forEach((m, i) => {
    transcript.appendChild(bubble(m));
    if (m.role === 'bot' || m.role === 'buyer') {
      const prev = messages[i - 1];
      if (prev && prev.role === 'seller' && prev.buyer_state_transition) {
        const strip = renderReactionStrip(prev.buyer_state_transition);
        if (strip) transcript.appendChild(strip);
      }
    }
  });
  transcript.scrollTop = transcript.scrollHeight;
  updateRunState();
}

function wireSystemBubbleActions() {
  if (!transcript) return;
  const useDraftBtn = transcript.querySelector('[data-action="use-as-draft"]');
  if (!useDraftBtn) return;
  useDraftBtn.addEventListener('click', () => {
    if (!messageInput) return;
    const draft = useDraftBtn.dataset.draft || '';
    messageInput.value = draft;
    messageInput.focus();
    try {
      messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
    } catch {}
  });
}

function renderAssessment(fromHistory = false) {
  const a = state.session.assessment;
  reviewTitle.textContent = 'Result';
  // sendResultBtn replaced by native artifact download
  sendResultStatus.textContent = '';

  // History-aware buttons
  downloadResultBtn?.classList.remove('hidden');
  copyShareLinkBtn?.classList.remove('hidden');
  if (fromHistory) {
    backToHistoryBtn?.classList.remove('hidden');
    startAnotherBtn?.classList.add('hidden');
  } else {
    backToHistoryBtn?.classList.add('hidden');
    startAnotherBtn?.classList.remove('hidden');
  }

  const strengths = a.criteria.filter((c) => c.status === 'PASS' || c.status === 'PASS_WITH_NOTES').slice(0, 3);
  const weaknesses = a.criteria.filter((c) => c.status === 'FAIL' || c.status === 'BLOCKER').slice(0, 3);

  const coachingItemHtml = (c) => `
    <div class="coaching-item">
      <div class="coaching-item-head">
        <span class="badge ${badgeClass(c.status)}">${escapeHtml(statusLabel(c.status))}</span>
        <strong>${escapeHtml(c.label || c.name || c.id)}</strong>
      </div>
      <p>${escapeHtml(c.short_reason)}</p>
      ${c.evidence_quote ? `<p class="muted">Evidence: ${escapeHtml(c.evidence_quote)}</p>` : ''}
    </div>
  `;

  const buyerStateReport = a.buyer_state_report;
  const buyerStateSection = buyerStateReport ? `
    <section class="assessment-block">
      <p class="coaching-section-title">Buyer state</p>
      <div class="buyer-state-summary">
        <div class="buyer-state-grid">
          ${buyerStateReport.dimension_summary.map((item) => `
            <article class="buyer-state-card">
              <div class="buyer-state-card-top">
                <strong>${escapeHtml(item.label)}</strong>
                <span class="badge ${item.signal === 'risk' ? 'blocker' : item.signal === 'watch' ? 'note' : 'pass'}">${escapeHtml(buyerSignalLabel(item.signal))}</span>
              </div>
              <div class="buyer-state-value-row">
                <span class="buyer-state-value">${escapeHtml(String(item.end))}</span>
                <span class="buyer-state-delta ${item.delta > 0 ? 'buyer-state-delta--up' : item.delta < 0 ? 'buyer-state-delta--down' : ''}">${escapeHtml(formatSignedDelta(item.delta))}</span>
              </div>
              <p class="muted">Start ${escapeHtml(String(item.start))}</p>
            </article>
          `).join('')}
        </div>
        <div class="buyer-state-metrics">
          <div class="meta-item"><strong>Reply likelihood</strong><span>${escapeHtml(formatProbability(buyerStateReport.final_metrics.reply_likelihood))}</span></div>
          <div class="meta-item"><strong>Next-step likelihood</strong><span>${escapeHtml(formatProbability(buyerStateReport.final_metrics.next_step_likelihood))}</span></div>
          <div class="meta-item"><strong>Disengagement risk</strong><span>${escapeHtml(formatProbability(buyerStateReport.final_metrics.disengagement_risk))}</span></div>
        </div>
      </div>
    </section>

    <section class="assessment-block">
      <p class="coaching-section-title">Buyer-state moments</p>
      <div class="coaching-list">
        ${buyerStateReport.strongest_positive_turn ? `
          <div class="coaching-item">
            <div class="coaching-item-head">
              <span class="badge pass">Best turn</span>
              <strong>Turn ${escapeHtml(String(buyerStateReport.strongest_positive_turn.turn_index))}</strong>
            </div>
            <p>${escapeHtml(buyerStateReport.strongest_positive_turn.seller_message)}</p>
            <p class="muted">${escapeHtml((buyerStateReport.strongest_positive_turn.explanation || []).join(' '))}</p>
          </div>
        ` : ''}
        ${buyerStateReport.biggest_damage_turn ? `
          <div class="coaching-item">
            <div class="coaching-item-head">
              <span class="badge blocker">Damage turn</span>
              <strong>Turn ${escapeHtml(String(buyerStateReport.biggest_damage_turn.turn_index))}</strong>
            </div>
            <p>${escapeHtml(buyerStateReport.biggest_damage_turn.seller_message)}</p>
            <p class="muted">${escapeHtml((buyerStateReport.biggest_damage_turn.explanation || []).join(' '))}</p>
          </div>
        ` : ''}
        ${buyerStateReport.highest_risk_turn ? `
          <div class="coaching-item">
            <div class="coaching-item-head">
              <span class="badge note">Highest risk</span>
              <strong>Turn ${escapeHtml(String(buyerStateReport.highest_risk_turn.turn_index))}</strong>
            </div>
            <p>${escapeHtml(buyerStateReport.highest_risk_turn.seller_message)}</p>
            <p class="muted">${escapeHtml((buyerStateReport.highest_risk_turn.explanation || []).join(' '))}</p>
          </div>
        ` : ''}
      </div>
    </section>
  ` : '';

  const sellerTurnsWithCoaching = (state.session?.transcript || [])
    .filter((m) => m.role === 'seller' && m.buyer_state_transition)
    .filter((m) => (m.buyer_state_transition.coaching_notes || []).length > 0 || (m.buyer_state_transition.risk_flags || []).includes('overclaim_scope'));

  const turnCoachingSection = sellerTurnsWithCoaching.length ? `
    <details class="criteria-details">
      <summary>Turn-by-turn coaching (${sellerTurnsWithCoaching.length} note${sellerTurnsWithCoaching.length > 1 ? 's' : ''})</summary>
      <div class="coaching-list" style="margin-top:12px">
        ${sellerTurnsWithCoaching.map((m) => {
          const t = m.buyer_state_transition;
          const notes = t.coaching_notes || [];
          const flags = t.risk_flags || [];
          const delta = t.predicted_delta || {};
          const trustLabel = delta.trust ? (delta.trust > 0 ? `Trust +${delta.trust}` : `Trust ${delta.trust}`) : '';
          const clarityLabel = delta.clarity ? (delta.clarity > 0 ? `Clarity +${delta.clarity}` : `Clarity ${delta.clarity}`) : '';
          return `
            <div class="coaching-item${flags.includes('overclaim_scope') ? ' coaching-item--critical' : ''}">
              <div class="coaching-item-head">
                <span class="badge ${flags.includes('overclaim_scope') ? 'blocker' : 'note'}">Turn ${escapeHtml(String(t.turn_index))}</span>
                ${trustLabel ? `<span class="turn-delta ${delta.trust > 0 ? 'turn-delta--up' : 'turn-delta--down'}">${escapeHtml(trustLabel)}</span>` : ''}
                ${clarityLabel ? `<span class="turn-delta ${delta.clarity > 0 ? 'turn-delta--up' : 'turn-delta--down'}">${escapeHtml(clarityLabel)}</span>` : ''}
              </div>
              <p class="muted">${escapeHtml(m.text.length > 130 ? m.text.slice(0, 127) + '…' : m.text)}</p>
              ${notes.map((n) => `<p>${escapeHtml(n)}</p>`).join('')}
            </div>`;
        }).join('')}
      </div>
    </details>
  ` : '';

  assessment.innerHTML = `
    <div class="assessment-layout">
      <section class="assessment-block coaching-verdict">
        <span class="badge ${badgeClass(a.verdict)}">${escapeHtml(a.verdict_label || a.verdict)}</span>
        <p>${escapeHtml(a.summary_for_seller)}</p>
      </section>

      ${buyerStateSection}

      ${strengths.length ? `
      <section class="assessment-block">
        <p class="coaching-section-title">Strongest moves</p>
        <div class="coaching-list">${strengths.map(coachingItemHtml).join('')}</div>
      </section>` : ''}

      ${weaknesses.length ? `
      <section class="assessment-block">
        <p class="coaching-section-title">Weak moves</p>
        <div class="coaching-list">${weaknesses.map(coachingItemHtml).join('')}</div>
      </section>` : ''}

      <section class="assessment-block">
        <p class="coaching-section-title">Coaching note</p>
        <p>${escapeHtml(a.turning_point.quote)}</p>
        <p class="muted">${escapeHtml(a.turning_point.why)}</p>
      </section>

      ${turnCoachingSection}

      <details class="criteria-details">
        <summary>Full breakdown</summary>
        <div class="criteria">
          ${a.criteria.map((c) => `
            <article class="criterion">
              <div class="criterion-head">
                <strong>${escapeHtml(c.id)}. ${escapeHtml(c.label || c.name || c.id)}</strong>
                <span class="badge ${badgeClass(c.status)}">${escapeHtml(statusLabel(c.status))}</span>
              </div>
              <p>${escapeHtml(c.short_reason)}</p>
              <p class="muted">Evidence: ${escapeHtml(c.evidence_quote)}</p>
            </article>
          `).join('')}
        </div>
      </details>
    </div>
  `;
}

async function loadPersonas() {
  if (!state.doctrineConfig) await loadDoctrineConfig();
  state.personas = await api('api/personas');
  syncWorkspaceFilterState();
  renderWorkspaceFilterControls('analytics');
  renderWorkspaceFilterControls('workbench');
  ensureScenarioSelection();
  renderScenarioSelectors();
  renderPersonaDropdown();
  renderSetupPersona();
}

async function selectPersona(personaId) {
  state.selectedPersonaId = personaId;
  state.session = null;
  state.lastHint = null;
  state.appliedHintId = null;
  state.replayMode = false;
  state.fromHistory = false;
  transcript.innerHTML = '';
  assessment.innerHTML = '';
  if (runEndCard) { runEndCard.innerHTML = ''; runEndCard.classList.add('hidden'); }
  clearHintNoteSilently();
  signalBrief.classList.add('hidden');
  startConvBtn.disabled = true;
  runDetailsBtn?.setAttribute('disabled', '');
  suggestionPanel?.classList.add('hidden');
  if (suggestionMeta) suggestionMeta.textContent = '';
  resetBtn?.classList.add('hidden');
  renderPersonaDropdown();
  renderSetupPersona();
  showPhase('setup', { replace: true });
  updateRunState();

  if (!personaId) return;

  try {
    state.session = await api('api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        personaId,
        dialogueType: state.dialogueType,
        randomizerConfig: {
          ...state.randomizerConfig,
          signal_types: state.selectedSignalType ? [state.selectedSignalType] : state.randomizerConfig.signal_types,
        },
        scenarioSelection: {
          side: state.selectedSide,
          product: state.selectedProduct,
          signal_type: state.selectedSignalType,
          dialogue_type: state.selectedScenarioDialogueType,
          environment: state.dialogueType,
          group: state.selectedGroupId,
          profile: personaId,
        }
      })
    });
    renderSignalCard();
    signalBrief.classList.remove('hidden');
    startConvBtn.disabled = false;
    runDetailsBtn?.removeAttribute('disabled');
    resetBtn?.classList.remove('hidden');
    updateRunState();
    syncRoute(true);
  } catch (error) {
    signalCard.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    signalBrief.classList.remove('hidden');
    startConvBtn.disabled = false;
    runDetailsBtn?.removeAttribute('disabled');
  }
}

function defaultNewCard() {
  return [{
    signal_type: 'pain_signal',
    heat: 'warm',
    outreach_window: '7 days',
    contact: { name: 'New Contact', title: 'Decision maker', linkedin: '' },
    company: { name: 'NewCo', industry: 'Technology', size: '50 employees', hq: 'Remote', founded_year: 2026, latest_event: 'Team is looking for a more manageable contractor flow.' },
    what_happened: 'Manual coordination and unpredictable payout statuses appeared.',
    apollo_context: ['Describe 2-3 facts that make the signal plausible'],
    target_profile: 'A',
    probable_pain: 'Manual overhead and loss of predictability.',
    recommended_product: 'CM',
    recommended_channel: 'email',
    first_touch_hint: 'Open with a specific pain, not a generic pitch.',
    dont_do: ['Do not overpromise'],
    rendered_text: 'Signal: team is tired of manual contractor/payment flow and wants a more manageable scenario.'
  }];
}

function fillPersonaForm(persona) {
  personaForm.elements.id.value = persona?.id || '';
  personaForm.elements.name.value = persona?.name || '';
  personaForm.elements.role.value = persona?.role || '';
  personaForm.elements.intro.value = persona?.intro || '';
  personaForm.elements.archetype.value = persona?.archetype || 'custom';
  personaForm.elements.tone.value = persona?.tone || 'balanced';
  personaForm.elements.system_prompt.value = persona?.system_prompt || '';
  if (personaForm.elements.email_prompt) personaForm.elements.email_prompt.value = persona?.email_prompt || '';
  personaForm.elements.required_fields.value = JSON.stringify(persona?.required_fields || [], null, 2);
  personaForm.elements.cards.value = JSON.stringify(persona?.cards || defaultNewCard(), null, 2);
  promptExtractStatus.textContent = '';
}

function openPersonaEditor(mode) {
  state.editorMode = mode;
  const persona = mode === 'edit' ? selectedPersona() : null;
  personaEditorTitle.textContent = mode === 'edit' ? 'Edit role' : 'Add role';
  fillPersonaForm(persona);
  deletePersonaBtn.classList.toggle('hidden', mode !== 'edit');
  personaEditor.classList.remove('hidden');
  if (mode === 'create') personaForm.elements.system_prompt.focus();
}

function closePersonaEditor() {
  personaEditor.classList.add('hidden');
}

async function extractFromPrompt() {
  const systemPrompt = personaForm.elements.system_prompt.value.trim();
  if (!systemPrompt) {
    promptExtractStatus.textContent = 'Add a system prompt first.';
    return;
  }

  promptExtractBtn.disabled = true;
  try {
    const result = await api('api/personas/extract-from-prompt', {
      method: 'POST',
      body: JSON.stringify({ system_prompt: systemPrompt })
    });
    const draft = result.draft || {};
    if (!personaForm.elements.name.value.trim() && draft.name) personaForm.elements.name.value = draft.name;
    if (draft.role) personaForm.elements.role.value = draft.role;
    if (draft.intro) personaForm.elements.intro.value = draft.intro;
    personaForm.elements.required_fields.value = JSON.stringify(draft.required_fields || [], null, 2);
    if (!personaForm.elements.cards.value.trim()) {
      personaForm.elements.cards.value = JSON.stringify(defaultNewCard(), null, 2);
    }
    promptExtractStatus.textContent = result.extracted
      ? 'Prompt variables extracted and defaults applied.'
      : 'Extraction was weak, role #1 defaults were applied.';
  } catch (error) {
    promptExtractStatus.textContent = error.message;
  } finally {
    promptExtractBtn.disabled = false;
  }
}

async function syncScenarioFlow(refreshSession = true) {
  ensureScenarioSelection();
  renderScenarioSelectors();
  renderPersonaDropdown();
  renderSetupPersona();
  if (refreshSession && state.selectedPersonaId) {
    await selectPersona(state.selectedPersonaId);
  }
}

function settingsModeMeta() {
  if (state.settingsMode === 'persona') {
    return { title: 'Persona settings', layer: 'profiles', showLayerSelect: false };
  }
  if (state.settingsMode === 'signal') {
    return { title: 'Signal settings', layer: 'signal_types', showLayerSelect: false };
  }
  return { title: 'Doctrine settings', layer: state.settingsLayer || 'sides', showLayerSelect: true };
}

function setSettingsMode(mode) {
  state.settingsMode = ['doctrine', 'signal', 'persona'].includes(mode) ? mode : 'doctrine';
  const meta = settingsModeMeta();
  if (!meta.showLayerSelect) state.settingsLayer = meta.layer;
  state.settingsRecordId = '';
  settingsPanelTitle.textContent = meta.title;
  settingsLayerField?.classList.toggle('settings-layer-hidden', !meta.showLayerSelect);
  legacyDoctrineSettings?.classList.toggle('hidden', state.settingsMode !== 'persona');
  sliceWorkbench?.classList.toggle('hidden', state.settingsMode === 'persona');
  settingsRecordList?.classList.toggle('hidden', state.settingsMode !== 'persona');
  settingsLayerField?.classList.toggle('hidden', state.settingsMode !== 'persona');
  if (meta.showLayerSelect && settingsLayerSelect) settingsLayerSelect.value = state.settingsLayer;
  if (state.settingsMode === 'persona') {
    renderSettingsRecordList();
    renderDoctrineEditor();
  } else {
    renderWorkspaceFilterControls('workbench');
    refreshSliceWorkbench().catch((error) => {
      if (sliceWorkbenchMeta) sliceWorkbenchMeta.textContent = error.message || 'Failed to load slice workbench';
    });
  }
}

function currentDoctrineRecord() {
  const meta = settingsModeMeta();
  return state.doctrineConfig?.[meta.layer]?.[state.settingsRecordId] || null;
}

function renderSettingsRecordList() {
  const meta = settingsModeMeta();
  const items = doctrineEntries(meta.layer);
  if (!items.length) {
    settingsRecordList.innerHTML = '<p class="muted">No doctrine records on this layer yet.</p>';
    return;
  }
  if (!items.some((item) => item.id === state.settingsRecordId)) {
    state.settingsRecordId = items[0]?.id || '';
  }
  settingsRecordList.innerHTML = items.map((item) => `
    <button type="button" class="settings-record-btn${item.id === state.settingsRecordId ? ' is-active' : ''}" data-settings-record="${escapeHtml(item.id)}">
      <strong>${escapeHtml(item.label || item.id)}</strong>
      <span>${escapeHtml(item.description || item.id)}</span>
    </button>
  `).join('');
  settingsRecordList.querySelectorAll('[data-settings-record]').forEach((button) => button.addEventListener('click', () => {
    state.settingsRecordId = button.dataset.settingsRecord || '';
    renderSettingsRecordList();
    renderDoctrineEditor();
  }));
}

function compiledDoctrineChain(profileId = state.selectedPersonaId) {
  const profile = state.doctrineConfig?.profiles?.[profileId] || null;
  if (!profile) return [];
  return [
    ['Side', state.doctrineConfig?.sides?.[profile.side]],
    ['Product', state.doctrineConfig?.products?.[profile.product]],
    ['Dialogue type', state.doctrineConfig?.dialogue_types?.[profile.dialogue_types?.[0] || state.selectedScenarioDialogueType]],
    ['Environment', state.doctrineConfig?.environments?.[profile.environments?.[0] || state.dialogueType]],
    ['Group', state.doctrineConfig?.groups?.[profile.group_id]],
    ['Profile', profile],
  ].filter(([, value]) => value);
}

function renderDoctrineInheritancePreview() {
  const activeProfileId = state.settingsLayer === 'profiles' ? state.settingsRecordId : state.selectedPersonaId;
  const chain = compiledDoctrineChain(activeProfileId);
  doctrineInheritancePreview.innerHTML = chain.length
    ? chain.map(([label, item]) => `
      <article class="inheritance-card">
        <p class="phase-label">${escapeHtml(label)}</p>
        <h3>${escapeHtml(item.label || item.id)}</h3>
        <p class="muted">${escapeHtml(item.description || '')}</p>
        <p>${escapeHtml(item.objective || '')}</p>
      </article>
    `).join('')
    : '<p class="muted">Select a profile-aware scenario to preview inheritance.</p>';
}

function renderDoctrineEditor() {
  const record = currentDoctrineRecord();
  doctrineEditorTitle.textContent = record?.label || 'Select a doctrine';
  doctrineLabelInput.value = record?.label || '';
  doctrineDescriptionInput.value = record?.description || '';
  doctrineSideInput.value = record?.side || '';
  doctrineProductInput.value = record?.product || '';
  doctrineGroupInput.value = record?.group_id || '';
  doctrineDialogueTypesInput.value = listToTextarea(record?.dialogue_types || []);
  doctrineEnvironmentsInput.value = listToTextarea(record?.environments || []);
  doctrineObjectiveInput.value = record?.objective || '';
  doctrineValueFrameInput.value = record?.value_frame || '';
  doctrineProofPolicyInput.value = listToTextarea(record?.proof_policy || []);
  doctrineAskPolicyInput.value = listToTextarea(record?.ask_policy || []);
  doctrineSuccessCriteriaInput.value = listToTextarea(record?.success_criteria || []);
  doctrineAllowedMovesInput.value = listToTextarea(record?.allowed_moves || []);
  doctrineForbiddenMovesInput.value = listToTextarea(record?.forbidden_moves || []);
  doctrineToneRulesInput.value = listToTextarea(record?.tone_rules || []);
  renderDoctrineInheritancePreview();
}

async function saveDoctrineRecord(event) {
  event.preventDefault();
  const meta = settingsModeMeta();
  const record = currentDoctrineRecord();
  if (!record) return;
  saveDoctrineBtn.disabled = true;
  try {
    const payload = {
      label: doctrineLabelInput.value.trim(),
      description: doctrineDescriptionInput.value.trim(),
      side: doctrineSideInput.value.trim(),
      product: doctrineProductInput.value.trim(),
      group_id: doctrineGroupInput.value.trim(),
      dialogue_types: textareaToList(doctrineDialogueTypesInput.value),
      environments: textareaToList(doctrineEnvironmentsInput.value),
      objective: doctrineObjectiveInput.value.trim(),
      value_frame: doctrineValueFrameInput.value.trim(),
      proof_policy: textareaToList(doctrineProofPolicyInput.value),
      ask_policy: textareaToList(doctrineAskPolicyInput.value),
      success_criteria: textareaToList(doctrineSuccessCriteriaInput.value),
      allowed_moves: textareaToList(doctrineAllowedMovesInput.value),
      forbidden_moves: textareaToList(doctrineForbiddenMovesInput.value),
      tone_rules: textareaToList(doctrineToneRulesInput.value),
    };
    await api(`api/doctrine-config/${meta.layer}/${state.settingsRecordId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    await loadDoctrineConfig();
    await loadPersonas();
    renderSettingsRecordList();
    renderDoctrineEditor();
  } catch (error) {
    alert(`Failed to save doctrine: ${error.message}`);
  } finally {
    saveDoctrineBtn.disabled = false;
  }
}

// Persona dropdown
sideSelect?.addEventListener('change', async () => {
  state.selectedSide = sideSelect.value;
  state.selectedProduct = '';
  state.selectedGroupId = '';
  state.selectedPersonaId = '';
  state.session = null;
  await syncScenarioFlow(false);
});

productSelect?.addEventListener('change', async () => {
  state.selectedProduct = productSelect.value;
  state.selectedGroupId = '';
  state.selectedPersonaId = '';
  state.session = null;
  await syncScenarioFlow(false);
});

signalTypeSelect?.addEventListener('change', async () => {
  state.selectedSignalType = signalTypeSelect.value;
  state.session = null;
  if (state.selectedPersonaId) {
    await selectPersona(state.selectedPersonaId);
  } else {
    await syncScenarioFlow(false);
  }
});

scenarioDialogueTypeSelect?.addEventListener('change', async () => {
  state.selectedScenarioDialogueType = scenarioDialogueTypeSelect.value;
  state.selectedGroupId = '';
  state.selectedPersonaId = '';
  state.session = null;
  await syncScenarioFlow(false);
});

groupSelect?.addEventListener('change', async () => {
  state.selectedGroupId = groupSelect.value;
  state.selectedPersonaId = '';
  state.session = null;
  await syncScenarioFlow(false);
});

personaSelect.addEventListener('change', () => {
  selectPersona(personaSelect.value);
});

// Persona editor
personaForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  savePersonaBtn.disabled = true;
  try {
    if (state.editorMode === 'create' && !personaForm.elements.required_fields.value.trim()) {
      await extractFromPrompt();
    }

    const payload = {
      id: personaForm.elements.id.value.trim() || undefined,
      name: personaForm.elements.name.value.trim(),
      role: personaForm.elements.role.value.trim(),
      intro: personaForm.elements.intro.value.trim(),
      archetype: personaForm.elements.archetype.value.trim(),
      tone: personaForm.elements.tone.value.trim(),
      system_prompt: personaForm.elements.system_prompt.value.trim(),
      email_prompt: personaForm.elements.email_prompt?.value?.trim() || '',
      required_fields: JSON.parse(personaForm.elements.required_fields.value || '[]'),
      cards: JSON.parse(personaForm.elements.cards.value || '[]')
    };

    const result = state.editorMode === 'edit'
      ? await api(`api/personas/${state.selectedPersonaId}`, { method: 'PATCH', body: JSON.stringify(payload) })
      : await api('api/personas', { method: 'POST', body: JSON.stringify(payload) });

    await loadPersonas();
    await selectPersona(result.id);
    closePersonaEditor();
  } catch (error) {
    alert(`Failed to save persona: ${error.message}`);
  } finally {
    savePersonaBtn.disabled = false;
  }
});

promptExtractBtn.addEventListener('click', extractFromPrompt);
createPersonaBtn.addEventListener('click', () => openPersonaEditor('create'));
navRunBtn?.addEventListener('click', () => {
  showPhase(state.session ? 'run' : 'setup');
});
moveTypeButtons().forEach((button) => button.addEventListener('click', () => {
  state.moveType = button.dataset.moveType || 'clarify';
  updateComposerStrategyChips();
  updateRunState();
}));
proofLayerButtons().forEach((button) => button.addEventListener('click', () => {
  state.proofLayer = button.dataset.proofLayer || 'one_screen';
  updateComposerStrategyChips();
  updateRunState();
}));
openAnalyticsBtn?.addEventListener('click', async () => {
  showPhase('analytics');
  try {
    await loadAnalytics();
  } catch (error) {
    analyticsGeneratedAt.textContent = error.message || 'Failed to load analytics';
  }
});
function openSettingsSurface(mode) {
  showPhase('settings');
  setSettingsMode(mode);
}
openDoctrineSettingsBtn?.addEventListener('click', () => openSettingsSurface('doctrine'));
openSignalSettingsBtn?.addEventListener('click', () => openSettingsSurface('signal'));
openPersonaSettingsBtn?.addEventListener('click', () => openSettingsSurface('persona'));
settingsLayerSelect?.addEventListener('change', () => {
  state.settingsLayer = settingsLayerSelect.value;
  state.settingsRecordId = '';
  renderSettingsRecordList();
  renderDoctrineEditor();
});
doctrineForm?.addEventListener('submit', saveDoctrineRecord);
refreshAnalyticsBtn?.addEventListener('click', async () => {
  try {
    await loadAnalytics();
  } catch (error) {
    analyticsGeneratedAt.textContent = error.message || 'Failed to refresh analytics';
  }
});
backFromAnalyticsBtn?.addEventListener('click', () => showPhase(state.session ? 'run' : 'setup'));
filterPersona?.addEventListener('change', applyAnalyticsFilters);
filterOutcome?.addEventListener('change', applyAnalyticsFilters);
filterVerdict?.addEventListener('change', applyAnalyticsFilters);
analyticsSideFilter?.addEventListener('change', applyAnalyticsFilters);
analyticsProductFilter?.addEventListener('change', applyAnalyticsFilters);
analyticsSignalTypeFilter?.addEventListener('change', applyAnalyticsFilters);
analyticsSalesTypeFilter?.addEventListener('change', applyAnalyticsFilters);
analyticsInstrumentFilter?.addEventListener('change', applyAnalyticsFilters);
analyticsPersonaModeFilter?.addEventListener('change', applyAnalyticsFilters);
analyticsGroupFilter?.addEventListener('change', applyAnalyticsFilters);
analyticsPersonaFilter?.addEventListener('change', applyAnalyticsFilters);
saveSliceWorkbenchBtn?.addEventListener('click', saveSliceWorkbench);
[workbenchSideFilter, workbenchProductFilter, workbenchSalesTypeFilter, workbenchInstrumentFilter, workbenchPersonaModeFilter, workbenchGroupFilter, workbenchPersonaFilter, workbenchSignalTypeFilter]
  .forEach((node) => node?.addEventListener('change', async () => {
    syncWorkspaceFilterState({
      side: workbenchSideFilter?.value || state.workspaceFilters.side,
      product: workbenchProductFilter?.value || state.workspaceFilters.product,
      salesType: workbenchSalesTypeFilter?.value || state.workspaceFilters.salesType,
      instrument: workbenchInstrumentFilter?.value || state.workspaceFilters.instrument,
      personaMode: workbenchPersonaModeFilter?.value || state.workspaceFilters.personaMode,
      groupId: workbenchGroupFilter?.value || '',
      personaId: workbenchPersonaFilter?.value || '',
      signalType: workbenchSignalTypeFilter?.value || 'general',
    });
    await refreshSliceWorkbench();
  }));
analyticsAggregateBy?.addEventListener('change', applyAnalyticsFilters);
sortDialogues?.addEventListener('change', () => {
  // Sort within currently loaded items without re-fetching
  if (!analyticsData?.recent_finished?.length) return;
  const items = [...(analyticsData.recent_finished || [])];
  renderDialogueCards(items, analyticsData.recent_finished_total);
});
addPersonaInlineBtn?.addEventListener('click', () => openPersonaEditor('create'));
document.getElementById('runDetailsBtn')?.addEventListener('click', () => {
  document.getElementById('runDetailsPanel')?.classList.toggle('hidden');
});
editPersonaBtn.addEventListener('click', () => openPersonaEditor('edit'));
cancelPersonaBtn.addEventListener('click', closePersonaEditor);
cancelPersonaBtn2.addEventListener('click', closePersonaEditor);

deletePersonaBtn.addEventListener('click', async () => {
  const persona = selectedPersona();
  if (!persona) return;
  if (!confirm(`Delete persona "${persona.role}"? This cannot be undone.`)) return;
  deletePersonaBtn.disabled = true;
  try {
    await api(`api/personas/${persona.id}`, { method: 'DELETE' });
    closePersonaEditor();
    state.selectedPersonaId = '';
    await loadPersonas();
    if (state.personas[0]) {
      await selectPersona(state.personas[0].id);
    } else {
      renderSetupPersona();
    }
  } catch (error) {
    alert(`Failed to delete persona: ${error.message}`);
  } finally {
    deletePersonaBtn.disabled = false;
  }
});

// Segmented control
dialogueTypeMessengerBtn?.addEventListener('click', async () => {
  state.selectedPersonaId = '';
  state.session = null;
  setDialogueType('messenger', { skipSessionRefresh: true });
  await syncScenarioFlow(false);
});
dialogueTypeEmailBtn?.addEventListener('click', async () => {
  state.selectedPersonaId = '';
  state.session = null;
  setDialogueType('email', { skipSessionRefresh: true });
  await syncScenarioFlow(false);
});

// Run phase
startConvBtn.addEventListener('click', async () => {
  if (!state.selectedPersonaId) return;
  if (!state.session) {
    await selectPersona(state.selectedPersonaId);
  }
  showPhase('run');
  renderTranscript();
  const isEmail = state.session?.dialogue_type === 'email';
  messageInput.placeholder = isEmail
    ? 'Hi [Name],\n\n[Your message here]\n\nBest, [Your name]'
    : 'Write your first touch or next message';
  messageInput.focus();
});

backToSetupBtn?.addEventListener('click', () => {
  showPhase('setup');
  renderSetupPersona();
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.session || state.replayMode) return;
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = '';
  clearHintNoteSilently();
  const result = await api(`api/sessions/${state.session.session_id}/message`, {
    method: 'POST',
    body: JSON.stringify({ text, hintId: state.appliedHintId })
  });
  state.appliedHintId = null;
  state.session = result.session;
  renderTranscript();
  if (isRunFinishedSession() && state.session.assessment) {
    renderEndCard({ fromHistory: false });
  }
  syncRoute(true);
});

messageInput?.addEventListener('input', () => {
  clearHintNoteSilently();
  if (sendBtn) sendBtn.disabled = !messageInput.value.trim();
});

finishBtn.addEventListener('click', async () => {
  if (!state.session || sellerMessages().length === 0) return;
  if (state.replayMode) return;
  if (endRunConfirmDialog && typeof endRunConfirmDialog.showModal === 'function') {
    const ru = isLanguageRu();
    const text = document.getElementById('endRunConfirmText');
    if (text) text.textContent = ru
      ? 'Завершить диалог? Покажу разбор.'
      : 'End this conversation? You\'ll see your coaching summary.';
    if (endRunCancelBtn) endRunCancelBtn.textContent = ru ? 'Отмена' : 'Cancel';
    if (endRunConfirmBtn) endRunConfirmBtn.textContent = ru ? 'Завершить диалог' : 'End conversation';
    endRunConfirmDialog.returnValue = '';
    endRunConfirmDialog.showModal();
    setTimeout(() => endRunCancelBtn?.focus(), 0);
    return;
  }
  await performFinishRun();
});

endRunConfirmDialog?.addEventListener('close', async () => {
  if (endRunConfirmDialog.returnValue !== 'confirm') return;
  await performFinishRun();
});

async function performFinishRun() {
  if (!state.session || sellerMessages().length === 0) return;
  try {
    state.session = await api(`api/sessions/${state.session.session_id}/finish`, { method: 'POST' });
    renderTranscript();
    renderEndCard({ fromHistory: false });
  } catch (err) {
    console.error('finish failed', err);
  }
}

suggestBtn.addEventListener('click', async () => {
  if (!state.session || state.replayMode) return;
  const ru = isLanguageRu();
  const labelEl = suggestBtn.querySelector('.run-composer__hint-label');
  const originalLabel = labelEl ? labelEl.textContent : 'Hint';
  suggestBtn.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  if (labelEl) labelEl.textContent = ru ? 'Готовлю черновик…' : 'Drafting…';
  try {
    const lang = hintLangSelect ? hintLangSelect.value : 'ru';
    const qs = new URLSearchParams({ lang, moveType: state.moveType, proofLayer: state.proofLayer });
    const result = await api(`api/sessions/${state.session.session_id}/seller-suggest?${qs.toString()}`);
    state.lastHint = {
      id: result.hint_id || null,
      text: result.suggestion || '',
      memoryContext: result.memory_context || null,
    };
    state.appliedHintId = result.hint_id || null;
    const draft = String(result.suggestion || '').trim();
    if (draft && messageInput) {
      const existing = messageInput.value.trim();
      messageInput.value = existing ? `${existing}\n${draft}` : draft;
      messageInput.focus();
      try { messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length); } catch {}
      messageInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (hintNote) {
      const wins = Array.isArray(result.memory_context?.successful) ? result.memory_context.successful.length : 0;
      const note = ru
        ? `Черновик из доктрины и ${wins} прошлых диалогов · `
        : `Drafted from your doctrine and ${wins} prior runs · `;
      const discardLabel = ru ? 'Сбросить черновик' : 'Discard draft';
      hintNote.innerHTML = `${escapeHtml(note)}<button type="button" class="run-composer__hint-discard" id="hintDiscardBtn">${escapeHtml(discardLabel)}</button>`;
      hintNote.classList.remove('hidden');
      const discardBtn = document.getElementById('hintDiscardBtn');
      discardBtn?.addEventListener('click', () => {
        if (messageInput) messageInput.value = '';
        clearHintNoteSilently();
      });
    }
  } catch {
    if (labelEl) labelEl.textContent = ru ? 'Не получилось — попробовать ещё раз' : 'Couldn\'t draft — try again';
    setTimeout(() => { if (labelEl) labelEl.textContent = originalLabel; }, 2400);
  } finally {
    suggestBtn.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    if (labelEl && labelEl.textContent !== (ru ? 'Не получилось — попробовать ещё раз' : 'Couldn\'t draft — try again')) {
      labelEl.textContent = originalLabel;
    }
  }
});

// Reset / start another run
function resetToSetup() {
  state.session = null;
  state.lastHint = null;
  state.appliedHintId = null;
  transcript.innerHTML = '';
  assessment.innerHTML = '';
  sendResultBtn.classList.add('hidden');
  sendResultStatus.textContent = '';
  downloadResultBtn?.classList.add('hidden');
  copyShareLinkBtn?.classList.add('hidden');
  backToHistoryBtn?.classList.add('hidden');
  signalBrief.classList.add('hidden');
  startConvBtn.disabled = true;
  runDetailsBtn?.setAttribute('disabled', '');
  suggestionPanel?.classList.add('hidden');
  if (suggestionMeta) suggestionMeta.textContent = '';
  resetBtn?.classList.add('hidden');
  state.replayMode = false;
  state.fromHistory = false;
  if (runEndCard) { runEndCard.innerHTML = ''; runEndCard.classList.add('hidden'); }
  clearHintNoteSilently();
  if (state.selectedPersonaId) {
    selectPersona(state.selectedPersonaId);
  } else {
    showPhase('setup');
  }
  syncRoute(true);
}

resetBtn?.addEventListener('click', resetToSetup);
startAnotherBtn?.addEventListener('click', resetToSetup);

sendResultBtn.addEventListener('click', async () => {
  if (!state.session) return;
  sendResultBtn.disabled = true;
  sendResultStatus.textContent = '';
  try {
    const result = await api(`api/sessions/${state.session.session_id}/send-result`, { method: 'POST' });
    sendResultStatus.textContent = `Sent to ${result.sent_to}`;
  } catch (err) {
    sendResultStatus.textContent = err.message || 'Failed to send';
  } finally {
    sendResultBtn.disabled = false;
  }
});

// ── История бесед ────────────────────────────────────────────────────────────

async function loadHistory() {
  historyMeta.textContent = 'Загрузка...';
  historySelectedIds = new Set();
  try {
    const result = await api('api/artifacts');
    historyData = result.artifacts || [];
    historyMeta.textContent = `${historyData.length} ${
      historyData.length === 1 ? 'беседа' : historyData.length >= 2 && historyData.length <= 4 ? 'беседы' : 'бесед'
    }`;
    renderHistoryList();
    historyBulkActions?.classList.toggle('hidden', historyData.length === 0);
  } catch (err) {
    historyMeta.textContent = err.message || 'Ошибка загрузки';
  }
}

function verdictLabel(verdict) {
  return { PASS: 'Pass', PASS_WITH_NOTES: 'Pass w/ notes', FAIL: 'Fail', BLOCKER: 'Blocker' }[verdict] || (verdict || '—');
}

function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function renderHistoryList() {
  if (!historyList) return;
  if (historyData.length === 0) {
    historyList.innerHTML = '<p class="muted">Нет сохранённых бесед. Завершите симуляцию, чтобы увидеть её здесь.</p>';
    return;
  }
  historyList.innerHTML = historyData.map((item) => {
    const sid = item.session_id;
    const isChecked = historySelectedIds.has(sid);
    const publicLink = `${window.location.origin}/download/${encodeURIComponent(sid)}`;
    return `
      <div class="history-item run-insight-card" data-session-id="${escapeHtml(sid)}">
        <div class="history-item-row">
          <label class="history-checkbox-label">
            <input type="checkbox" class="history-cb" data-id="${escapeHtml(sid)}" ${isChecked ? 'checked' : ''} />
          </label>
          <div class="history-item-meta">
            <div class="history-item-top">
              <strong class="history-persona">${escapeHtml(item.persona?.name || '—')}</strong>
              ${item.verdict ? `<span class="badge ${verdictBadgeClass(item.verdict)}">${escapeHtml(verdictLabel(item.verdict))}</span>` : ''}
            </div>
            <p class="muted history-item-detail">
              ${escapeHtml(item.signal_card?.signal_type || '—')} · ${escapeHtml(item.dialogue_type || '—')} · ${escapeHtml(formatDateTime(item.finished_at || item.saved_at))}
              ${item.seller_username ? ` · ${escapeHtml(item.seller_username)}` : ''}
            </p>
          </div>
          <div class="history-item-actions detail-actions">
            <button class="ghost-btn history-view-btn" data-id="${escapeHtml(sid)}">Открыть</button>
            <a class="ghost-btn" href="api/artifacts/${encodeURIComponent(sid)}/download" download="mellow-sim-${escapeHtml(sid)}.json">JSON</a>
            <a class="ghost-btn" href="api/artifacts/${encodeURIComponent(sid)}/export" download="mellow-sim-${escapeHtml(sid)}.md">MD</a>
            <button class="ghost-btn history-copy-link-btn" data-link="${escapeHtml(publicLink)}" title="Копировать ссылку">🔗</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  historyList.querySelectorAll('.history-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) historySelectedIds.add(cb.dataset.id);
      else historySelectedIds.delete(cb.dataset.id);
    });
  });

  historyList.querySelectorAll('.history-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => openSessionInRunReplay(btn.dataset.id));
  });

  historyList.querySelectorAll('.history-copy-link-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.link).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => {
        prompt('Публичная ссылка:', btn.dataset.link);
      });
    });
  });
}

async function openSessionInRunReplay(sessionId) {
  if (!sessionId) return;
  try {
    const session = await api(`api/sessions/${encodeURIComponent(sessionId)}`);
    if (!session) return;
    state.session = session;
    state.replayMode = true;
    state.fromHistory = true;
    if (session.bot_id) state.selectedPersonaId = session.bot_id;
    renderPersonaDropdown();
    renderTranscript();
    renderEndCard({ fromHistory: true });
    showPhase('run');
  } catch (err) {
    console.error('replay open failed', err);
    openHistoryView(sessionId);
  }
}

async function openHistoryView(sessionId) {
  if (!historyViewModal) return;
  historyViewTitle.textContent = 'Загрузка...';
  historyViewMeta.textContent = '';
  historyViewVerdict.innerHTML = '';
  historyViewCriteria.innerHTML = '';
  historyViewTranscript.innerHTML = '';
  historyViewModal.classList.remove('hidden');

  try {
    const resp = await fetch(`api/artifacts/${encodeURIComponent(sessionId)}/download`);
    if (!resp.ok) throw new Error('Not found');
    const art = await resp.json();

    historyViewTitle.textContent = art.persona?.name || sessionId;
    historyViewMeta.textContent = [
      formatDateTime(art.finished_at || art.saved_at),
      art.seller_username,
      art.signal_card?.signal_type,
      art.dialogue_type
    ].filter(Boolean).join(' · ');

    historyViewDownloadJson.href = `api/artifacts/${encodeURIComponent(sessionId)}/download`;
    historyViewDownloadJson.download = `mellow-sim-${sessionId}.json`;
    historyViewDownloadMd.href = `api/artifacts/${encodeURIComponent(sessionId)}/export`;
    historyViewDownloadMd.download = `mellow-sim-${sessionId}.md`;

    const v = art.assessment?.verdict;
    if (v) {
      historyViewVerdict.innerHTML = `<span class="badge ${verdictBadgeClass(v)}">${escapeHtml(verdictLabel(v))}</span>`;
    }

    const criteria = art.assessment?.criteria || [];
    historyViewCriteria.innerHTML = criteria.map((c) => `
      <div class="coaching-item">
        <div class="coaching-item-head">
          <span class="badge ${badgeClass(c.status)}">${escapeHtml(statusLabel(c.status))}</span>
          <strong>${escapeHtml(c.label || c.id)}</strong>
        </div>
        ${c.short_reason ? `<p>${escapeHtml(c.short_reason)}</p>` : ''}
      </div>
    `).join('');

    const msgs = (art.transcript || []).filter((m) => m.role !== 'system');
    historyViewTranscript.innerHTML = msgs.map((m) => {
      const cls = m.role === 'seller' ? 'bubble bubble--seller' : 'bubble bubble--bot';
      return `<div class="${escapeHtml(cls)}"><p>${escapeHtml(m.text)}</p></div>`;
    }).join('');
  } catch (err) {
    historyViewTitle.textContent = 'Ошибка загрузки';
    historyViewMeta.textContent = err.message;
  }
}

async function bulkDownload(ids) {
  try {
    const body = ids ? JSON.stringify({ ids }) : '{}';
    const resp = await fetch('api/artifacts/bulk-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      alert(j.error || 'Ошибка при скачивании');
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mellow-sim-conversations-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(err.message || 'Ошибка при скачивании');
  }
}

openHistoryBtn?.addEventListener('click', async () => {
  showPhase('history');
  await loadHistory();
});
backFromHistoryBtn?.addEventListener('click', () => showPhase(state.session ? 'run' : 'setup'));
refreshHistoryBtn?.addEventListener('click', () => loadHistory());
historySelectAllBtn?.addEventListener('click', () => {
  historyData.forEach((item) => historySelectedIds.add(item.session_id));
  renderHistoryList();
});
historyDeselectAllBtn?.addEventListener('click', () => {
  historySelectedIds.clear();
  renderHistoryList();
});
historyDownloadSelectedBtn?.addEventListener('click', () => {
  if (historySelectedIds.size === 0) { alert('Выберите хотя бы одну беседу'); return; }
  bulkDownload([...historySelectedIds]);
});
historyDownloadAllBtn?.addEventListener('click', () => bulkDownload(null));
historyViewClose?.addEventListener('click', () => historyViewModal?.classList.add('hidden'));

backToHistoryBtn?.addEventListener('click', async () => {
  showPhase('history');
  if (!historyData.length) await loadHistory();
});

runReplayBackBtn?.addEventListener('click', async () => {
  state.replayMode = false;
  state.fromHistory = false;
  showPhase('history');
  if (!historyData.length) await loadHistory();
});

downloadResultBtn?.addEventListener('click', () => {
  if (!state.session?.session_id) return;
  const a = document.createElement('a');
  a.href = `api/sessions/${state.session.session_id}/download`;
  a.download = '';
  a.click();
});

copyShareLinkBtn?.addEventListener('click', () => {
  if (!state.session?.session_id) return;
  const url = `${location.origin}/share/${state.session.session_id}`;
  navigator.clipboard.writeText(url).then(() => {
    const orig = copyShareLinkBtn.textContent;
    copyShareLinkBtn.textContent = 'Copied!';
    setTimeout(() => { copyShareLinkBtn.textContent = orig; }, 2000);
  }).catch(() => {
    prompt('Share link:', url);
  });
});

function readInitialRoute() {
  const params = new URLSearchParams(window.location.search);
  return {
    pathname: window.location.pathname,
    phase: window.location.pathname === '/analytics' ? 'analytics' : window.location.pathname === '/history' ? 'history' : window.location.pathname.startsWith('/settings') ? 'settings' : window.location.pathname.startsWith('/run') ? 'run' : window.location.pathname.startsWith('/share/') ? 'review' : 'setup',
    personaId: params.get('persona') || '',
    side: params.get('side') || 'demand',
    product: params.get('product') || 'cor',
    signalType: params.get('signalType') || 'general',
    scenarioDialogueType: params.get('scenarioDialogueType') || 'outbound',
    groupId: params.get('group') || '',
    dialogueType: params.get('dialogueType') || 'messenger',
    sessionId: params.get('session') || '',
    shareSessionId: (window.location.pathname.match(/^\/share\/([^/]+)$/) || [])[1] || ''
  };
}

// ── Randomizer settings ──────────────────────────────────────────────────────

const ALL_SIGNAL_TYPES = [
  'compliance_pressure', 'pain_signal', 'fundraising_diligence',
  'team_scaling', 'operations_overload', 'finance_control_gap',
  'legal_review_trigger', 'outside_counsel_check'
];

function loadRandomizerConfig() {
  try {
    const raw = localStorage.getItem('mellow_randomizer_config');
    if (raw) {
      Object.assign(state.randomizerConfig, JSON.parse(raw));
      // Migrate legacy UPPERCASE signal types to lowercase
      if (state.randomizerConfig.signal_types) {
        state.randomizerConfig.signal_types = state.randomizerConfig.signal_types.map(st => st.toLowerCase());
      }
    }
  } catch {}
}

function saveRandomizerConfig() {
  try {
    localStorage.setItem('mellow_randomizer_config', JSON.stringify(state.randomizerConfig));
  } catch {}
}

function syncRandomizerUI() {
  if (!randomizerPanel) return;
  const cfg = state.randomizerConfig;
  // Variability
  if (variabilitySelect) variabilitySelect.value = cfg.variability || 'medium';
  // Signal type checkboxes
  signalTypeCheckboxes().forEach((cb) => {
    cb.checked = cfg.signal_types.length === 0 || cfg.signal_types.includes(cb.value);
  });
  // Random factor
  if (randomFactorToggle) randomFactorToggle.checked = cfg.random_factor_enabled;
  if (randomFactorPanel) randomFactorPanel.classList.toggle('hidden', !cfg.random_factor_enabled);
  if (ghostProbInput) ghostProbInput.value = Math.round((cfg.ghost_probability ?? 0.15) * 100);
  if (busyProbInput) busyProbInput.value = Math.round((cfg.busy_probability ?? 0.10) * 100);
  if (deferProbInput) deferProbInput.value = Math.round((cfg.defer_probability ?? 0.10) * 100);
}

function readRandomizerUI() {
  const cfg = state.randomizerConfig;
  if (variabilitySelect) cfg.variability = variabilitySelect.value;
  const checked = signalTypeCheckboxes().filter((cb) => cb.checked).map((cb) => cb.value);
  cfg.signal_types = checked.length === ALL_SIGNAL_TYPES.length ? [] : checked;
  if (randomFactorToggle) cfg.random_factor_enabled = randomFactorToggle.checked;
  if (ghostProbInput) cfg.ghost_probability = Math.min(1, parseInt(ghostProbInput.value, 10) || 0) / 100;
  if (busyProbInput) cfg.busy_probability = Math.min(1, parseInt(busyProbInput.value, 10) || 0) / 100;
  if (deferProbInput) cfg.defer_probability = Math.min(1, parseInt(deferProbInput.value, 10) || 0) / 100;
  saveRandomizerConfig();
}

// randomizerToggle click handler removed — <details> handles toggle natively

variabilitySelect?.addEventListener('change', () => { readRandomizerUI(); });
signalTypeCheckboxes().forEach((cb) => cb.addEventListener('change', () => { readRandomizerUI(); }));

randomFactorToggle?.addEventListener('change', () => {
  readRandomizerUI();
  syncRandomizerUI();
});

[ghostProbInput, busyProbInput, deferProbInput].forEach((el) => {
  el?.addEventListener('input', readRandomizerUI);
});

// Collapsible context cards
buyerBriefCard?.addEventListener('click', () => {
  if (sellerMessages().length > 0) buyerBriefCard.classList.toggle('is-collapsed');
});
runSignalCard?.addEventListener('click', () => {
  if (sellerMessages().length > 0) runSignalCard.classList.toggle('is-collapsed');
});

// Init
const initialRoute = readInitialRoute();
state.selectedSide = initialRoute.side || 'demand';
state.selectedProduct = initialRoute.product || 'cor';
state.selectedSignalType = initialRoute.signalType || 'general';
state.selectedScenarioDialogueType = initialRoute.scenarioDialogueType || 'outbound';
state.selectedGroupId = initialRoute.groupId || '';
loadRandomizerConfig();
setDialogueType(initialRoute.dialogueType, { skipSessionRefresh: true, replaceRoute: true });
showPhase('setup', { replace: true });
updateRunState();
syncRandomizerUI();
loadVersionInfo();
updateComposerStrategyChips();
Promise.all([loadDoctrineConfig(), loadPersonas()]).then(async () => {
  settingsLayerSelect.value = state.settingsLayer;
  if (initialRoute.personaId) state.selectedPersonaId = initialRoute.personaId;
  if (initialRoute.shareSessionId) {
    try {
      const session = await api(`api/sessions/${initialRoute.shareSessionId}`);
      if (session && session.status === 'finished') {
        state.session = session;
        state.selectedPersonaId = session.bot_id || state.selectedPersonaId;
        state.replayMode = true;
        state.fromHistory = true;
        renderPersonaDropdown();
        renderTranscript();
        renderEndCard({ fromHistory: true });
        showPhase('run', { replace: true });
        return;
      }
    } catch {}
  }
  if (state.selectedPersonaId) await selectPersona(state.selectedPersonaId);
  if (initialRoute.phase === 'analytics') {
    showPhase('analytics', { replace: true });
    await loadAnalytics();
    return;
  }
  if (initialRoute.phase === 'history') {
    showPhase('history', { replace: true });
    await loadHistory();
    return;
  }
  if (initialRoute.phase === 'settings') {
    showPhase('settings', { replace: true });
    setSettingsMode(state.settingsMode);
    return;
  }
  if (initialRoute.phase === 'run' && state.session) {
    showPhase('run', { replace: true });
    renderTranscript();
    return;
  }
  showPhase('setup', { replace: true });
}).catch((error) => {
  setupPanel.innerHTML = `<p class="muted">Failed to load application: ${escapeHtml(error.message)}</p>`;
});

window.addEventListener('popstate', async () => {
  const route = readInitialRoute();
  state.selectedSide = route.side || state.selectedSide;
  state.selectedProduct = route.product || state.selectedProduct;
  state.selectedSignalType = route.signalType || state.selectedSignalType;
  state.selectedScenarioDialogueType = route.scenarioDialogueType || state.selectedScenarioDialogueType;
  state.selectedGroupId = route.groupId || state.selectedGroupId;
  if (route.dialogueType && route.dialogueType !== state.dialogueType) {
    setDialogueType(route.dialogueType, { skipSessionRefresh: true, replaceRoute: true });
  }
  if (route.shareSessionId) {
    try {
      const session = await api(`api/sessions/${route.shareSessionId}`);
      if (session && session.status === 'finished') {
        state.session = session;
        state.replayMode = true;
        state.fromHistory = true;
        renderTranscript();
        renderEndCard({ fromHistory: true });
        showPhase('run', { skipRoute: true });
        return;
      }
    } catch {}
  }
  if (route.phase === 'analytics') {
    showPhase('analytics', { skipRoute: true });
    await loadAnalytics();
    return;
  }
  if (route.phase === 'history') {
    showPhase('history', { skipRoute: true });
    await loadHistory();
    return;
  }
  if (route.phase === 'settings') {
    renderScenarioSelectors();
    renderPersonaDropdown();
    setSettingsMode(state.settingsMode);
    showPhase('settings', { skipRoute: true });
    return;
  }
  if (route.personaId && route.personaId !== state.selectedPersonaId) {
    await selectPersona(route.personaId);
  }
  showPhase(route.phase === 'run' ? 'run' : 'setup', { skipRoute: true });
});
