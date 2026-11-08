/**
 * Builds what the model sees. All instructions live in prompts/system.md so
 * they can be read and reviewed as a document. This file only adds the data,
 * kept in a <data> block the model is told to treat as information, never as
 * instructions.
 */
import { readFileSync } from 'node:fs';
import { firstNameOf, firstWord } from './validator.js';

export const SYSTEM_PROMPT = readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8');

export const SIGN_OFFS = { direct: 'Best,', warm: 'Warm regards,' };
const MAX_DESCRIPTION = 600;

export const EMAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['angle', 'helperFactsUsed', 'paragraphs'],
  properties: {
    angle: { type: 'string' },
    helperFactsUsed: { type: 'array', items: { type: 'string' } },
    paragraphs: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Lookup facts the description does not already mention. These are what make
 * the email specific beyond what the sender typed, so the prompt asks the
 * model to use at least one. Matching is a simple word-prefix check.
 */
export function notInDescription(items, description) {
  const text = description.toLowerCase();
  const mentioned = (item) => item.toLowerCase().split(/\s+/).some((w) => w.length >= 3 && text.includes(w.slice(0, 5)));
  return items.filter((item) => !mentioned(item));
}

/** The lookup facts the model may use, in the shape the system prompt describes. */
function helperBlock({ tier, facts }, description) {
  if (tier !== 'tailored' && tier !== 'generic') return { trust: 'none' };
  const block = { trust: tier };
  if (facts.industry) block.industryHint = facts.industry;
  if (facts.companyType) block.companyTypeHint = facts.companyType;
  if (facts.painPoints) block.painPoints = facts.painPoints;
  if (facts.priorities) block.priorities = facts.priorities;
  if (facts.technologies) block.technologies = facts.technologies;
  if (facts.operatingRegions) block.operatingRegions = facts.operatingRegions;
  const fresh = notInDescription([...(facts.painPoints ?? []), ...(facts.priorities ?? []), ...(facts.technologies ?? [])], description);
  if (tier === 'tailored' && fresh.length) block.notInDescription = fresh;
  return block;
}

export function buildUserMessage(input, assessment) {
  const sender = { name: input.senderName, company: input.senderCompany, offer: input.offer };
  if (input.proof) sender.proof = input.proof;
  const data = {
    sender,
    recipientFirstName: firstNameOf(input.recipientName),
    companyName: input.companyName,
    description: input.description.slice(0, MAX_DESCRIPTION),
    tone: input.tone,
    helper: helperBlock(assessment, input.description),
  };
  return `<data>\n${JSON.stringify(data, null, 2)}\n</data>\n\nWrite the email body in the "${input.tone}" tone.`;
}

export function buildRevisionMessage(violations) {
  return [
    'The email broke these rules:',
    ...violations.map((v) => `- ${v.message}`),
    '',
    'Return the corrected JSON. Fix every issue, keep the substance, and check each sentence before answering.',
  ].join('\n');
}

/**
 * Sender's name, then their company on its own line. The company line is left
 * out when it starts with the same word as the name ("Acme" from "Acme Bot"),
 * since two lines starting alike would break the repeated-opener rule.
 */
export function signature({ senderName, senderCompany }) {
  const name = senderName.trim();
  const company = senderCompany.trim();
  return firstWord(name) === firstWord(company) ? name : `${name}\n${company}`;
}

/** Greeting and sign-off are added here, so they can never be wrong. */
export function renderEmail(input, paragraphs) {
  const body = paragraphs.map((p) => p.trim()).filter(Boolean).join('\n\n');
  return `Hi ${firstNameOf(input.recipientName)},\n\n${body}\n\n${SIGN_OFFS[input.tone]}\n${signature(input)}`;
}
