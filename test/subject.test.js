import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSubject } from '../src/validator.js';
import { cleanSubject, fallbackSubject, generateSubject } from '../src/subject.js';

const input = { recipientName: 'Jane Doe', companyName: 'Corvid Logistics', description: 'A freight brokerage', tone: 'direct', senderCompany: 'Fieldnote' };
const fakeClient = (subjects) => {
  const calls = [];
  return {
    calls,
    responses: {
      create: async (req) => {
        calls.push(req);
        const subject = subjects[Math.min(calls.length - 1, subjects.length - 1)];
        if (subject instanceof Error) throw subject;
        return { output_text: JSON.stringify({ subject }), usage: { input_tokens: 300, output_tokens: 8 } };
      },
    },
  };
};

test('subject rules', () => {
  assert.deepEqual(checkSubject('call notes at Corvid'), []);
  for (const bad of ['Hi', 'Huge news for you!', 'Re: our chat', 'Fwd: call notes', 'call notes — fast', 'A fantastic idea', 'FREE call notes', 'call notes 🚀 ideas', 'one two three four five six seven eight nine']) {
    assert.ok(checkSubject(bad).length, bad);
  }
});

test('capitals from a company name are not shouting', () => {
  assert.ok(checkSubject('an idea for NVIDIA').length);
  assert.deepEqual(checkSubject('an idea for NVIDIA', { names: ['NVIDIA'] }), []);
});

test('cleans quotes and trailing periods', () => {
  assert.equal(cleanSubject('"call notes at Corvid."'), 'call notes at Corvid');
});

test('retries once with the problems, then succeeds', async () => {
  const client = fakeClient(['Amazing news!', 'call notes at Corvid']);
  const r = await generateSubject({ client, model: 'gpt-5.4-mini', effort: 'none', input, email: 'Hi Jane, ...' });
  assert.deepEqual([r.subject, r.fallback, r.usage.calls], ['call notes at Corvid', false, 2]);
  assert.match(client.calls[1].input[0].content, /broke these rules/);
});

test('falls back to a plain subject when the model keeps failing or errors', async () => {
  const failing = await generateSubject({ client: fakeClient(['WOW!!!']), model: 'gpt-5.4-mini', effort: 'none', input, email: '...' });
  assert.deepEqual([failing.subject, failing.fallback], ['Idea for Corvid Logistics', true]);
  const erroring = await generateSubject({ client: fakeClient([new Error('network')]), model: 'gpt-5.4-mini', effort: 'none', input, email: '...' });
  assert.equal(erroring.fallback, true);
  assert.equal(fallbackSubject('A Very Long Company Name That Goes On And On Forever Ltd Holdings'), 'A quick idea for your team');
});
