import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateEmail } from '../src/generator.js';
import { assessHelper } from '../src/insights.js';
import { buildUserMessage, renderEmail, signature } from '../src/prompt.js';

const input = {
  recipientName: 'Jane Doe',
  companyName: 'Corvid Logistics',
  description: 'A freight brokerage with a growing sales team',
  tone: 'direct',
  senderName: 'Sam Taylor',
  senderCompany: 'Fieldnote',
  offer: 'Fieldnote records sales calls and writes the CRM notes automatically.',
  proof: '',
};
const assessment = assessHelper({ ok: false, reason: 'HTTP 503' });

const reply = (paragraphs) => JSON.stringify({ angle: 'CRM admin for reps', helperFactsUsed: [], paragraphs });
const bad = reply([
  'We help teams. We take CRM notes for Corvid Logistics — fast.',
  'Would you be open to a call?',
]);
const good = reply([
  "I'm reaching out from Fieldnote. Reps at companies like Corvid Logistics spend hours logging calls, and we write those notes for them.",
  'Would you be open to a 15-minute call next week?',
]);

const fakeClient = (replies) => {
  const calls = [];
  return {
    calls,
    responses: {
      create: async (req) => {
        calls.push(structuredClone(req));
        return { output_text: replies[Math.min(calls.length - 1, replies.length - 1)] };
      },
    },
  };
};

test('repairs with the exact problems until the email passes', async () => {
  const client = fakeClient([bad, good]);
  const r = await generateEmail({ client, model: 'gpt-4.1-mini', input, assessment });
  assert.equal(r.ok, true);
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[1].input.at(-1).content, /both start with "we"/);
  assert.equal(client.calls[1].input.at(-2).role, 'assistant');
});

test('hard bans are fixed in code, never sent back to the model', async () => {
  const client = fakeClient([reply(["Fieldnote writes Corvid Logistics' call notes — fast.", 'Open to a call next week?'])]);
  const r = await generateEmail({ client, model: 'gpt-4.1-mini', input, assessment });
  assert.equal(r.ok, true);
  assert.equal(client.calls.length, 1);
  assert.doesNotMatch(r.email, /—/);
});

test('stops after maxRepairs and reports ok=false', async () => {
  const client = fakeClient([bad]);
  const r = await generateEmail({ client, model: 'gpt-4.1-mini', input, assessment, maxRepairs: 2 });
  assert.equal(r.ok, false);
  assert.equal(client.calls.length, 3);
  assert.ok(r.violations.length > 0);
});

test('greeting and sign-off come from code, by tone, signed by the sender', () => {
  assert.match(renderEmail(input, ['Body.']), /^Hi Jane,\n\nBody\.\n\nBest,\nSam Taylor\nFieldnote$/);
  assert.match(renderEmail({ ...input, tone: 'warm' }, ['Body.']), /Warm regards,\nSam Taylor\nFieldnote$/);
});

test('the company line is dropped when it would start like the name line', () => {
  assert.equal(signature({ senderName: 'Acme Bot', senderCompany: 'Acme' }), 'Acme Bot');
  assert.equal(signature({ senderName: 'Sam Taylor', senderCompany: 'Fieldnote' }), 'Sam Taylor\nFieldnote');
});

test('the sender profile reaches the prompt, and proof only when given', () => {
  const plain = buildUserMessage(input, assessment);
  assert.match(plain, /"company": "Fieldnote"/);
  assert.match(plain, /"offer": "Fieldnote records sales calls/);
  assert.doesNotMatch(plain, /"proof"/);
  assert.match(buildUserMessage({ ...input, proof: 'Hartley Freight saves 4 hours a week' }, assessment), /"proof": "Hartley Freight/);
});

test('reasoning models get reasoning effort, other models get temperature', async () => {
  const client = fakeClient([good]);
  await generateEmail({ client, model: 'gpt-5.5', input, assessment });
  await generateEmail({ client, model: 'gpt-4.1-mini', input, assessment });
  assert.deepEqual(client.calls[0].reasoning, { effort: 'low' });
  assert.equal(client.calls[0].temperature, undefined);
  assert.equal(client.calls[1].temperature, 0.7);
});

test('lookup facts reach the prompt only when the tier allows', () => {
  const data = { industry: 'logistics', companyType: 'freight_brokerage', painPoints: ['rep_ramp_time'], operatingRegions: ['MX'] };
  const high = buildUserMessage(input, assessHelper({ ok: true, data: { ...data, confidence: 0.9 } }));
  const mid = buildUserMessage(input, assessHelper({ ok: true, data: { ...data, confidence: 0.5 } }));
  const low = buildUserMessage(input, assessHelper({ ok: true, data: { ...data, confidence: 0.2 } }));
  assert.match(high, /rep ramp time/);
  assert.match(high, /"trust": "tailored"/);
  assert.doesNotMatch(mid, /ramp|Mexico/);
  assert.match(mid, /"companyTypeHint": "freight brokerage"/);
  assert.match(low, /"trust": "none"/);
  assert.doesNotMatch(low, /companyTypeHint/);
});

test('notInDescription keeps only lookup facts the sender did not already mention', async () => {
  const { notInDescription } = await import('../src/prompt.js');
  const desc = 'A freight brokerage whose reps spend hours on CRM data entry';
  assert.deepEqual(notInDescription(['CRM data entry', 'rep ramp time', 'cross border expansion'], desc), ['cross border expansion']);
});

test('routing: the larger model with reasoning only when trusted lookup facts exist', async () => {
  const { routeModel } = await import('../src/core.js');
  const { config } = await import('../src/config.js');
  assert.deepEqual(routeModel('tailored'), { model: config.model, reasoningEffort: config.reasoningEffort });
  for (const tier of ['generic', 'ignored', 'none']) assert.equal(routeModel(tier).model, config.lightModel);
});
