/**
 * Decides which company-lookup facts the model is allowed to use.
 *
 * CONFIDENCE POLICY
 * -----------------
 *   < 0.40       ignored   Lookup not used. The email is written from the
 *                          description alone.
 *   0.40 - 0.65  generic   Only broad fields (industry, company type), used to
 *                          pick emphasis. Wording stays general; nothing is
 *                          stated as fact.
 *   >= 0.65      tailored  All valid fields: pain points, priorities,
 *                          technologies, regions.
 *
 * Why tiers: a wrong specific claim hurts a cold email more than a vague one
 * ("your US team" sent to a UK-only company ends the conversation), so the
 * most specific fields need the most confidence. Lookup scores also tend to
 * move between calls for the same company, so keep the lines away from where
 * your endpoint's real scores cluster. These defaults are a starting point:
 * calibrate them against your own endpoint (runs.jsonl logs every score).
 *
 * FIELD CHECKS
 * ------------
 * Confidence is per response, but junk is per field: a lookup can return
 * companyType "error: could not classify company" at confidence 0.99. So every
 * field must also pass its own check, and each decision is reported
 * (used / withheld / dropped / missing) so a person can see why.
 *
 * The description, typed by the sender, always wins: the model is told to
 * prefer it when a lookup hint disagrees.
 */

export const IGNORE_BELOW = 0.4;
export const TAILOR_FROM = 0.65;
export const NOT_CONFIGURED = 'not configured';

const JUNK_LABELS = ['n/a', 'na', 'none', 'null', 'undefined', 'unknown', 'other', 'unclassified', 'tbd', 'error'];
const REGION_GROUPS = ['EU', 'LATAM', 'APAC', 'MENA', 'EMEA', 'NORDICS', 'DACH'];
const VAGUE_REGIONS = ['GLOBAL', 'INT', 'INTL', 'INTERNATIONAL', 'WORLDWIDE', 'OFFSHORE'];
const REGION_NAMES = {
  US: 'US', UK: 'UK', CA: 'Canada', EU: 'Europe', LATAM: 'Latin America', APAC: 'Asia-Pacific', MENA: 'Middle East and North Africa',
  EMEA: 'EMEA', NORDICS: 'the Nordics', DACH: 'the DACH region', BR: 'Brazil', MX: 'Mexico', DE: 'Germany', ES: 'Spain', IT: 'Italy',
  FR: 'France', NL: 'the Netherlands', IE: 'Ireland', AU: 'Australia', NZ: 'New Zealand', IN: 'India', SG: 'Singapore', JP: 'Japan',
};
const ACRONYMS = {
  ai: 'AI', api: 'API', b2b: 'B2B', b2c: 'B2C', crm: 'CRM', erp: 'ERP', gdpr: 'GDPR', hr: 'HR',
  pii: 'PII', saas: 'SaaS', seo: 'SEO', sla: 'SLA', smb: 'SMB', soc: 'SOC',
};
const MAX_LIST = 8;

const key = (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : '');
const humanize = (tag) => key(tag).split('_').map((w) => ACRONYMS[w] ?? w).join(' ');
// A short plain label such as "b2b_saas" or "Health care". Free text is never passed on (prompt-injection guard).
const isPlainLabel = (v) => typeof v === 'string' && /^[a-z][a-z0-9 &/_-]{1,40}$/i.test(v.trim());

export function tierFor(confidence) {
  if (confidence >= TAILOR_FROM) return 'tailored';
  if (confidence >= IGNORE_BELOW) return 'generic';
  return 'ignored';
}

function checkLabel(v) {
  if (typeof v === 'string' && (JUNK_LABELS.includes(v.trim().toLowerCase()) || /^error\b/i.test(v.trim()))) {
    return { reason: `"${v}" is not a real value` };
  }
  return isPlainLabel(v) ? { value: humanize(v) } : { reason: `"${v}" is not a plain label` };
}

function checkTagList(v) {
  if (!Array.isArray(v)) return { reason: 'not a list' };
  const tags = v.filter((t) => isPlainLabel(t) && !JUNK_LABELS.includes(t.trim().toLowerCase())).map(humanize);
  const unique = [...new Set(tags)].slice(0, MAX_LIST);
  return unique.length ? { value: unique } : { reason: 'no usable entries' };
}

// Each checker returns { value } when valid, or { reason } when not.
const CHECKS = {
  industry: checkLabel,
  companyType: checkLabel,
  painPoints: checkTagList,
  priorities: checkTagList,
  technologies: checkTagList,
  operatingRegions(v) {
    if (!Array.isArray(v)) return { reason: 'not a list' };
    const codes = v.filter((r) => typeof r === 'string').map((r) => r.trim().toUpperCase().replace(/^GB$/, 'UK'));
    const kept = codes.filter((c) => /^[A-Z]{2}$/.test(c) || REGION_GROUPS.includes(c));
    const vague = codes.filter((c) => VAGUE_REGIONS.includes(c));
    if (kept.length) return { value: [...new Set(kept.map((c) => REGION_NAMES[c] ?? c))] };
    return { reason: vague.length ? `too vague (${vague.join(', ')})` : 'no recognisable regions' };
  },
};

// Which fields each tier may use. Broad, categorical fields need less confidence.
const BROAD_FIELDS = ['industry', 'companyType'];
const FIELDS = ['industry', 'companyType', 'painPoints', 'priorities', 'technologies', 'operatingRegions'];

/**
 * @param {{ok: boolean, data?: object, reason?: string}} helperResult from fetchCompanyAnalysis
 * @returns {{ tier, confidence, facts, report: {field, status, value?, reason?}[] }}
 *   tier: 'none' (lookup off or failed) | 'ignored' | 'generic' | 'tailored'
 *   facts: only the fields the model may use, already cleaned
 */
export function assessHelper(helperResult) {
  if (!helperResult?.ok) {
    return { tier: 'none', confidence: null, facts: {}, report: [], reason: helperResult?.reason ?? 'not called' };
  }
  const data = helperResult.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { tier: 'none', confidence: null, facts: {}, report: [], reason: 'unexpected response shape' };
  }

  const confidence = typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1 ? data.confidence : null;
  const tier = confidence === null ? 'ignored' : tierFor(confidence);
  const allowed = tier === 'tailored' ? FIELDS : tier === 'generic' ? BROAD_FIELDS : [];
  const facts = {};
  const report = [];

  if (confidence === null) report.push({ field: 'confidence', status: 'dropped', reason: `"${data.confidence}" is not a number from 0 to 1` });

  for (const field of FIELDS) {
    const raw = data[field];
    if (raw === undefined || raw === null) {
      report.push({ field, status: 'missing' });
      continue;
    }
    const check = CHECKS[field](raw);
    if (check.reason) report.push({ field, status: 'dropped', value: raw, reason: check.reason });
    else if (!allowed.includes(field)) {
      const need = BROAD_FIELDS.includes(field) ? IGNORE_BELOW : TAILOR_FROM;
      report.push({ field, status: 'withheld', value: check.value, reason: `needs confidence >= ${need}` });
    } else {
      facts[field] = check.value;
      report.push({ field, status: 'used', value: check.value });
    }
  }

  return { tier, confidence, facts, report };
}

/** Human-readable explanation, printed by the CLI and shown in the web UI. */
export function describeAssessment(a) {
  if (a.tier === 'none') {
    if (a.reason === NOT_CONFIGURED) return ['No company lookup configured: writing from the description only.'];
    return [`Company lookup unavailable (${a.reason}): writing from the description only.`];
  }
  const conf = a.confidence === null ? 'invalid' : a.confidence.toFixed(2);
  const headline = {
    tailored: 'tailored, specific company facts allowed',
    generic: 'generic, only broad company fields allowed',
    ignored: 'ignored, writing from the description only',
  }[a.tier];
  const icon = { used: '✓', withheld: '·', dropped: '✗', missing: '-' };
  const show = (v) => (Array.isArray(v) ? v.join(', ') : String(v));
  return [
    `Lookup confidence ${conf} → ${headline}`,
    ...a.report.map((r) => `  ${icon[r.status]} ${r.field}: ${r.status}${r.value !== undefined && ['used', 'withheld'].includes(r.status) ? ` (${show(r.value)})` : ''}${r.reason ? `, ${r.reason}` : ''}`),
  ];
}
