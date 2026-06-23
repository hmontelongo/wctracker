import {
  claimPendingNotifications,
  markNotificationFailed,
  markNotificationSent,
} from './sqlite-store.mjs';

function money(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  }).format(value);
}

function quantity(value) {
  const count = Number(value || 0);
  return count === 1 ? '1 disp.' : `${count.toLocaleString('en-US')} disp.`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function reasonLabel(payload) {
  const type = payload?.event?.eventType || payload?.eventType || 'availability';

  return {
    new: 'Disponible ahora',
    increased: 'Subió stock',
    becomes_available: 'Disponible ahora',
    stock_increase: 'Subió stock',
    stock_change: 'Cambió stock',
    price_change: 'Cambió precio',
    any_change: 'Cambio detectado',
    availability: 'Nueva alerta',
  }[type] || type;
}

function conditionLabel(condition) {
  return {
    becomes_available: 'Cuando esté disponible',
    stock_increase: 'Si sube stock',
    stock_change: 'Si cambia stock',
    price_change: 'Si cambia precio',
    any_change: 'Cualquier cambio',
  }[condition] || condition || 'Alerta';
}

function localizeText(value) {
  if (!value) {
    return '';
  }

  const replacements = new Map([
    ['Spain', 'España'],
    ['Mexico', 'México'],
    ['United States', 'Estados Unidos'],
    ['Canada', 'Canadá'],
    ['Germany', 'Alemania'],
    ['Netherlands', 'Países Bajos'],
    ['England', 'Inglaterra'],
    ['Ivory Coast', 'Costa de Marfil'],
    ["Côte d'Ivoire", 'Costa de Marfil'],
    ['Iran', 'Irán'],
    ['Japan', 'Japón'],
  ]);

  let text = String(value);
  for (const [source, target] of replacements) {
    text = text.replace(new RegExp(`\\b${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), target);
  }

  return text;
}

function matchLine(row = {}) {
  return [row.matchCode, localizeText(row.teams)].filter(Boolean).join(' · ') || row.matchCode || 'Partido';
}

function locationLine(row = {}) {
  return [row.venue, row.city].map(localizeText).filter(Boolean).join(' · ');
}

function compactMatchDate(value) {
  if (!value) {
    return '';
  }

  const match = String(value).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}).*?\b(\d{1,2}:\d{2})\s*(am|pm)\s*([A-Z]{2})\b/i);

  if (!match) {
    return localizeText(value);
  }

  const months = {
    january: 'ene',
    february: 'feb',
    march: 'mar',
    april: 'abr',
    may: 'may',
    june: 'jun',
    july: 'jul',
    august: 'ago',
    september: 'sep',
    october: 'oct',
    november: 'nov',
    december: 'dic',
  };

  const meridiem = match[4].toLowerCase() === 'am' ? 'a.m.' : 'p.m.';
  return `${Number(match[2])} ${months[match[1].toLowerCase()]} · ${match[3]} ${meridiem} ${match[5]}`;
}

function buyUrl(payload, row) {
  return row.fifaShopUrl || payload.shopUrl || '';
}

function isUserAlert(notification) {
  return notification?.payload?.sourceType === 'alert_rule'
    || notification?.sourceType === 'alert_rule'
    || notification?.priority === 'high';
}

export function formatTelegramNotification(notification) {
  const payload = notification.payload || {};
  const row = payload.row || {};
  const ticketParts = [row.packageTitle || row.loungeId || 'Boleto', row.seatingName || row.seatingCode]
    .map(localizeText)
    .filter(Boolean);
  const ticket = [...new Set(ticketParts)].join(' · ');
  const location = locationLine(row);
  const date = compactMatchDate(row.matchDate);
  const lines = [];

  if (isUserAlert(notification)) {
    lines.push(payload.rule?.condition
      ? `<b>Tu alerta</b> · ${escapeHtml(conditionLabel(payload.rule.condition))}`
      : '<b>Tu alerta</b>');
  }

  lines.push(`<b>${escapeHtml(matchLine(row))}</b>`);
  lines.push(escapeHtml(ticket || 'Boleto'));
  lines.push(`<b>${escapeHtml(reasonLabel(payload))}</b> · ${escapeHtml(quantity(row.availableQuantity))} · <b>${escapeHtml(money(row.priceMxn))} MXN</b>`);

  if (location) {
    lines.push(escapeHtml(location));
  }

  if (date) {
    lines.push(escapeHtml(date));
  }

  return lines.filter(Boolean).join('\n');
}

function telegramReplyMarkup(notification) {
  const payload = notification.payload || {};
  const row = payload.row || {};
  const url = buyUrl(payload, row);

  if (!url) {
    return undefined;
  }

  return {
    inline_keyboard: [[
      {
        text: `Comprar en FIFA · ${row.matchCode || 'partido'}`,
        url,
      },
    ]],
  };
}

export function telegramConfigFromEnv(env = process.env) {
  return {
    enabled: String(env.TELEGRAM_NOTIFICATIONS_ENABLED || '0') === '1',
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_CHAT_ID || '',
    intervalMs: Math.max(1000, Number(env.TELEGRAM_NOTIFY_INTERVAL_MS || 3000)),
    batchSize: Math.max(1, Number(env.TELEGRAM_NOTIFY_BATCH_SIZE || 5)),
    leaseMs: Math.max(5000, Number(env.TELEGRAM_NOTIFY_LEASE_MS || 30000)),
    retryDelayMs: Math.max(1000, Number(env.TELEGRAM_NOTIFY_RETRY_DELAY_MS || 30000)),
    maxAttempts: Math.max(1, Number(env.TELEGRAM_MAX_ATTEMPTS || 5)),
  };
}

export function telegramReady(config = telegramConfigFromEnv()) {
  return Boolean(config.enabled && config.token && config.chatId);
}

export function formatTelegramRuleEvent({ type, rule, row }) {
  const eventLabel = type === 'deleted' ? 'Alerta eliminada' : 'Alerta creada';
  const current = row || {};
  const lineMatch = matchLine({
    matchCode: rule?.matchCode || current.matchCode,
    teams: current.teams || rule?.label?.split(' · ')?.[1],
  });
  const ticketParts = [
    current.packageTitle || rule?.packageTitle,
    current.seatingName || rule?.seatingName || rule?.seatingCode,
  ].map(localizeText).filter(Boolean);
  const ticket = [...new Set(ticketParts)].join(' · ');
  const detail = type === 'deleted'
    ? 'Ya no se enviarán avisos de esta regla.'
    : 'Te avisaré aquí cuando se cumpla.';

  return [
    `<b>${escapeHtml(eventLabel)}</b>`,
    `<b>${escapeHtml(lineMatch)}</b>`,
    ticket ? escapeHtml(ticket) : null,
    `<b>${escapeHtml(conditionLabel(rule?.condition))}</b>`,
    `<i>${escapeHtml(detail)}</i>`,
  ].filter(Boolean).join('\n');
}

async function sendTelegramMessage(config, notification) {
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: formatTelegramNotification(notification),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: telegramReplyMarkup(notification),
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram sendMessage failed: ${response.status}`);
  }

  return payload.result;
}

async function sendTelegramText(config, text) {
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram sendMessage failed: ${response.status}`);
  }

  return payload.result;
}

export async function sendTelegramRuleEvent(config, event) {
  if (!telegramReady(config)) {
    return { sent: false, skipped: true, reason: 'telegram_disabled_or_not_configured' };
  }

  await sendTelegramText(config, formatTelegramRuleEvent(event));
  return { sent: true, skipped: false };
}

export async function runTelegramNotifyOnce(options = {}) {
  const config = options.config || telegramConfigFromEnv();
  const owner = options.owner || `telegram-${process.pid}`;
  const claimed = telegramReady(config)
    ? claimPendingNotifications(owner, {
      sqlitePath: options.sqlitePath,
      limit: config.batchSize,
      leaseMs: config.leaseMs,
      maxAttempts: config.maxAttempts,
    })
    : [];
  const result = {
    enabled: config.enabled,
    ready: telegramReady(config),
    claimed: claimed.length,
    sent: 0,
    failed: 0,
  };

  for (const notification of claimed) {
    try {
      await sendTelegramMessage(config, notification);
      markNotificationSent(notification.id, owner, { sqlitePath: options.sqlitePath });
      result.sent += 1;
    } catch (error) {
      markNotificationFailed(notification.id, owner, error.message, {
        sqlitePath: options.sqlitePath,
        retryDelayMs: config.retryDelayMs * notification.attempts,
      });
      result.failed += 1;
    }
  }

  return result;
}
