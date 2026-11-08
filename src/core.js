/**
 * The one pipeline both the CLI and the web UI use:
 *   helper lookup -> assess (confidence + field checks) -> generate + validate -> log
 */
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { config } from './config.js';
import { fetchCompanyAnalysis } from './helper.js';
import { assessHelper, describeAssessment, NOT_CONFIGURED } from './insights.js';
import { generateEmail } from './generator.js';
import { generateSubject } from './subject.js';
import { appendRunLog } from './runlog.js';

export const TONES = ['direct', 'warm'];
const LIMITS = { recipientName: 100, companyName: 120, description: 600, senderName: 100, senderCompany: 120, offer: 600, proof: 300 };
const REQUIRED = ['recipientName', 'companyName', 'description', 'senderName', 'senderCompany', 'offer'];

/** Returns a list of problems with the inputs (empty when valid). `proof` is optional. */
export function checkInput(input) {
  const problems = [];
  for (const field of Object.keys(LIMITS)) {
    const value = input[field];
    if (!value?.trim()) {
      if (REQUIRED.includes(field)) problems.push(`${field} is required`);
    } else if (value.length > LIMITS[field]) problems.push(`${field} is longer than ${LIMITS[field]} characters`);
  }
  if (!TONES.includes(input.tone)) problems.push('tone must be "direct" or "warm"');
  return problems;
}

/** Start the lookup early; the returned promise never rejects. Without HELPER_URL there is no lookup. */
export function startLookup(companyName, log) {
  if (!config.helperUrl) return Promise.resolve({ ok: false, reason: NOT_CONFIGURED, attempts: 0, ms: 0 });
  return fetchCompanyAnalysis(companyName.trim(), { helperUrl: config.helperUrl, budgetMs: config.helperBudgetMs, log });
}

let client;
const getClient = () => (client ??= new OpenAI({ apiKey: config.openaiApiKey, timeout: 60_000, maxRetries: 2 }));

/** Picks the model for this email: the larger one only when there are trusted lookup facts to use. */
export function routeModel(tier) {
  return tier === 'tailored'
    ? { model: config.model, reasoningEffort: config.reasoningEffort }
    : { model: config.lightModel, reasoningEffort: config.lightReasoningEffort };
}

/** Writes a subject line for a finished email, always on the light model. */
export function createSubject({ input, email, log = () => {} }) {
  return generateSubject({ client: getClient(), model: config.lightModel, effort: config.lightReasoningEffort, input, email, log });
}

/**
 * @param input  { recipientName, companyName, description, tone, senderName, senderCompany, offer, proof? }
 * @param lookup promise from startLookup (or a ready helper result)
 * @returns everything the CLI / UI need to show the email and explain it
 */
export async function createEmail({ input, lookup, model, reasoningEffort, log = () => {}, record = true }) {
  const started = Date.now();
  const helper = await lookup;
  const assessment = assessHelper(helper);
  const explanation = describeAssessment(assessment);
  explanation.forEach((line) => log(line));
  // An explicit model (CLI --model, eval --model) overrides the routing.
  const route = model ? { model, reasoningEffort: reasoningEffort ?? config.reasoningEffort } : routeModel(assessment.tier);
  ({ model, reasoningEffort } = route);

  const result = await generateEmail({ client: getClient(), model, input, assessment, maxRepairs: config.maxRepairs, reasoningEffort, log });
  // The subject is only written for an email that passed; it never blocks the email.
  const subject = result.ok ? await createSubject({ input, email: result.email, log }) : { subject: null, usage: null };
  const run = {
    ...result,
    subject: subject.subject,
    subjectUsage: subject.usage,
    runId: randomUUID(),
    model,
    ms: Date.now() - started,
    tier: assessment.tier,
    confidence: assessment.confidence,
    explanation,
  };

  if (record) {
    await appendRunLog(config.runLog, {
      type: 'run',
      time: new Date().toISOString(),
      runId: run.runId,
      input,
      helper: { ok: helper.ok, reason: helper.reason, attempts: helper.attempts, ms: helper.ms, raw: helper.data },
      tier: assessment.tier,
      confidence: assessment.confidence,
      fieldReport: assessment.report,
      model,
      reasoningEffort,
      usage: result.usage,
      angle: result.angle,
      helperFactsUsed: result.helperFactsUsed,
      ok: result.ok,
      attempts: result.attempts,
      violations: result.violations.map((v) => v.rule),
      warnings: result.warnings.map((w) => w.message),
      email: result.email,
      subject: subject.subject,
      subjectUsage: subject.usage,
      ms: run.ms,
    });
  }
  return run;
}
