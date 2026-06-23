const DEFAULT_ALERT_RETENTION_MS = 10 * 60 * 1000;

const ZONE_COLORS = {
  'Champions Club': '#b8902f',
  'VIP': '#b5527e',
  'Pitchside Lounge': '#3d8a93',
  'Trophy Lounge': '#7568b0',
  'FIFA Pavilion': '#3f8c63',
};

const ZONE_DESCRIPTIONS = {
  'Champions Club': 'Asientos preferentes a pasos de los salones de hospitalidad, con servicio de bebidas premium y comida completa antes y después del partido.',
  'VIP': 'Sala VIP climatizada con bar premium y asientos preferentes en zona central.',
  'Pitchside Lounge': 'A pie de cancha: la experiencia más cercana a la acción, con servicio dedicado.',
  'Trophy Lounge': 'Hospitalidad de alto nivel junto al trofeo, con menú de autor y entretenimiento en vivo.',
  'FIFA Pavilion': 'Un retiro exclusivo en el perímetro seguro junto al estadio, con bebidas y cocina callejera gourmet antes y después del partido.',
};

function zoneColor(row) {
  const title = row.packageTitle || row.loungeId || '';
  for (const [zone, color] of Object.entries(ZONE_COLORS)) {
    if (title.toLowerCase().includes(zone.toLowerCase())) return color;
  }
  if (/champion/i.test(title)) return ZONE_COLORS['Champions Club'];
  if (/vip/i.test(title)) return ZONE_COLORS['VIP'];
  if (/pitchside/i.test(title)) return ZONE_COLORS['Pitchside Lounge'];
  if (/trophy/i.test(title)) return ZONE_COLORS['Trophy Lounge'];
  if (/pavilion|fifa\s*p/i.test(title)) return ZONE_COLORS['FIFA Pavilion'];
  return '#9a9688';
}

function zoneName(row) {
  const title = row.packageTitle || '';
  for (const zone of Object.keys(ZONE_COLORS)) {
    if (title.toLowerCase().includes(zone.toLowerCase())) return zone;
  }
  if (/champion/i.test(title)) return 'Champions Club';
  if (/vip/i.test(title)) return 'VIP';
  if (/pitchside/i.test(title)) return 'Pitchside Lounge';
  if (/trophy/i.test(title)) return 'Trophy Lounge';
  if (/pavilion/i.test(title)) return 'FIFA Pavilion';
  return title || row.loungeId || 'Boleto';
}

function availColor(quantity) {
  const n = Number(quantity || 0);
  if (n <= 0) return '#bdb8ac';
  if (n <= 2) return '#c0392b';
  return '#56544d';
}

function money(value) {
  if (value === null || value === undefined) return '-';
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(value);
}

function ticketKey(row) {
  return [row.matchCode, row.performanceId, row.loungeId, row.seatingCode, row.priceMxn].join('|');
}

function timeAgo(timestamp, now) {
  if (!timestamp) return 'Sin datos';
  const seconds = Math.max(0, Math.floor(((now || Date.now()) - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function parseMatchMetadataFromText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const dateMatch = clean.match(/\b(?:June|July)\s+\d{1,2}\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[\d:]+\s*(?:am|pm)\s*[A-Z]{2}\b/i);
  const locationText = dateMatch
    ? clean.slice(dateMatch.index + dateMatch[0].length).split(/\b(?:Starting at|Currently unavailable|Must be purchased)\b/i)[0].trim()
    : '';
  const locationMatch = locationText.match(/^(.+?),\s*(Mexico|United States|Canada)\s+(.+)$/i);
  return {
    matchDate: dateMatch?.[0] || null,
    city: locationMatch?.[1]?.trim() || null,
    country: locationMatch?.[2]?.trim() || null,
    venue: locationMatch?.[3]?.trim() || null,
  };
}

function matchSourceForRow(row, cycle) {
  return (cycle?.matches || []).find((m) => (
    m.target?.performanceId === row.performanceId
    || m.availability?.performanceId === row.performanceId
    || m.card?.matchCode === row.matchCode
  ));
}

function matchInfo(row, cycle) {
  const source = matchSourceForRow(row, cycle);
  const parsed = parseMatchMetadataFromText(source?.target?.sourceCardText || source?.card?.text);
  return {
    matchCode: row.matchCode || source?.target?.matchCode || source?.card?.matchCode || 'N/A',
    teams: row.teams || source?.target?.teams || source?.availability?.teams || 'Partido por confirmar',
    venue: row.venue || source?.target?.venue || source?.availability?.venue || parsed.venue,
    city: row.city || source?.target?.city || source?.availability?.city || parsed.city,
    country: row.country || source?.target?.country || source?.availability?.country || parsed.country,
    matchDate: row.matchDate || source?.target?.matchDate || source?.availability?.matchDate || parsed.matchDate,
  };
}

function matchLocation(row, cycle) {
  const info = matchInfo(row, cycle);
  return [info.city, info.country, info.venue, info.matchDate].filter(Boolean).join(' · ') || 'Sede pendiente';
}

function alertRetentionMs(cycle) {
  return Number(cycle?.alertRetentionMs || cycle?.state?.alertRetentionMs || DEFAULT_ALERT_RETENTION_MS);
}

function alertTimestamp(row) {
  if (row?.lastAlertAt) return row.lastAlertAt;
  if (row?.availabilityFreshness === 'new') return row.becameAvailableAt || row.lastChangedAt || row.checkedAt || null;
  if (row?.availabilityFreshness === 'increased') return row.lastChangedAt || row.checkedAt || null;
  if (['decreased', 'unavailable', 'price_changed'].includes(row?.availabilityFreshness)) return row.lastChangedAt || row.checkedAt || null;
  return null;
}

function alertReason(row) {
  const knownReasons = ['new', 'increased', 'decreased', 'unavailable', 'price_changed'];
  if (knownReasons.includes(row?.alertReason)) return row.alertReason;
  if (knownReasons.includes(row?.availabilityFreshness)) return row.availabilityFreshness;
  return null;
}

function quantityLabel(row) {
  const qty = Number(row?.availableQuantity || 0);
  if (qty === 1) return '1 disp.';
  return `${qty.toLocaleString('en-US')} disp.`;
}

function alertReasonMeta(row) {
  const reason = alertReason(row);
  const qty = quantityLabel(row);

  if (reason === 'new') {
    return { type: 'new', label: 'Nuevo', detail: `Apareció con ${qty}` };
  }

  if (reason === 'increased') {
    return { type: 'increased', label: 'Subió stock', detail: `Ahora ${qty}` };
  }

  if (reason === 'decreased') {
    return { type: 'decreased', label: 'Bajó stock', detail: `Ahora ${qty}` };
  }

  if (reason === 'unavailable') {
    return { type: 'unavailable', label: 'Sin stock', detail: 'Dejó de estar disponible' };
  }

  if (reason === 'price_changed') {
    return { type: 'price_changed', label: 'Cambió precio', detail: `Ahora ${money(row?.priceMxn)}` };
  }

  return { type: 'change', label: 'Cambio', detail: 'Cambio detectado' };
}

function isActiveAlert(row, cycle, now) {
  if (!row?.available || !alertReason(row)) return false;
  const ts = alertTimestamp(row);
  return ts && (now || Date.now()) - new Date(ts).getTime() <= alertRetentionMs(cycle);
}

function activeAlerts(cycle, now) {
  return (cycle?.alerts || [])
    .filter((row) => isActiveAlert(row, cycle, now))
    .sort((a, b) => new Date(alertTimestamp(b)).getTime() - new Date(alertTimestamp(a)).getTime());
}

function freshnessInfo(row, cycle, now) {
  if (!row.available) {
    return { text: row.checkedAt ? `Revisado ${timeAgo(row.checkedAt, now)}` : 'No disponible', type: 'none' };
  }
  if (isActiveAlert(row, cycle, now)) {
    const label = alertReasonMeta(row).label;
    return { text: `${label} hace ${timeAgo(alertTimestamp(row), now)}`, type: 'new' };
  }
  return { text: row.checkedAt ? `Revisado · ${timeAgo(row.checkedAt, now)}` : 'Disponible', type: 'rev' };
}

function expandPathToken(token) {
  if (/^W\d+$/i.test(token)) return `Ganador ${token.toUpperCase().replace('W', 'M')}`;
  if (/^L\d+$/i.test(token)) return `Perdedor ${token.toUpperCase().replace('L', 'M')}`;
  const groupSeed = token.match(/^([123])([A-Z]+)$/i);
  if (!groupSeed) return token;
  const place = { 1: '1o', 2: '2o', 3: '3o' }[groupSeed[1]];
  return `${place} Grupo ${groupSeed[2].toUpperCase().split('').join('/')}`;
}

function possibleRivalsText(teams) {
  if (!teams || !/(?:^|\s)(?:[123][A-Z]{1,6}|W\d+|L\d+)(?:\s|$)/i.test(teams)) return '';
  return teams.split(/\s+vs\s+/i).map((p) => expandPathToken(p.trim())).join(' vs ');
}

function groupRowsByMatch(rows, cycle) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.matchCode || row.performanceId || 'sin-partido';
    if (!groups.has(key)) {
      const info = matchInfo(row, cycle);
      groups.set(key, { ...info, performanceId: row.performanceId, rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => a.matchCode.localeCompare(b.matchCode, undefined, { numeric: true }));
}

function ticketSort(a, b) {
  if (a.available !== b.available) return a.available ? -1 : 1;
  return Number(a.priceMxn || 0) - Number(b.priceMxn || 0);
}

function describeEvent(event) {
  if (!event) return 'Esperando inicio';
  const labels = {
    connected: 'Dashboard conectado',
    dashboard_ticker_started: `Ticker iniciado cada ${event.intervalMs || ''} ms`,
    dashboard_ticker_stopped: 'Ticker detenido',
    dashboard_sweep_started: 'Barrido manual iniciado',
    dashboard_sweep_failed: `Barrido fallo: ${event.error || 'sin detalle'}`,
    dashboard_cycle_started: `Ciclo iniciado (${event.mode || 'modo actual'})`,
    dashboard_cycle_completed: `Ciclo terminado: ${event.availableRowCount || 0} disponibles, ${event.failedMatchCount || 0} fallos`,
    dashboard_cycle_failed: `Fallo: ${event.error || 'sin detalle'}`,
    discovery_started: 'Discovery: buscando partidos comprables',
    discovery_skipped_locked: 'Discovery: otro proceso tiene el lock',
    discovery_completed: `Discovery: ${event.cardsFound || 0} tarjetas, ${event.jobsInserted || 0} jobs nuevos`,
    discovery_failed: `Discovery fallo: ${event.error || 'sin detalle'}`,
    discovery_loop_error: `Discovery loop fallo: ${event.error || 'sin detalle'}`,
    worker_loop_error: `Worker loop fallo: ${event.error || 'sin detalle'}`,
    cycle_started: 'Nuevo ciclo: preparando coordinador',
    coordinator_started: `Coordinador: abriendo tienda ${event.country || ''}`,
    coordinator_attempt_started: `Coordinador: intento ${event.attempt || 1}/${event.attempts || 1}`,
    shop_navigation_started: 'Abriendo pagina FIFA',
    shop_document_ready: 'Documento cargado',
    country_selection_checked: `Tienda seleccionada: ${event.country || 'Mexico'}`,
    match_card_wait_started: 'Esperando tarjetas de partidos',
    match_card_wait_empty: 'Sin tarjetas todavia, buscando entrada de partidos',
    match_cards_ready: `Tarjetas listas: ${event.cardCount || 0}`,
    match_cards_missing: 'No aparecieron tarjetas de partidos',
    page_data_layer_checked: `Data layer revisada (${event.resourceUrlCount || 0} recursos)`,
    coordinator_attempt_empty: 'Intento sin partidos, reintentando',
    coordinator_completed: `Coordinador: ${event.jobsCreated || 0} jobs creados`,
    fast_cycle_started: `Poll rapido: ${event.targetCount || 0} targets`,
    fast_targets_fetch_started: `Consultando ${event.targetCount || 0} endpoints`,
    fast_target_result: `Fast ${event.matchCode || ''}: ${event.rows || 0} filas, ${event.availableRows || 0} disponibles`,
    fast_cycle_failed_fallback: `Fast poll fallo, usando discovery: ${event.error || 'sin detalle'}`,
    match_worker_started: `Worker ${event.workerIndex || ''}/${event.totalWorkers || ''} listo`,
    match_worker_failed: `Worker ${event.workerIndex || ''} fallo: ${event.error || 'sin detalle'}`,
    match_worker_finished: `Worker ${event.workerIndex || ''} cerrado`,
    match_list_return_started: 'Volviendo a la lista de partidos',
    match_list_returned: `Lista recuperada: ${event.cardCount || 0} tarjetas`,
    match_list_reload_started: 'Recargando lista de partidos',
    match_job_claimed: `Worker tomo job: ${event.matchCode || ''}`,
    match_job_stored: `Job guardado ${event.matchCode || ''}: ${event.rows || 0} filas, ${event.availableRows || 0} disponibles`,
    match_job_queued: `Job en cola: ${event.matchCode || ''}`,
    match_job_started: `Job iniciado: ${event.matchCode || ''}`,
    match_card_click_started: `Entrando al partido ${event.matchCode || ''}`,
    lounge_json_wait_started: `Esperando JSON de boletos ${event.matchCode || ''}`,
    lounge_json_captured: `JSON capturado ${event.matchCode || ''} (${event.bodyBytes || 0} bytes)`,
    match_job_finished: `Job cerrado: ${event.matchCode || ''}`,
    match_job_result: `Resultado ${event.matchCode || ''}: ${event.rows || 0} filas, ${event.availableRows || 0} disponibles`,
    cycle_completed: `Ciclo completo: ${event.matchCardsScanned || 0} partidos, ${event.failedMatchCount || 0} fallos`,
  };
  return labels[event.event] || event.event || 'Evento';
}

function computeJobs(events, job, cycle) {
  const jobs = new Map();
  const startIdx = events.findIndex((e) => e.event === 'cycle_started' || e.event === 'dashboard_cycle_started');
  const cycleEvents = job?.running && startIdx >= 0 ? events.slice(0, startIdx + 1) : events;

  if (!job?.running) {
    for (const match of cycle?.matches || []) {
      const mc = match.card?.matchCode || match.availability?.matchCode || 'N/A';
      jobs.set(mc, {
        matchCode: mc,
        status: match.ok ? 'Terminado' : 'Error',
        rows: match.availability?.rowCount ?? 0,
        availableRows: match.availability?.availableRows?.length ?? 0,
        error: match.error || '',
      });
    }
  }

  for (const event of [...cycleEvents].reverse()) {
    if (!event.matchCode) continue;
    const cur = jobs.get(event.matchCode) || { matchCode: event.matchCode, rows: null, availableRows: null, error: '' };
    if (event.event === 'match_job_queued') cur.status = `En cola ${event.index || ''}/${event.total || ''}`.trim();
    if (event.event === 'match_job_started') cur.status = 'Ejecutando';
    if (event.event === 'match_card_click_started') cur.status = 'Abriendo partido';
    if (event.event === 'lounge_json_wait_started') cur.status = 'Esperando boletos';
    if (event.event === 'lounge_json_captured') { cur.status = 'JSON capturado'; cur.bodyBytes = event.bodyBytes; }
    if (event.event === 'match_job_result') {
      cur.status = event.ok ? 'Terminado' : 'Error';
      cur.rows = event.rows ?? cur.rows;
      cur.availableRows = event.availableRows ?? cur.availableRows;
      cur.error = event.error || cur.error || '';
    }
    if (event.event === 'match_job_finished' && !['Terminado', 'Error'].includes(cur.status)) cur.status = 'Cerrado';
    jobs.set(event.matchCode, cur);
  }

  return [...jobs.values()].sort((a, b) => a.matchCode.localeCompare(b.matchCode, undefined, { numeric: true }));
}

async function postJson(path, body = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const p = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) {
    throw new Error(p.error || `Request failed: ${r.status}`);
  }
  return p;
}

async function deleteJson(path) {
  const r = await fetch(path, { method: 'DELETE' });
  const p = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p.error || `Request failed: ${r.status}`);
  return p;
}

function alertRuleConditionOptions(row) {
  if (!row?.available) {
    return [
      { value: 'becomes_available', label: 'Cuando esté disponible' },
      { value: 'any_change', label: 'Cualquier cambio' },
    ];
  }

  return [
    { value: 'stock_increase', label: 'Si sube stock' },
    { value: 'stock_change', label: 'Si cambia stock' },
    { value: 'price_change', label: 'Si cambia precio' },
    { value: 'any_change', label: 'Cualquier cambio' },
  ];
}

function alertRuleConditionLabel(condition) {
  return {
    becomes_available: 'Cuando esté disponible',
    stock_increase: 'Si sube stock',
    stock_change: 'Si cambia stock',
    price_change: 'Si cambia precio',
    any_change: 'Cualquier cambio',
  }[condition] || condition || 'Alerta';
}

function suggestedAlertCondition(row) {
  return row?.available ? 'stock_increase' : 'becomes_available';
}

document.addEventListener('alpine:init', () => {
  Alpine.data('tracker', () => ({
    latestCycle: null,
    job: null,
    events: [],
    filter: 'available',
    now: Date.now(),
    selectedRow: null,
    selectedKey: null,
    drawerType: null,
    drawerMatchCode: null,
    systemOpen: false,
    queue: null,
    notifications: null,
    alertRules: [],
    alertCondition: 'becomes_available',
    alertRuleSaving: false,
    alertRuleError: '',
    alertRuleSavedAt: null,
    pulseMatches: {},
    collapsed: {},
    isAdmin: location.pathname.replace(/\/$/, '').endsWith('/admin') || new URLSearchParams(location.search).has('admin'),
    visitorCountry: 'Mexico',
    matchConcurrency: 6,
    intervalMs: 60000,

    init() {
      this.refresh();
      setInterval(() => this.now = Date.now(), 1000);
      setInterval(() => this.refresh(), 10000);

      const sse = new EventSource('/events');
      sse.onmessage = (msg) => {
        const event = JSON.parse(msg.data);
        this.events = [event, ...this.events].slice(0, 140);

        if (event.matchCode) {
          if (['match_job_started', 'match_job_claimed', 'lounge_json_wait_started'].includes(event.event)) {
            this.pulseMatches = { ...this.pulseMatches, [event.matchCode]: this.now };
          }
          if (event.event === 'match_job_result' || event.event === 'match_job_stored') {
            const pm = { ...this.pulseMatches };
            delete pm[event.matchCode];
            this.pulseMatches = pm;
          }
        }

        if (['dashboard_cycle_completed', 'dashboard_cycle_failed', 'cycle_completed'].includes(event.event)) {
          this.pulseMatches = {};
          this.refresh();
        }
      };

      document.body.classList.toggle('admin-mode', this.isAdmin);
      document.body.classList.toggle('public-mode', !this.isAdmin);
    },

    async refresh() {
      const [stateResponse, rulesResponse] = await Promise.all([
        fetch('/api/state'),
        fetch('/api/alert-rules').catch(() => null),
      ]);
      const p = await stateResponse.json();
      this.latestCycle = p.latestCycle;
      this.job = p.job;
      this.queue = p.queue || null;
      this.notifications = p.notifications || null;
      if (p.job?.events?.length) this.events = p.job.events;

      if (rulesResponse?.ok) {
        const rulesPayload = await rulesResponse.json();
        this.alertRules = rulesPayload.rules || [];
      }
    },

    requestBody() {
      return { visitorCountry: this.visitorCountry, matchConcurrency: Number(this.matchConcurrency || 1), intervalMs: Number(this.intervalMs || 60000) };
    },

    async startTicker() {
      try { await postJson('/api/start-ticker', this.requestBody()); await this.refresh(); }
      catch (e) { this.events = [{ event: 'dashboard_cycle_failed', error: e.message, emittedAt: new Date().toISOString() }, ...this.events]; }
    },

    async stopTicker() { await postJson('/api/stop-ticker'); await this.refresh(); },

    async runCycle() {
      try { await postJson('/api/run-cycle', this.requestBody()); await this.refresh(); }
      catch (e) { this.events = [{ event: 'dashboard_cycle_failed', error: e.message, emittedAt: new Date().toISOString() }, ...this.events]; }
    },

    // --- Status ---
    get statusClass() {
      if (this.job?.lastError) return 'error';
      if (this.job?.running) return 'live';
      if (this.job?.tickerRunning) return 'live';
      return 'idle';
    },
    get statusLabel() {
      if (this.job?.lastError) return 'Error';
      if (this.job?.running) return describeEvent(this.job?.lastEvent) || 'Ejecutando';
      if (this.job?.tickerRunning) return `En vivo · ${this.latestCycle?.visitorCountry || this.visitorCountry}`;
      return 'En espera';
    },
    get showStartBtn() { return this.isAdmin && !this.job?.tickerRunning; },
    get showStopBtn() { return this.isAdmin && this.job?.tickerRunning; },
    get cycleDisabled() { return Boolean(this.job?.running); },

    // --- Metrics ---
    get freshness() { return timeAgo(this.latestCycle?.cycleCompletedAt, this.now); },
    get freshnessClass() {
      const ts = this.latestCycle?.cycleCompletedAt;
      if (!ts) return '';
      const age = this.now - new Date(ts).getTime();
      if (age > 4 * 60 * 1000) return 'stat-value--critical';
      if (age > 2 * 60 * 1000) return 'stat-value--stale';
      return 'stat-value--green';
    },
    isScanning(matchCode) { return Boolean(this.pulseMatches[matchCode]); },
    matchHasAlerts(matchCode) { return this.alerts.some((r) => r.matchCode === matchCode); },
    isRowAlert(row) { return isActiveAlert(row, this.latestCycle, this.now); },
    get matchesFound() { return this.latestCycle?.matchCardsFound ?? 0; },
    get matchesScanned() { return this.latestCycle?.matchCardsScanned ?? 0; },
    get rowCount() { return this.latestCycle?.rowCount ?? 0; },
    get availableCount() { return this.latestCycle?.availableRowCount ?? 0; },
    get lastUpdated() {
      return this.latestCycle?.cycleCompletedAt ? new Date(this.latestCycle.cycleCompletedAt).toLocaleString() : 'Sin ciclos aún';
    },
    get shopLabel() { return this.latestCycle?.visitorCountry || this.visitorCountry; },

    // --- Alerts ---
    get alerts() { return activeAlerts(this.latestCycle, this.now).slice(0, 8); },
    get alertCount() { return activeAlerts(this.latestCycle, this.now).length; },
    get retentionMin() { return Math.round(alertRetentionMs(this.latestCycle) / 60000); },
    alertZoneColor(row) { return zoneColor(row); },
    alertTeams(row) { return matchInfo(row, this.latestCycle).teams; },
    alertSub(row) {
      const zone = zoneName(row);
      const seat = row.seatingName || row.seatingCode || '';
      if (!seat || seat === zone) return zone;
      return `${zone} · ${seat}`;
    },
    alertQty(row) { return Number(row.availableQuantity || 0); },
    alertPlaceLine(row) {
      const zone = zoneName(row);
      const seat = row.seatingName || row.seatingCode || '';
      if (!seat || seat === zone) return zone;
      return `${zone} · ${seat}`;
    },
    alertReasonType(row) { return alertReasonMeta(row).type; },
    alertReasonLabel(row) { return alertReasonMeta(row).label; },
    alertReasonDetail(row) { return alertReasonMeta(row).detail; },

    // --- Filters & Matches ---
    setFilter(f) { this.filter = f; this.closeDetail(); },

    get filteredRows() {
      const rows = this.latestCycle?.rows || [];
      if (this.filter === 'available') return rows.filter((r) => r.available);
      if (this.filter === 'unavailable') return rows.filter((r) => !r.available);
      return rows;
    },

    get matches() {
      return groupRowsByMatch(this.filteredRows, this.latestCycle);
    },

    matchMeta(m) {
      const loc = matchLocation({ matchCode: m.matchCode, ...m }, this.latestCycle);
      const rivals = possibleRivalsText(m.teams);
      return loc + (rivals ? ` · ${rivals}` : '');
    },

    matchAvailLabel(m) {
      const all = (this.latestCycle?.rows || []).filter((r) => r.matchCode === m.matchCode);
      const avail = all.filter((r) => r.available).length;
      return `${avail}/${all.length} configs`;
    },

    matchAvailQty(m) {
      const all = (this.latestCycle?.rows || []).filter((r) => r.matchCode === m.matchCode);
      return all.reduce((s, r) => s + Number(r.availableQuantity || 0), 0);
    },

    sortedTickets(m) {
      const sorted = [...m.rows].sort(ticketSort);
      const maxAvail = Math.max(1, ...sorted.map((r) => Number(r.availableQuantity || 0)));
      sorted.forEach((r, i) => {
        const q = Number(r.availableQuantity || 0);
        r._pct = Math.max(8, Math.round(q / maxAvail * 100));
        r._barColor = q <= 0 ? '#d8d4ca' : q <= 2 ? '#c0392b' : '#b3afa2';
        r._rowBg = i % 2 ? '#ffffff' : '#faf9f5';
      });
      return sorted;
    },

    isOpen(matchCode) { return !this.collapsed[matchCode]; },
    toggleMatch(matchCode) { this.collapsed = { ...this.collapsed, [matchCode]: !this.collapsed[matchCode] }; },
    get anyOpen() { return this.matches.some((m) => this.isOpen(m.matchCode)); },
    get toggleAllLabel() { return this.anyOpen ? 'Colapsar' : 'Expandir'; },
    toggleAll() {
      const nv = {};
      if (this.anyOpen) this.matches.forEach((m) => nv[m.matchCode] = true);
      this.collapsed = nv;
    },
    chevronStyle(matchCode) { return this.isOpen(matchCode) ? 'rotate(0deg)' : 'rotate(-90deg)'; },
    headBorder(matchCode) { return this.isOpen(matchCode) ? '#e3e0d6' : 'transparent'; },

    // --- Ticket helpers ---
    tZoneColor(row) { return zoneColor(row); },
    tZoneName(row) { return zoneName(row); },
    tSub(row) { return row.seatingName || row.seatingCode || 'Configuración'; },
    tQty(row) { return Number(row.availableQuantity || 0); },
    tAvailColor(row) { return availColor(this.tQty(row)); },
    tAvailLabel(row) { return row.available ? `${this.tQty(row)} disp.` : 'No disponible'; },
    tFreshness(row) { return freshnessInfo(row, this.latestCycle, this.now); },
    tKey(row) { return ticketKey(row); },
    tSelected(row) { return this.selectedKey === ticketKey(row); },

    // --- Detail Drawer ---
    selectTicket(row) {
      this.selectedRow = row;
      this.selectedKey = ticketKey(row);
      this.drawerType = 'ticket';
      this.drawerMatchCode = null;
      this.alertCondition = suggestedAlertCondition(row);
      this.alertRuleError = '';
      this.alertRuleSavedAt = null;
    },

    openMatchInfo(matchCode) {
      this.drawerType = 'match';
      this.drawerMatchCode = matchCode;
      this.selectedRow = null;
      this.selectedKey = null;
    },

    closeDetail() {
      this.selectedRow = null;
      this.selectedKey = null;
      this.drawerType = null;
      this.drawerMatchCode = null;
    },

    get detailOpen() { return this.drawerType !== null; },
    get detailIsTicket() { return this.drawerType === 'ticket' && this.selectedRow; },
    get detailIsMatch() { return this.drawerType === 'match' && this.drawerMatchCode; },
    get detailTitle() { return this.detailIsMatch ? 'INFORMACIÓN DEL PARTIDO' : 'DETALLE DEL BOLETO'; },

    // Ticket detail computed
    get dRow() { return this.selectedRow; },
    get dInfo() { return this.dRow ? matchInfo(this.dRow, this.latestCycle) : {}; },
    get dColor() { return this.dRow ? zoneColor(this.dRow) : '#999'; },
    get dZone() { return this.dRow ? zoneName(this.dRow) : ''; },
    get dSub() { return this.dRow ? (this.dRow.seatingName || this.dRow.seatingCode || 'Configuración') : ''; },
    get dQty() { return this.dRow ? Number(this.dRow.availableQuantity || 0) : 0; },
    get dFreshness() { return this.dRow ? freshnessInfo(this.dRow, this.latestCycle, this.now) : { type: 'none', text: '' }; },
    get dCheckedLabel() { return this.dRow?.checkedAt ? `Revisado hace ${timeAgo(this.dRow.checkedAt, this.now)}` : 'Sin revisión reciente'; },
    get dBuyUrl() { return this.dRow?.fifaShopUrl || this.latestCycle?.shopUrl || '#'; },
    get dStatusLabel() {
      if (!this.dRow) return '';
      if (this.dFreshness.type === 'new') return alertReasonMeta(this.dRow).label;
      if (!this.dRow.available) return 'No disponible';
      return 'Revisado';
    },
    get dReasonDetail() { return this.dFreshness.type === 'new' ? alertReasonMeta(this.dRow).detail : ''; },
    get dStatusColor() {
      if (!this.dRow) return '#999';
      if (!this.dRow.available) return '#9a9688';
      return '#56544d';
    },
    get dStatusBg() {
      if (!this.dRow) return '#f1efe8';
      if (this.dFreshness.type === 'new') return '#f1efe8';
      return '#f3f1ea';
    },
    get dFields() {
      if (!this.dRow) return [];
      return [
        { k: 'Asiento', v: this.dSub },
        { k: 'Código de asiento', v: this.dRow.seatingCode },
        { k: 'Tipo', v: this.dZone },
        { k: 'Clase', v: this.dRow.packageClass || this.dRow.packageShortTitle || '' },
        { k: 'Precio base', v: `Desde ${money(this.dRow.priceMxn)} MXN / persona` },
        { k: 'Performance ID', v: this.dRow.performanceId },
        { k: 'SeatCategory ID', v: this.dRow.rawSeatingSection?.SeatCategoryId },
        { k: 'AudienceSub ID', v: this.dRow.rawSeatingSection?.AudienceSubCategoryId },
      ].filter((f) => f.v);
    },
    get dDesc() { return this.dRow?.rawTicketType?.description || ZONE_DESCRIPTIONS[this.dZone] || ''; },
    get dDetails() { return Array.isArray(this.dRow?.rawTicketType?.details) ? this.dRow.rawTicketType.details : []; },
    get dAlertRules() {
      if (!this.dRow) return [];
      const key = ticketKey(this.dRow);
      return this.alertRules.filter((rule) => rule.rowKey === key);
    },
    get dHasAlertRule() { return this.dAlertRules.length > 0; },
    get dPrimaryAlertRule() { return this.dAlertRules[0] || null; },
    get dAlertOptions() { return alertRuleConditionOptions(this.dRow); },
    get dAlertSummary() {
      if (this.dHasAlertRule) return alertRuleConditionLabel(this.dPrimaryAlertRule.condition);
      return this.dRow?.available ? 'Te aviso si cambia y aviso al grupo.' : 'Te aviso en cuanto aparezca y aviso al grupo.';
    },
    get dAlertSavedText() {
      if (!this.alertRuleSavedAt) return '';
      return `Guardado hace ${timeAgo(this.alertRuleSavedAt, this.now)}`;
    },
    conditionLabel(condition) { return alertRuleConditionLabel(condition); },
    alertRulePayload() {
      const row = this.dRow;
      const info = this.dInfo || {};
      return {
        row,
        rowKey: ticketKey(row),
        matchCode: row.matchCode,
        performanceId: row.performanceId,
        loungeId: row.loungeId,
        seatingCode: row.seatingCode,
        packageTitle: row.packageTitle,
        seatingName: row.seatingName,
        condition: this.alertCondition,
        label: [info.matchCode, info.teams, zoneName(row), row.seatingName || row.seatingCode].filter(Boolean).join(' · '),
      };
    },
    async createTicketAlertRule() {
      if (!this.dRow || this.alertRuleSaving) return;
      this.alertRuleSaving = true;
      this.alertRuleError = '';
      try {
        const payload = await postJson('/api/alert-rules', this.alertRulePayload());
        const rule = payload.rule;
        this.alertRules = [rule, ...this.alertRules.filter((r) => !(r.id === rule.id || (r.rowKey === rule.rowKey && r.condition === rule.condition)))];
        this.alertRuleSavedAt = new Date().toISOString();
      } catch (error) {
        this.alertRuleError = error.message;
      } finally {
        this.alertRuleSaving = false;
      }
    },
    async deleteTicketAlertRule(rule) {
      if (!rule || this.alertRuleSaving) return;
      this.alertRuleSaving = true;
      this.alertRuleError = '';
      try {
        await deleteJson(`/api/alert-rules/${rule.id}`);
        this.alertRules = this.alertRules.filter((r) => r.id !== rule.id);
        this.alertRuleSavedAt = null;
      } catch (error) {
        this.alertRuleError = error.message;
      } finally {
        this.alertRuleSaving = false;
      }
    },

    // Match detail computed
    get dmRows() {
      if (!this.drawerMatchCode) return [];
      return (this.latestCycle?.rows || []).filter((r) => r.matchCode === this.drawerMatchCode);
    },
    get dmInfo() { return this.dmRows.length ? matchInfo(this.dmRows[0], this.latestCycle) : {}; },
    get dmMeta() { return this.dmRows.length ? matchLocation(this.dmRows[0], this.latestCycle) : ''; },
    get dmAvailRows() { return this.dmRows.filter((r) => r.available); },
    get dmAvailQty() { return this.dmAvailRows.reduce((s, r) => s + Number(r.availableQuantity || 0), 0); },
    get dmZones() {
      const map = {};
      for (const row of this.dmAvailRows) {
        const z = zoneName(row);
        const c = zoneColor(row);
        const p = Number(row.priceMxn || 0);
        const q = Number(row.availableQuantity || 0);
        if (!map[z]) map[z] = { name: z, color: c, count: 0, configs: 0, min: Infinity };
        map[z].count += q;
        map[z].configs += 1;
        map[z].min = Math.min(map[z].min, p);
      }
      return Object.values(map);
    },

    // --- System drawer ---
    get jobs() { return computeJobs(this.events, this.job, this.latestCycle); },
    get visibleEvents() { return this.events.slice(0, 120); },
    get cycleOutput() {
      const c = this.latestCycle;
      if (!c) return '{}';
      return JSON.stringify({
        cicloInicio: c.cycleStartedAt, cicloFin: c.cycleCompletedAt,
        modo: c.mode || 'browser-discovery', tienda: c.visitorCountry,
        partidosDetectados: c.matchCardsFound, partidosRevisados: c.matchCardsScanned,
        partidosFallidos: c.failedMatchCount || 0, parcial: Boolean(c.partial),
        trabajosParalelos: c.matchConcurrency, tiposDeBoleto: c.rowCount,
        disponibles: c.availableRowCount, alertasActivas: this.alertCount,
        retencionAlertasMs: c.alertRetentionMs || DEFAULT_ALERT_RETENTION_MS,
        telegramListo: Boolean(this.notifications?.telegramReady),
        notificacionesTelegram: this.notifications?.telegram || {},
        reglasActivas: this.alertRules.length,
      }, null, 2);
    },

    // --- Template helpers ---
    money(v) { return money(v); },
    availColor(q) { return availColor(q); },
    timeAgo(ts) { return timeAgo(ts, this.now); },
    describeEvent(e) { return describeEvent(e); },
    eventTime(e) { return new Date(e.emittedAt || Date.now()).toLocaleTimeString(); },
  }));
});
