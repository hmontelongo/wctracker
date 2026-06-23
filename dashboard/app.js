const state = {
  latestCycle: null,
  job: null,
  selectedRow: null,
  selectedKey: null,
  filter: 'available',
  isAdmin: location.pathname.replace(/\/$/, '').endsWith('/admin') || new URLSearchParams(location.search).has('admin'),
  events: [],
};

const DEFAULT_ALERT_RETENTION_MS = 10 * 60 * 1000;

const els = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  freshnessText: document.getElementById('freshnessText'),
  currentStage: document.getElementById('currentStage'),
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

function describeEvent(event) {
  if (!event) {
    return 'Esperando inicio';
  }

  const labels = {
    connected: 'Dashboard conectado',
    dashboard_ticker_started: `Ticker iniciado cada ${event.intervalMs || ''} ms`,
    dashboard_ticker_stopped: 'Ticker detenido',
    dashboard_cycle_started: `Ciclo iniciado (${event.mode || 'modo actual'})`,
    dashboard_cycle_completed: `Ciclo terminado: ${event.availableRowCount || 0} disponibles, ${event.failedMatchCount || 0} fallos`,
    dashboard_cycle_failed: `Fallo: ${event.error || 'sin detalle'}`,
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
  els.statusDot.className = 'status-dot idle';
  els.statusText.textContent = 'En espera';
  els.currentStage.textContent = describeEvent(job?.lastEvent);
  els.startTickerButton.hidden = !state.isAdmin || Boolean(job?.tickerRunning);
  els.stopTickerButton.hidden = !state.isAdmin || !job?.tickerRunning;
  els.runCycleButton.disabled = Boolean(job?.running);
  els.startTickerButton.disabled = Boolean(job?.running);

  if (job?.lastError) {
    els.statusDot.className = 'status-dot error';
    els.statusText.textContent = 'Error';
  } else if (job?.running) {
    els.statusDot.className = 'status-dot running';
    els.statusText.textContent = 'Ejecutando';
  } else if (job?.tickerRunning) {
    els.statusDot.className = 'status-dot live';
    els.statusText.textContent = 'Activo';
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
    return `${minutes}m ${seconds % 60}s`;
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
    return row.checkedAt ? `Revisado ${timeAgo(row.checkedAt)}` : 'No disponible';
  }

  if (isActiveAlert(row)) {
    const label = alertReason(row) === 'increased' ? 'Mas stock' : 'Nuevo';
    return `${label} ${timeAgo(alertTimestamp(row))}`;
  }

  return row.checkedAt ? `Revisado ${timeAgo(row.checkedAt)}` : 'Disponible';
}

function isFreshAvailability(row) {
  return isActiveAlert(row);
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
    : 'Sin ciclos aun';
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
  els.alertPanel.innerHTML = `
    <div>
      <span>Alertas nuevas</span>
      <strong>${alerts.length}</strong>
      <small>Boletos que aparecieron o aumentaron stock en los ultimos ${Math.round(alertRetentionMs(cycle) / 60000)} minutos.</small>
    </div>
    <div class="alert-list"></div>
  `;

  const list = els.alertPanel.querySelector('.alert-list');

  for (const row of alerts.slice(0, 8)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'alert-item';
    const reason = alertReason(row) === 'increased' ? 'Mas stock' : 'Nuevo';
    item.innerHTML = `
      <strong>${matchTitle(row)} · ${row.packageTitle || row.loungeId || 'Boleto'}</strong>
      <span>${row.matchCode || 'N/A'} · ${matchLocation(row)} · ${row.seatingName || row.seatingCode || 'Configuracion'} · ${row.availableQuantity || 0} disponibles · ${money(row.priceMxn)} · ${reason} ${timeAgo(alertTimestamp(row))}</span>
    `;
    item.addEventListener('click', () => {
      state.selectedKey = ticketKey(row);
      state.selectedRow = row;
      renderTicketDetail();
      renderGameBoard();
    });
    list.appendChild(item);
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
      <p>El ultimo ciclo no encontro boletos con el filtro actual. Cambia el filtro o espera el siguiente ciclo.</p>
    `;
    els.gameBoard.appendChild(empty);
    return;
  }

  for (const match of matches) {
    const availableCount = match.rows.filter((row) => row.available).length;
    const totalQuantity = match.rows.reduce((sum, row) => sum + Number(row.availableQuantity || 0), 0);
    const possibleRivals = possibleRivalsText(match.teams);
    const card = document.createElement('article');
    card.className = 'game-card';
    card.innerHTML = `
      <header class="game-head">
        <div>
          <span class="match-code">${match.matchCode}</span>
          <h2>${match.teams}</h2>
          <p>${[match.city, match.country, match.venue, match.matchDate].filter(Boolean).join(' · ') || 'Informacion del partido pendiente'}</p>
          ${possibleRivals ? `<p class="match-path">${possibleRivals}</p>` : ''}
        </div>
        <div class="game-stock">
          <strong>${totalQuantity}</strong>
          <span>boletos detectados</span>
        </div>
      </header>
      <div class="ticket-grid"></div>
      <footer>${availableCount}/${match.rows.length} tipos disponibles</footer>
    `;

    const grid = card.querySelector('.ticket-grid');

    for (const row of [...match.rows].sort(ticketSort)) {
      const key = ticketKey(row);
      const button = document.createElement('button');
      button.className = `ticket-card ${row.available ? 'available' : 'unavailable'} ${state.selectedKey === key ? 'selected' : ''}`;
      const freshnessClass = isFreshAvailability(row) ? 'fresh' : '';
      button.innerHTML = `
        <span class="ticket-title">${row.packageTitle || row.loungeId || 'Tipo de boleto'}</span>
        <span class="ticket-seat">${row.seatingName || row.seatingCode || 'Configuracion'}</span>
        <span class="ticket-price">${money(row.priceMxn)}</span>
        <span class="ticket-qty">${row.available ? `${row.availableQuantity || 0} disponibles` : 'No disponible'}</span>
        <span class="ticket-freshness ${freshnessClass}">${availabilityFreshness(row)}</span>
      `;
      button.addEventListener('click', () => {
        state.selectedRow = row;
        state.selectedKey = key;
        renderTicketDetail();
        renderGameBoard();
      });
      grid.appendChild(button);
    }

    els.gameBoard.appendChild(card);
  }
}

function detailItem(label, value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  return `<div><span>${label}</span><strong>${value}</strong></div>`;
}

function renderTicketDetail() {
  const row = state.selectedRow;

  if (!row) {
    els.ticketDetail.hidden = true;
    els.ticketDetail.classList.remove('open');
    els.ticketDetail.setAttribute('aria-hidden', 'true');
    els.ticketBackdrop.hidden = true;
    els.detailBody.innerHTML = '';
    return;
  }

  const details = Array.isArray(row.rawTicketType?.details) ? row.rawTicketType.details : [];
  const buyUrl = row.fifaShopUrl || state.latestCycle?.shopUrl || '#';
  const info = matchInfo(row);
  const benefits = details
    .map((detail) => `<li><b>${detail.title || 'Detalle'}:</b> ${detail.content || ''}</li>`)
    .join('');

  els.ticketDetail.hidden = false;
  els.ticketDetail.classList.add('open');
  els.ticketDetail.setAttribute('aria-hidden', 'false');
  els.ticketBackdrop.hidden = false;
  els.detailBody.innerHTML = `
    <section class="detail-summary">
      <div>
        <h2>${info.teams || 'Partido por confirmar'}</h2>
        <span class="match-code">${info.matchCode || 'N/A'}</span>
        <p>${matchLocation(row)}</p>
        <p>${row.packageTitle || row.loungeId || 'Tipo de boleto'} · ${row.seatingName || row.seatingCode || 'Configuracion'}</p>
      </div>
      <div class="detail-price">
        <strong>${money(row.priceMxn)}</strong>
        <span>${row.available ? `${row.availableQuantity || 0} disponibles` : 'No disponible'}</span>
        <small>${availabilityFreshness(row)}</small>
      </div>
    </section>
    <a class="buy-link" href="${buyUrl}" target="_blank" rel="noreferrer">Abrir en FIFA</a>
    <section class="detail-grid">
      ${detailItem('Asiento', row.seatingName || row.seatingCode)}
      ${detailItem('Codigo de asiento', row.seatingCode)}
      ${detailItem('Tipo', row.packageShortTitle || row.packageTitle)}
      ${detailItem('Clase', row.packageClass)}
      ${detailItem('Precio base', row.packageComparePrice)}
      ${detailItem('Partido', info.teams)}
      ${detailItem('Codigo de partido', info.matchCode)}
      ${detailItem('Venue', info.venue)}
      ${detailItem('Ciudad', info.city)}
      ${detailItem('Pais', info.country)}
      ${detailItem('Fecha', info.matchDate)}
      ${detailItem('Performance ID', row.performanceId)}
      ${detailItem('SeatCategoryId', row.rawSeatingSection?.SeatCategoryId)}
      ${detailItem('AudienceSubCategoryId', row.rawSeatingSection?.AudienceSubCategoryId)}
    </section>
    ${row.rawTicketType?.description ? `<p class="detail-copy">${row.rawTicketType.description}</p>` : ''}
    ${benefits ? `<section class="detail-benefits"><h3>Incluye</h3><ul>${benefits}</ul></section>` : ''}
  `;
}

function renderEvents() {
  els.eventLog.innerHTML = '';

  for (const event of state.events.slice(0, 120)) {
    const li = document.createElement('li');
    li.innerHTML = `
      <time>${new Date(event.emittedAt || Date.now()).toLocaleTimeString()}</time>
      <strong>${describeEvent(event)}</strong>
      <span>${event.error || ''}</span>
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
    els.jobBoard.innerHTML = '<p class="drawer-empty">Sin trabajos registrados todavia.</p>';
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
els.ticketBackdrop.addEventListener('click', () => {
  state.selectedRow = null;
  state.selectedKey = null;
  renderTicketDetail();
  renderGameBoard();
});
els.closeDetailButton.addEventListener('click', () => {
  state.selectedRow = null;
  state.selectedKey = null;
  renderTicketDetail();
  renderGameBoard();
});
els.availabilityFilter.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');

  if (!button) {
    return;
  }

  state.filter = button.dataset.filter;
  state.selectedRow = null;
  state.selectedKey = null;
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
    els.currentStage.textContent = describeEvent(event);
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
  renderAlerts(state.latestCycle);
}, 1000);
