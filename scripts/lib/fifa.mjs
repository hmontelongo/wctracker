import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_SHOP_URL = 'https://fifaworldcup26.hospitality.fifa.com/mx/en/choose-matches?src=home_hero_browse_matches';

export function loadTargets(path = 'config/targets.json') {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'));
}

export function loungeUrl(shopUrl, target) {
  const base = new URL('/next-api/lounges', shopUrl);
  base.searchParams.set('productCode', target.productCode);
  base.searchParams.set('productTypeCode', target.productTypeCode);
  base.searchParams.set('quantity', String(target.quantity));
  base.searchParams.set('performanceId', target.performanceId);
  return base.toString();
}

export function parseLoungeUrl(url) {
  const parsed = new URL(url);

  return {
    productCode: parsed.searchParams.get('productCode'),
    productTypeCode: parsed.searchParams.get('productTypeCode'),
    quantity: Number(parsed.searchParams.get('quantity') || 1),
    performanceId: parsed.searchParams.get('performanceId'),
  };
}

export function matchCodeFromText(text) {
  return text.match(/\bM\d+\b/i)?.[0]?.toUpperCase() ?? null;
}

export function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function inferTeamsFromText(text) {
  const clean = normalizeSpace(text);
  const code = matchCodeFromText(clean);

  if (!code) {
    return null;
  }

  const afterCode = clean.slice(clean.indexOf(code) + code.length).trim();
  const beforeDate = afterCode.split(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|June|July)\b/i)[0];
  const teams = beforeDate.replace(/\bGroup [A-Z]\b/i, '').trim();

  return teams || null;
}

export function inferMatchMetadataFromText(text) {
  const clean = normalizeSpace(text);
  const teams = inferTeamsFromText(clean);
  const dateMatch = clean.match(/\b(?:June|July)\s+\d{1,2}\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[\d:]+\s*(?:am|pm)\s*[A-Z]{2}\b/i);
  const locationText = dateMatch
    ? clean.slice(dateMatch.index + dateMatch[0].length).split(/\b(?:Starting at|Currently unavailable|Must be purchased)\b/i)[0].trim()
    : '';
  const locationMatch = locationText.match(/^(.+?),\s*(Mexico|United States|Canada)\s+(.+)$/i);

  return {
    teams,
    matchDate: dateMatch?.[0] ?? null,
    city: locationMatch?.[1]?.trim() || null,
    country: locationMatch?.[2]?.trim() || null,
    venue: locationMatch?.[3]?.trim() || null,
  };
}

export function normalizeAvailability(rawLounges, target) {
  const lounges = Array.isArray(rawLounges) ? rawLounges : [];
  const rows = [];
  const packages = lounges.map((lounge) => {
    const seatingSections = Array.isArray(lounge.seatingSections) ? lounge.seatingSections : [];
    const { seatingSections: _seatingSections, ...rawTicketTypeWithoutSections } = lounge;
    const normalizedSections = seatingSections.map((section) => {
      const normalizedSection = {
        code: section.Code ?? null,
        name: section.Name ?? null,
        seatCategoryId: section.SeatCategoryId ?? null,
        institutionSeatCategoryId: section.InstitutionSeatCategoryId ?? null,
        audienceSubCategoryId: section.AudienceSubCategoryId ?? null,
        startingPrice: section.StartingPrice ?? null,
        isAvailable: Boolean(section.IsAvailable),
        availableQuantity: Number(section.AvailableQuantity ?? 0),
      };

      rows.push({
        matchCode: target.matchCode ?? null,
        teams: target.teams ?? null,
        venue: target.venue ?? null,
        city: target.city ?? null,
        country: target.country ?? null,
        matchDate: target.matchDate ?? null,
        performanceId: target.performanceId ?? null,
        productCode: target.productCode ?? null,
        productTypeCode: target.productTypeCode ?? null,
        quantity: target.quantity ?? 1,
        loungeUrl: target.loungeUrl ?? null,
        fifaShopUrl: target.shopUrl ?? null,
        loungeId: lounge.id ?? null,
        packageTitle: lounge.title ?? lounge.shortTitle ?? null,
        packageShortTitle: lounge.shortTitle ?? null,
        packageClass: lounge.class ?? null,
        packageComparePrice: lounge.comparePrice ?? null,
        seatingCode: normalizedSection.code,
        seatingName: normalizedSection.name,
        priceMxn: normalizedSection.startingPrice,
        available: Boolean(normalizedSection.isAvailable || normalizedSection.availableQuantity > 0),
        availableQuantity: normalizedSection.availableQuantity,
        rawTicketType: rawTicketTypeWithoutSections,
        rawSeatingSection: section,
      });

      return normalizedSection;
    });

    return {
      id: lounge.id ?? null,
      title: lounge.title ?? lounge.shortTitle ?? null,
      shortTitle: lounge.shortTitle ?? null,
      className: lounge.class ?? null,
      comparePrice: lounge.comparePrice ?? null,
      seatingSections: normalizedSections,
    };
  });

  return {
    matchCode: target.matchCode ?? null,
    teams: target.teams ?? null,
    venue: target.venue ?? null,
    city: target.city ?? null,
    country: target.country ?? null,
    matchDate: target.matchDate ?? null,
    performanceId: target.performanceId ?? null,
    rowCount: rows.length,
    availableRows: rows.filter((row) => row.available),
    anyAvailable: rows.some((row) => row.available),
    rows,
    packages,
  };
}

export function normalizeLounges(rawLounges, target) {
  const availability = normalizeAvailability(rawLounges, target);
  const packages = availability.packages;

  const desiredPackage = packages.find((item) => item.id === target.loungeId);
  const desiredSection = desiredPackage?.seatingSections.find((section) => (
    section.code === target.seatingCode
  ));

  return {
    matchCode: target.matchCode,
    teams: target.teams,
    venue: target.venue,
    city: target.city,
    country: target.country,
    matchDate: target.matchDate,
    performanceId: target.performanceId,
    checkedPackage: target.loungeId,
    checkedSeatingCode: target.seatingCode,
    available: Boolean(desiredSection?.isAvailable || desiredSection?.availableQuantity > 0),
    availableQuantity: desiredSection?.availableQuantity ?? 0,
    priceMxn: desiredSection?.startingPrice ?? null,
    packageTitle: desiredPackage?.title ?? null,
    packageComparePrice: desiredPackage?.comparePrice ?? null,
    packages,
  };
}

export function parseJsonMaybe(value) {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('base64url').slice(0, 24);
}

export function buildDiscoveredTarget({ card, loungeResponse, shopUrl }) {
  const parsedUrl = parseLoungeUrl(loungeResponse.url);
  const metadata = inferMatchMetadataFromText(card.text);

  return {
    matchCode: card.matchCode ?? matchCodeFromText(card.text),
    teams: card.teams ?? metadata.teams,
    venue: card.venue ?? metadata.venue,
    city: card.city ?? metadata.city,
    country: card.country ?? metadata.country,
    matchDate: card.matchDate ?? metadata.matchDate,
    performanceId: parsedUrl.performanceId,
    productCode: parsedUrl.productCode,
    productTypeCode: parsedUrl.productTypeCode,
    quantity: parsedUrl.quantity,
    loungeUrl: loungeUrl(shopUrl, parsedUrl),
    shopUrl,
    sourceCardText: card.text,
  };
}
