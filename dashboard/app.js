const state = {
  latestCycle: null,
  job: null,
  selectedRow: null,
  selectedKey: null,
  drawerType: null,
  drawerMatchCode: null,
  filter: 'available',
  isAdmin: location.pathname.replace(/\/$/, '').endsWith('/admin') || new URLSearchParams(location.search).has('admin'),
  events: [],
};

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

const els = {
  statusPill: document.getElementById('statusPill'),
  statusText: document.getElementById('statusText'),
  freshnessText: document.getElementById('freshnessText'),
  shopContextLabel: document.getElementById('shopContextLabel'),
  countryInput: document.getElementById('countryInput'),
  concurrencyInput: document.getElementById('concurrencyInput'),
  intervalInput: document.getElementById('intervalInput'),
  runCycleButton: document.getElementById('runCycleButton'),
  startTickerButton: document.getElementById('startTickerButton'),
  stopTickerButton: document.getElementById('stopTickerButton'),
  drawerButton: document.getElementById('drawerButton'),
  closeDrawerButton: document.getElementById('closeDrawerButton'),
  drawer: document.getElementById('systemDrawer'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  matchesFound: document.getElementById('matchesFound'),
  matchesScanned: document.getElementById('matchesScanned'),
  rowCount: document.getElementById('rowCount'),
  availableCount: document.getElementById('availableCount'),
  alertCount: document.getElementById('alertCount'),
  lastUpdated: document.getElementById('lastUpdated'),
  alertPanel: document.getElementById('alertPanel'),
  gameBoard: document.getElementById('gameBoard'),
  availabilityFilter: document.getElementById('availabilityFilter'),
  ticketDetail: document.getElementById('ticketDetail'),
  ticketBackdrop: document.getElementById('ticketBackdrop'),
  detailTitle: document.getElementById('detailTitle'),
  detailBody: document.getElementById('detailBody'),
  closeDetailButton: document.getElementById('closeDetailButton'),
  cycleOutput: document.getElementById('cycleOutput'),
  eventLog: document.getElementById('eventLog'),
  jobBoard: document.getElementById('jobBoard'),
};

function requestBody() {
  return {
    visitorCountry: els.countryInput.value || 'Mexico',
    matchConcurrency: Number(els.concurrencyInput.value || 1),
    intervalMs: Number(els.intervalInput.value || 60000),
  };
}

async function postJson(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok && response.status !== 202) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
}

function zoneColor(row) {
  const title = row.packageTitle || row.loungeId || '';
  for (const [zone, color] of Object.entries(ZONE_COLORS)) {
    if (title.toLowerCase().includes(zone.toLowerCase())) {
      return color;
    }
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
    if (title.toLowerCase().includes(zone.toLowerCase())) {
      return zone;
    }
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

function describeEvent(event) {
  if (!event) {
    return 'Esperando inicio';
  }

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

function setStatus(job) {
  els.statusPill.className = 'status-pill idle';
  els.statusText.textContent = 'En espera';
  els.startTickerButton.hidden = !state.isAdmin || Boolean(job?.tickerRunning);
  els.stopTickerButton.hidden = !state.isAdmin || !job?.tickerRunning;
  els.runCycleButton.disabled = Boolean(job?.running);
  els.startTickerButton.disabled = Boolean(job?.running);

  if (job?.lastError) {
    els.statusPill.className = 'status-pill error';
    els.statusText.textContent = 'Error';
  } else if (job?.running) {
    els.statusPill.className = 'status-pill live';
    els.statusText.textContent = describeEvent(job?.lastEvent) || 'Ejecutando';
  } else if (job?.tickerRunning) {
    els.statusPill.className = 'status-pill live';
    const country = state.latestCycle?.visitorCountry || els.countryInput.value || 'México';
    els.statusText.textContent = `En vivo · ${country}`;
  }
}

function money(value) {
  if (value === null || value === undefined) {
    return '-';
  }

  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  }).format(value);
}

function ticketKey(row) {
  return [
    row.matchCode,
    row.performanceId,
    row.loungeId,
    row.seatingCode,
    row.priceMxn,
  ].join('|');
}

function syncSelectedRow() {
  if (!state.selectedKey) {
    state.selectedRow = null;
    return;
  }

  const currentRows = rowsForDisplay();
  state.selectedRow = currentRows.find((row) => ticketKey(row) === state.selectedKey) || null;

  if (!state.selectedRow) {
    state.selectedKey = null;
  }
}

function timeAgo(timestamp) {
  if (!timestamp) {
    return 'Sin datos';
  }

  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

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

function matchSourceForRow(row) {
  return (state.latestCycle?.matches || []).find((match) => (
    match.target?.performanceId === row.performanceId
      || match.availability?.performanceId === row.performanceId
      || match.card?.matchCode === row.matchCode
  ));
}

function matchInfo(row) {
  const source = matchSourceForRow(row);
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

function matchTitle(row) {
  return matchInfo(row).teams || 'Partido por confirmar';
}

function matchLocation(row) {
  const info = matchInfo(row);
  const location = [info.city, info.country, info.venue, info.matchDate].filter(Boolean).join(' · ');
  return location || 'Sede pendiente';
}

function alertRetentionMs(cycle = state.latestCycle) {
  return Number(cycle?.alertRetentionMs || cycle?.state?.alertRetentionMs || DEFAULT_ALERT_RETENTION_MS);
}

function alertTimestamp(row) {
  if (row?.lastAlertAt) {
    return row.lastAlertAt;
  }

  if (row?.availabilityFreshness === 'new') {
    return row.becameAvailableAt || row.lastChangedAt || row.checkedAt || null;
  }

  if (row?.availabilityFreshness === 'increased') {
    return row.lastChangedAt || row.checkedAt || null;
  }

  return null;
}

function alertReason(row) {
  if (['new', 'increased'].includes(row?.alertReason)) {
    return row.alertReason;
  }

  if (['new', 'increased'].includes(row?.availabilityFreshness)) {
    return row.availabilityFreshness;
  }

  return null;
}

function isActiveAlert(row, cycle = state.latestCycle) {
  if (!row?.available || !alertReason(row)) {
    return false;
  }

  const timestamp = alertTimestamp(row);
  return timestamp && Date.now() - new Date(timestamp).getTime() <= alertRetentionMs(cycle);
}

function activeAlerts(cycle) {
  return (cycle?.alerts || [])
    .filter((row) => isActiveAlert(row, cycle))
    .sort((a, b) => new Date(alertTimestamp(b)).getTime() - new Date(alertTimestamp(a)).getTime());
}

function availabilityFreshness(row) {
  if (!row.available) {
    return { text: row.checkedAt ? `Revisado ${timeAgo(row.checkedAt)}` : 'No disponible', type: 'none' };
  }

  if (isActiveAlert(row)) {
    const label = alertReason(row) === 'increased' ? 'Más stock' : 'Nuevo';
    return { text: `${label} · ${timeAgo(alertTimestamp(row))}`, type: 'new' };
  }

  return { text: row.checkedAt ? `Revisado · ${timeAgo(row.checkedAt)}` : 'Disponible', type: 'rev' };
}

function expandPathToken(token) {
  if (/^W\d+$/i.test(token)) {
    return `Ganador ${token.toUpperCase().replace('W', 'M')}`;
  }

  if (/^L\d+$/i.test(token)) {
    return `Perdedor ${token.toUpperCase().replace('L', 'M')}`;
  }

  const groupSeed = token.match(/^([123])([A-Z]+)$/i);

  if (!groupSeed) {
    return token;
  }

  const place = { 1: '1o', 2: '2o', 3: '3o' }[groupSeed[1]];
  return `${place} Grupo ${groupSeed[2].toUpperCase().split('').join('/')}`;
}

function possibleRivalsText(teams) {
  if (!teams || !/(?:^|\s)(?:[123][A-Z]{1,6}|W\d+|L\d+)(?:\s|$)/i.test(teams)) {
    return '';
  }

  return teams
    .split(/\s+vs\s+/i)
    .map((part) => expandPathToken(part.trim()))
    .join(' vs ');
}

function rowsForDisplay() {
  const rows = state.latestCycle?.rows || [];
  const filter = state.filter;

  return rows.filter((row) => {
    if (filter === 'available') {
      return row.available;
    }

    if (filter === 'unavailable') {
      return !row.available;
    }

    return true;
  });
}

function groupRowsByMatch(rows) {
  const groups = new Map();

  for (const row of rows) {
    const key = row.matchCode || row.performanceId || 'sin-partido';

    if (!groups.has(key)) {
      const info = matchInfo(row);
      groups.set(key, {
        matchCode: info.matchCode,
        teams: info.teams,
        venue: info.venue,
        city: info.city,
        country: info.country,
        matchDate: info.matchDate,
        performanceId: row.performanceId,
        rows: [],
      });
    }

    groups.get(key).rows.push(row);
  }

  return [...groups.values()].sort((a, b) => a.matchCode.localeCompare(b.matchCode, undefined, { numeric: true }));
}

function ticketSort(a, b) {
  if (a.available !== b.available) {
    return a.available ? -1 : 1;
  }

  if (Number(a.availableQuantity || 0) !== Number(b.availableQuantity || 0)) {
    return Number(b.availableQuantity || 0) - Number(a.availableQuantity || 0);
  }

  return Number(a.priceMxn || 0) - Number(b.priceMxn || 0);
}

function renderMetrics(cycle) {
  const alerts = activeAlerts(cycle);
  els.matchesFound.textContent = cycle?.matchCardsFound ?? 0;
  els.matchesScanned.textContent = cycle?.matchCardsScanned ?? 0;
  els.rowCount.textContent = cycle?.rowCount ?? 0;
  els.availableCount.textContent = cycle?.availableRowCount ?? 0;
  els.alertCount.textContent = alerts.length;
  els.lastUpdated.textContent = cycle?.cycleCompletedAt
    ? new Date(cycle.cycleCompletedAt).toLocaleString()
    : 'Sin ciclos aún';
  els.freshnessText.textContent = timeAgo(cycle?.cycleCompletedAt);
  els.shopContextLabel.textContent = cycle?.visitorCountry || els.countryInput.value || 'Mexico';
}

function renderAlerts(cycle) {
  const alerts = activeAlerts(cycle);

  if (alerts.length === 0) {
    els.alertPanel.hidden = true;
    els.alertPanel.innerHTML = '';
    return;
  }

  els.alertPanel.hidden = false;

  const retMin = Math.round(alertRetentionMs(cycle) / 60000);
  els.alertPanel.innerHTML = `
    <div class="alert-summary alert-summary-desktop">
      <div class="alert-summary-count">
        <span style="width:9px;height:9px;border-radius:50%;background:#c8820a;flex:none"></span>
        <strong>${alerts.length}</strong>
        <span>ALERTAS<br>NUEVAS</span>
      </div>
      <p>Boletos que aparecieron o subieron stock en los últimos ${retMin} minutos.</p>
    </div>
    <div class="alert-summary-mobile">
      <span style="width:7px;height:7px;border-radius:50%;background:#c8820a;flex:none"></span>
      <span class="alert-mobile-count">${alerts.length} alertas nuevas</span>
      <span class="alert-mobile-sub">aparecieron o subieron stock</span>
    </div>
    <div class="alert-grid"></div>
  `;

  const grid = els.alertPanel.querySelector('.alert-grid');

  for (const row of alerts.slice(0, 8)) {
    const color = zoneColor(row);
    const zone = zoneName(row);
    const teams = matchTitle(row);
    const sub = zone + (row.seatingName ? ` · ${row.seatingName}` : '');
    const qty = Number(row.availableQuantity || 0);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'alert-card';
    button.innerHTML = `
      <div class="alert-card-head">
        <span class="zone-dot" style="background:${color}"></span>
        <span class="alert-card-code">${row.matchCode || 'N/A'}</span>
        <span class="alert-card-zone">${teams}</span>
      </div>
      <div class="alert-card-sub">${sub}</div>
      <div class="alert-card-foot">
        <span class="alert-card-price">${money(row.priceMxn)}</span>
        <span class="alert-card-avail" style="color:${availColor(qty)}">${qty} disp.</span>
      </div>
    `;
    button.addEventListener('click', () => {
      state.selectedKey = ticketKey(row);
      state.selectedRow = row;
      state.drawerType = 'ticket';
      renderTicketDetail();
      renderGameBoard();
    });
    grid.appendChild(button);
  }
}

function renderGameBoard() {
  const rows = rowsForDisplay();
  const matches = groupRowsByMatch(rows);
  els.gameBoard.innerHTML = '';

  if (matches.length === 0) {
    const empty = document.createElement('section');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <h2>No hay boletos para mostrar</h2>
      <p>El último ciclo no encontró boletos con el filtro actual. Cambia el filtro o espera el siguiente ciclo.</p>
    `;
    els.gameBoard.appendChild(empty);
    return;
  }

  const allRows = state.latestCycle?.rows || [];

  for (const match of matches) {
    const matchAllRows = allRows.filter((r) => r.matchCode === match.matchCode);
    const availableInMatch = matchAllRows.filter((r) => r.available).length;
    const totalInMatch = matchAllRows.length;
    const totalQuantity = match.rows.reduce((sum, r) => sum + Number(r.availableQuantity || 0), 0);
    const meta = matchLocation({ matchCode: match.matchCode, ...match });
    const possibleRivals = possibleRivalsText(match.teams);

    const card = document.createElement('article');
    card.className = 'match-card';
    card.innerHTML = `
      <div class="match-head">
        <div class="match-head-left">
          <span class="match-pill">${match.matchCode}</span>
          <div style="min-width:0">
            <div class="match-title">${match.teams}</div>
            <div class="match-meta">${meta}${possibleRivals ? ` · ${possibleRivals}` : ''}</div>
          </div>
        </div>
        <div class="match-head-right">
          <button type="button" class="match-info-link" data-match-info="${match.matchCode}">Info →</button>
          <span class="match-avail-badge">${availableInMatch}/${totalInMatch} disp.</span>
          <div class="match-detected">
            <strong>${totalQuantity.toLocaleString('en-US')}</strong>
            <small>DETECTADOS</small>
          </div>
        </div>
      </div>
    `;

    if (match.rows.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'match-empty';
      emptyDiv.textContent = 'Sin boletos en este filtro.';
      card.appendChild(emptyDiv);
    } else {
      const grid = document.createElement('div');
      grid.className = 'ticket-grid';

      for (const row of [...match.rows].sort(ticketSort)) {
        const key = ticketKey(row);
        const color = zoneColor(row);
        const zone = zoneName(row);
        const sub = row.seatingName || row.seatingCode || 'Configuración';
        const qty = Number(row.availableQuantity || 0);
        const freshness = availabilityFreshness(row);

        let freshnessHtml = '';
        if (freshness.type === 'new') {
          freshnessHtml = `<span class="fresh-tag-new"><span style="width:6px;height:6px;border-radius:50%;background:#c8820a;flex:none"></span>${freshness.text}</span>`;
        } else if (freshness.type === 'rev') {
          freshnessHtml = `<span class="fresh-tag-rev">${freshness.text}</span>`;
        } else {
          freshnessHtml = `<span class="fresh-tag-none">${freshness.text}</span>`;
        }

        const button = document.createElement('div');
        button.role = 'button';
        button.tabIndex = 0;
        button.className = `ticket-cell${row.available ? '' : ' unavailable'}${state.selectedKey === key ? ' selected' : ''}`;
        button.innerHTML = `
          <span class="zone-dot" style="background:${color}"></span>
          <div class="ticket-info">
            <span class="ticket-zone">${zone}</span>
            <span class="ticket-sub">${sub}</span>
            <span class="ticket-freshness">${freshnessHtml}</span>
          </div>
          <div class="ticket-nums">
            <span class="ticket-price">${money(row.priceMxn)}</span>
            <span class="ticket-avail" style="color:${availColor(qty)}">${row.available ? `${qty} disp.` : 'No disponible'}</span>
          </div>
        `;
        button.addEventListener('click', () => {
          state.selectedRow = row;
          state.selectedKey = key;
          state.drawerType = 'ticket';
          renderTicketDetail();
          renderGameBoard();
        });
        grid.appendChild(button);
      }

      card.appendChild(grid);
    }

    card.querySelector('[data-match-info]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.drawerType = 'match';
      state.drawerMatchCode = match.matchCode;
      state.selectedRow = null;
      state.selectedKey = null;
      renderTicketDetail();
    });

    els.gameBoard.appendChild(card);
  }
}

function renderTicketDetail() {
  if (state.drawerType === 'match' && state.drawerMatchCode) {
    renderMatchDetail();
    return;
  }

  const row = state.selectedRow;

  if (!row) {
    els.ticketDetail.hidden = true;
    els.ticketDetail.classList.remove('open');
    els.ticketDetail.setAttribute('aria-hidden', 'true');
    els.ticketBackdrop.hidden = true;
    els.detailBody.innerHTML = '';
    state.drawerType = null;
    return;
  }

  const info = matchInfo(row);
  const color = zoneColor(row);
  const zone = zoneName(row);
  const sub = row.seatingName || row.seatingCode || 'Configuración';
  const qty = Number(row.availableQuantity || 0);
  const freshness = availabilityFreshness(row);
  const buyUrl = row.fifaShopUrl || state.latestCycle?.shopUrl || '#';

  let statusLabel, statusColor, statusBg;
  if (freshness.type === 'new') {
    statusLabel = alertReason(row) === 'increased' ? 'Más stock' : 'Nuevo';
    statusColor = '#56544d';
    statusBg = '#f1efe8';
  } else if (!row.available) {
    statusLabel = 'No disponible';
    statusColor = '#9a9688';
    statusBg = '#f1efe8';
  } else {
    statusLabel = 'Revisado';
    statusColor = '#56544d';
    statusBg = '#f3f1ea';
  }

  const details = Array.isArray(row.rawTicketType?.details) ? row.rawTicketType.details : [];
  const desc = row.rawTicketType?.description || ZONE_DESCRIPTIONS[zone] || '';

  const fields = [
    { k: 'Asiento', v: sub },
    { k: 'Código de asiento', v: row.seatingCode },
    { k: 'Tipo', v: zone },
    { k: 'Clase', v: row.packageClass || row.packageShortTitle || '' },
    { k: 'Precio base', v: `Desde ${money(row.priceMxn)} MXN / persona` },
    { k: 'Performance ID', v: row.performanceId },
    { k: 'SeatCategory ID', v: row.rawSeatingSection?.SeatCategoryId },
    { k: 'AudienceSub ID', v: row.rawSeatingSection?.AudienceSubCategoryId },
  ].filter((f) => f.v);

  const benefitsHtml = details.length > 0
    ? details.map((d) => `
        <div class="detail-include-item">
          <span class="detail-include-dot" style="background:${color}"></span>
          <div class="detail-include-text"><b>${d.title || 'Detalle'}:</b> ${d.content || ''}</div>
        </div>
      `).join('')
    : '';

  els.detailTitle.textContent = 'DETALLE DEL BOLETO';
  els.ticketDetail.hidden = false;
  els.ticketDetail.classList.add('open');
  els.ticketDetail.setAttribute('aria-hidden', 'false');
  els.ticketBackdrop.hidden = false;

  els.detailBody.innerHTML = `
    <div class="detail-top">
      <div class="detail-top-left">
        <div class="detail-match-ref">${info.matchCode} · ${info.teams}</div>
        <div class="detail-zone-row">
          <span class="detail-zone-dot" style="background:${color}"></span>
          <span class="detail-zone-name">${zone}</span>
        </div>
        <div class="detail-sub">${sub}</div>
      </div>
      <div class="detail-top-right">
        <div class="detail-price">${money(row.priceMxn)}</div>
        <div class="detail-avail" style="color:${availColor(qty)}">${row.available ? `${qty} disponibles` : 'No disponible'}</div>
      </div>
    </div>
    <div class="detail-status-row">
      <span class="detail-status-badge" style="color:${statusColor};background:${statusBg}">${statusLabel}</span>
      <span class="detail-status-time">visto hace ${timeAgo(row.checkedAt)}</span>
    </div>
    <a class="btn-cta" href="${buyUrl}" target="_blank" rel="noreferrer" style="margin-top:16px">ABRIR EN FIFA →</a>
    <div class="detail-field-grid">
      ${fields.map((f) => `
        <div class="detail-field">
          <div class="detail-field-label">${f.k}</div>
          <div class="detail-field-value">${f.v}</div>
        </div>
      `).join('')}
    </div>
    ${desc ? `<div class="detail-desc">${desc}</div>` : ''}
    ${benefitsHtml ? `
      <div class="detail-includes">
        <div class="detail-includes-title">INCLUYE</div>
        ${benefitsHtml}
      </div>
    ` : ''}
  `;
}

function renderMatchDetail() {
  const matchCode = state.drawerMatchCode;
  const allRows = state.latestCycle?.rows || [];
  const matchRows = allRows.filter((r) => r.matchCode === matchCode);

  if (matchRows.length === 0) {
    closeDetail();
    return;
  }

  const info = matchInfo(matchRows[0]);
  const meta = matchLocation(matchRows[0]);
  const availableRows = matchRows.filter((r) => r.available);
  const totalQty = matchRows.reduce((sum, r) => sum + Number(r.availableQuantity || 0), 0);

  const zoneMap = {};
  for (const row of availableRows) {
    const zone = zoneName(row);
    const color = zoneColor(row);
    const price = Number(row.priceMxn || 0);
    const qty = Number(row.availableQuantity || 0);
    if (!zoneMap[zone]) {
      zoneMap[zone] = { name: zone, color, count: 0, min: Infinity };
    }
    zoneMap[zone].count += qty;
    zoneMap[zone].min = Math.min(zoneMap[zone].min, price);
  }
  const zones = Object.values(zoneMap);

  els.detailTitle.textContent = 'INFORMACIÓN DEL PARTIDO';
  els.ticketDetail.hidden = false;
  els.ticketDetail.classList.add('open');
  els.ticketDetail.setAttribute('aria-hidden', 'false');
  els.ticketBackdrop.hidden = false;

  els.detailBody.innerHTML = `
    <div class="detail-match-ref">${info.matchCode}</div>
    <div class="detail-match-title">${info.teams}</div>
    <div class="detail-match-meta">${meta}</div>
    <div class="detail-match-stats">
      <div class="detail-match-stat">
        <div class="label-mono">BOLETOS DETECTADOS</div>
        <div class="detail-match-stat-value">${totalQty.toLocaleString('en-US')}</div>
      </div>
      <div class="detail-match-stat">
        <div class="label-mono">TIPOS DISPONIBLES</div>
        <div class="detail-match-stat-value" style="color:var(--green)">${availableRows.length} / ${matchRows.length}</div>
      </div>
    </div>
    ${zones.length > 0 ? `
      <div class="detail-includes-title" style="margin-top:20px">DISPONIBLE POR ZONA</div>
      <div class="detail-zone-list">
        ${zones.map((z) => `
          <div class="detail-zone-item">
            <span class="detail-zone-item-dot" style="background:${z.color}"></span>
            <span class="detail-zone-item-name">${z.name}</span>
            <span class="detail-zone-item-from">desde ${money(z.min)}</span>
            <span class="detail-zone-item-count">${z.count}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function closeDetail() {
  state.selectedRow = null;
  state.selectedKey = null;
  state.drawerType = null;
  state.drawerMatchCode = null;
  renderTicketDetail();
  renderGameBoard();
}

function renderEvents() {
  els.eventLog.innerHTML = '';

  for (const event of state.events.slice(0, 120)) {
    const li = document.createElement('li');
    li.innerHTML = `
      <time>${new Date(event.emittedAt || Date.now()).toLocaleTimeString()}</time>
      <strong>${describeEvent(event)}</strong>
      ${event.error ? `<span class="event-error">${event.error}</span>` : ''}
    `;
    els.eventLog.appendChild(li);
  }
}

function renderJobBoard() {
  const jobs = new Map();
  const currentCycleStartIndex = state.events.findIndex((event) => (
    event.event === 'cycle_started' || event.event === 'dashboard_cycle_started'
  ));
  const cycleEvents = state.job?.running && currentCycleStartIndex >= 0
    ? state.events.slice(0, currentCycleStartIndex + 1)
    : state.events;

  if (!state.job?.running) {
    for (const match of state.latestCycle?.matches || []) {
      const matchCode = match.card?.matchCode || match.availability?.matchCode || 'N/A';
      jobs.set(matchCode, {
        matchCode,
        status: match.ok ? 'Terminado' : 'Error',
        rows: match.availability?.rowCount ?? 0,
        availableRows: match.availability?.availableRows?.length ?? 0,
        error: match.error || '',
        updatedAt: match.checkedAt,
      });
    }
  }

  for (const event of [...cycleEvents].reverse()) {
    if (!event.matchCode) {
      continue;
    }

    const current = jobs.get(event.matchCode) || {
      matchCode: event.matchCode,
      rows: null,
      availableRows: null,
      error: '',
    };

    if (event.event === 'match_job_queued') {
      current.status = `En cola ${event.index || ''}/${event.total || ''}`.trim();
    }

    if (event.event === 'match_job_started') {
      current.status = 'Ejecutando';
    }

    if (event.event === 'match_card_click_started') {
      current.status = 'Abriendo partido';
    }

    if (event.event === 'lounge_json_wait_started') {
      current.status = 'Esperando boletos';
    }

    if (event.event === 'lounge_json_captured') {
      current.status = 'JSON capturado';
      current.bodyBytes = event.bodyBytes;
    }

    if (event.event === 'match_job_result') {
      current.status = event.ok ? 'Terminado' : 'Error';
      current.rows = event.rows ?? current.rows;
      current.availableRows = event.availableRows ?? current.availableRows;
      current.error = event.error || current.error || '';
    }

    if (event.event === 'match_job_finished' && !['Terminado', 'Error'].includes(current.status)) {
      current.status = 'Cerrado';
    }

    current.updatedAt = event.emittedAt || current.updatedAt;
    jobs.set(event.matchCode, current);
  }

  const orderedJobs = [...jobs.values()].sort((a, b) => a.matchCode.localeCompare(b.matchCode, undefined, { numeric: true }));
  els.jobBoard.innerHTML = '';

  if (orderedJobs.length === 0) {
    els.jobBoard.innerHTML = '<p class="drawer-empty">Sin trabajos registrados todavía.</p>';
    return;
  }

  for (const job of orderedJobs) {
    const row = document.createElement('article');
    row.className = `job-row ${job.status === 'Error' ? 'error' : ''}`;
    row.innerHTML = `
      <strong>${job.matchCode}</strong>
      <span>${job.status || 'Pendiente'}</span>
      <small>${job.rows ?? '-'} tipos / ${job.availableRows ?? '-'} disponibles</small>
    `;
    els.jobBoard.appendChild(row);
  }
}

function renderCycleOutput() {
  const cycle = state.latestCycle;

  if (!cycle) {
    els.cycleOutput.textContent = '{}';
    return;
  }

  els.cycleOutput.textContent = JSON.stringify({
    cicloInicio: cycle.cycleStartedAt,
    cicloFin: cycle.cycleCompletedAt,
    modo: cycle.mode || 'browser-discovery',
    tienda: cycle.visitorCountry,
    partidosDetectados: cycle.matchCardsFound,
    partidosRevisados: cycle.matchCardsScanned,
    partidosFallidos: cycle.failedMatchCount || 0,
    parcial: Boolean(cycle.partial),
    trabajosParalelos: cycle.matchConcurrency,
    fastFetchConcurrency: cycle.fastFetchConcurrency || null,
    tiposDeBoleto: cycle.rowCount,
    disponibles: cycle.availableRowCount,
    alertasActivas: activeAlerts(cycle).length,
    retencionAlertasMs: cycle.alertRetentionMs || DEFAULT_ALERT_RETENTION_MS,
  }, null, 2);
}

function render() {
  syncSelectedRow();
  renderMetrics(state.latestCycle);
  renderAlerts(state.latestCycle);
  renderGameBoard();
  renderTicketDetail();
  renderJobBoard();
  renderEvents();
  renderCycleOutput();
}

function renderFilterButtons() {
  for (const button of els.availabilityFilter.querySelectorAll('button[data-filter]')) {
    button.classList.toggle('active', button.dataset.filter === state.filter);
  }
}

function applyMode() {
  document.body.classList.toggle('admin-mode', state.isAdmin);
  document.body.classList.toggle('public-mode', !state.isAdmin);

  for (const element of document.querySelectorAll('[data-admin-only]')) {
    element.hidden = !state.isAdmin;
  }
}

async function refresh() {
  const response = await fetch('/api/state');
  const payload = await response.json();
  state.latestCycle = payload.latestCycle;
  state.job = payload.job;
  state.events = payload.job?.events || state.events;
  setStatus(payload.job);
  render();
}

function openDrawer() {
  els.drawer.classList.add('open');
  els.drawer.setAttribute('aria-hidden', 'false');
  els.drawerBackdrop.hidden = false;
}

function closeDrawer() {
  els.drawer.classList.remove('open');
  els.drawer.setAttribute('aria-hidden', 'true');
  els.drawerBackdrop.hidden = true;
}

els.runCycleButton.addEventListener('click', async () => {
  try {
    await postJson('/api/run-cycle', requestBody());
    await refresh();
  } catch (error) {
    state.events.unshift({ event: 'dashboard_cycle_failed', error: error.message, emittedAt: new Date().toISOString() });
    render();
  }
});

els.startTickerButton.addEventListener('click', async () => {
  try {
    await postJson('/api/start-ticker', requestBody());
    await refresh();
  } catch (error) {
    state.events.unshift({ event: 'dashboard_cycle_failed', error: error.message, emittedAt: new Date().toISOString() });
    render();
  }
});

els.stopTickerButton.addEventListener('click', async () => {
  await postJson('/api/stop-ticker');
  await refresh();
});

els.drawerButton.addEventListener('click', openDrawer);
els.closeDrawerButton.addEventListener('click', closeDrawer);
els.drawerBackdrop.addEventListener('click', closeDrawer);
els.ticketBackdrop.addEventListener('click', closeDetail);
els.closeDetailButton.addEventListener('click', closeDetail);
els.availabilityFilter.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');

  if (!button) {
    return;
  }

  state.filter = button.dataset.filter;
  closeDetail();
  renderFilterButtons();
  render();
});

const events = new EventSource('/events');
events.onmessage = (message) => {
  const event = JSON.parse(message.data);
  state.events.unshift(event);
  state.events = state.events.slice(0, 140);

  if (
    event.event === 'dashboard_cycle_completed' ||
    event.event === 'dashboard_cycle_failed' ||
    event.event === 'cycle_completed'
  ) {
    refresh();
  } else {
    setStatus(state.job);
    renderJobBoard();
    renderEvents();
  }
};

applyMode();
renderFilterButtons();
refresh();
setInterval(refresh, 10000);
setInterval(() => {
  renderMetrics(state.latestCycle);
}, 1000);
