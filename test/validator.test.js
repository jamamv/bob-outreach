import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, validateEmail } from '../src/validator.js';

const good = `Hi Jane,

I'm reaching out from Fieldnote. We record sales calls and write the CRM notes, so reps stop typing after every call.

Corvid Logistics looks like a team that makes a lot of calls. Fieldnote logs each one and creates the follow-up tasks for you.

Would you be open to a quick 15-minute call next week?

Best,
Sam Lee
Fieldnote`;

const required = { recipientName: 'Jane Doe', companyName: 'Corvid Logistics', senderCompany: 'Fieldnote' };
const rules = (email) => validateEmail(email, required).violations.map((v) => v.rule);

test('compliant email passes', () => {
  const report = validateEmail(good, required);
  assert.equal(report.ok, true, JSON.stringify(report.violations));
});

test('splits sentences and keeps abbreviations intact', () => {
  assert.deepEqual(splitSentences('Hi Jo,\nWe help teams, e.g. brokers. Want to chat?'), [
    'Hi Jo,',
    'We help teams, e.g. brokers.',
    'Want to chat?',
  ]);
});

test('hard bans', () => {
  assert.ok(rules(good.replace('Fieldnote. We', 'Fieldnote — we')).includes('em_dash'));
  assert.ok(rules(good.replace('Fieldnote logs', 'Additionally, Fieldnote logs')).includes('banned_opener'));
  assert.ok(rules(good.replace('Fieldnote logs', 'Furthermore Fieldnote logs')).includes('banned_opener'));
  assert.ok(rules(good.replace('a lot of', 'a fantastic number of')).includes('banned_word'));
  assert.ok(rules(good.replace('a lot of', 'fantastically many')).includes('banned_word'));
});

test('one exclamation mark is fine, two are not', () => {
  assert.ok(!rules(good.replace('Fieldnote.', 'Fieldnote!')).includes('exclamations'));
  assert.ok(rules(good.replace('Fieldnote.', 'Fieldnote!').replace('for you.', 'for you!')).includes('exclamations'));
});

test('consecutive sentences with the same first word', () => {
  const email = good.replace('Fieldnote logs', 'Corvid also gets');
  assert.ok(rules(email).includes('repeated_opener'));
});

test('sentence over 30 words', () => {
  const long = Array.from({ length: 31 }, () => 'word').join(' ');
  assert.ok(rules(good.replace('Fieldnote logs', `${long}. Fieldnote logs`)).includes('sentence_length'));
  const thirty = Array.from({ length: 30 }, () => 'word').join(' ');
  assert.ok(!rules(good.replace('Fieldnote logs', `${thirty}. Fieldnote logs`)).includes('sentence_length'));
});

test('required content', () => {
  assert.ok(rules(good.replace('Hi Jane', 'Hi there')).includes('missing_recipient'));
  assert.ok(rules(good.replace('Corvid Logistics', 'Your team')).includes('missing_company'));
  assert.ok(rules(good.replace('Would you be open to a quick 15-minute call next week?', 'Thanks.')).includes('missing_cta'));
  assert.ok(rules(good.replaceAll('Fieldnote', 'We')).includes('missing_sender'));
});

test('names: accents, titles and lowercase are handled the same in greeting and check', async () => {
  const { firstNameOf } = await import('../src/validator.js');
  assert.equal(firstNameOf('Dr. Jane Doe'), 'Jane');
  assert.equal(firstNameOf('jane doe'), 'Jane');
  assert.equal(firstNameOf('Mary-Jane Watson'), 'Mary-Jane');
  for (const name of ['José García', 'Zoë Smith', 'Łukasz Nowak', 'Søren Berg']) {
    const email = `Hi ${firstNameOf(name)},\n\nI am reaching out from Fieldnote about Corvid Logistics.\n\nWould you be open to a short call?\n\nBest,\nSam Lee\nFieldnote`;
    assert.ok(validateEmail(email, { recipientName: name, companyName: 'Corvid Logistics', senderCompany: 'Fieldnote' }).ok, name);
  }
  assert.ok(!validateEmail('Hi Josefina,\n\nFieldnote call?', { recipientName: 'José' }).ok, 'a longer name must not count as a match');
});
