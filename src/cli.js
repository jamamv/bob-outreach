import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { config } from './config.js';
import { TONES, checkInput, startLookup, createEmail } from './core.js';
import { assessHelper } from './insights.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';

const USAGE = `Usage: bob [options]

Bob writes personalised cold emails.

Prompts for any value not passed as a flag (or set in .env).

About you (defaults: SENDER_NAME, SENDER_COMPANY, SENDER_OFFER, SENDER_PROOF):
  --from-name <name>     Your name, e.g. "Sam Lee"
  --from-company <name>  Your company, e.g. "Fieldnote"
  --offer <text>         What you sell, in one or two sentences
  --proof <text>         Optional: a real result or customer you can mention

About them:
  --name <name>          Recipient's name, e.g. "Jane Doe"
  --company <company>    Their company, e.g. "Corvid Logistics"
  --description <text>   What their company does, and why you are reaching out
  --tone <direct|warm>   Email tone

  --model <model>        Use this OpenAI model for every email (default: routed, ${config.model} with lookup data, ${config.lightModel} without)
  -v, --verbose          Show retries, repairs, and a rejected draft if there is one
  --dry-run              Print the prompt that would be sent, without calling OpenAI
  -h, --help             Show this help

The email is written to stdout, only if it passes every rule.
Prompts and diagnostics go to stderr.
Exit codes: 0 ok, 1 error, 2 no email passed the rules.`;

// Prompts and diagnostics go to stderr so stdout contains only the email.
const err = (msg = '') => process.stderr.write(`${msg}\n`);

// Reads answers through the line iterator, which buffers input, so both typed
// and piped answers work (rl.question() drops lines that arrive early).
async function nextLine(lines, question) {
  process.stderr.write(question);
  const { value, done } = await lines.next();
  if (done) throw new Error('input ended before every question was answered');
  if (!process.stdin.isTTY) err(value);
  return value;
}

async function askRequired(lines, question) {
  for (;;) {
    const answer = (await nextLine(lines, question)).trim();
    if (answer) return answer;
    err('  This field is required.');
  }
}

async function askOptional(lines, question) {
  return (await nextLine(lines, question)).trim();
}

async function askTone(lines) {
  for (;;) {
    const answer = (await nextLine(lines, 'Tone, "direct" or "warm" [direct]: ')).trim().toLowerCase();
    if (!answer || answer === 'd') return 'direct';
    if (answer === 'w') return 'warm';
    if (TONES.includes(answer)) return answer;
    err('  Please enter "direct" or "warm".');
  }
}

export async function run(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        'from-name': { type: 'string' },
        'from-company': { type: 'string' },
        offer: { type: 'string' },
        proof: { type: 'string' },
        name: { type: 'string' },
        company: { type: 'string' },
        description: { type: 'string' },
        tone: { type: 'string' },
        model: { type: 'string' },
        verbose: { type: 'boolean', short: 'v', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const verbose = (m) => values.verbose && err(`  [debug] ${m}`);
  const dryRun = values['dry-run'];
  if (!dryRun && !config.openaiApiKey) {
    err('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');
    return 1;
  }

  const sender = {
    senderName: (values['from-name'] ?? config.sender.name).trim(),
    senderCompany: (values['from-company'] ?? config.sender.company).trim(),
    offer: (values.offer ?? config.sender.offer).trim(),
    proof: (values.proof ?? config.sender.proof).trim(),
  };
  const askSender = !sender.senderName || !sender.senderCompany || !sender.offer;
  const needsPrompt = askSender || !values.name || !values.company || !values.description || !values.tone;
  const rl = needsPrompt ? readline.createInterface({ input: process.stdin, output: process.stderr }) : null;
  rl?.on('SIGINT', () => {
    err('\nCancelled.');
    process.exit(130);
  });
  const lines = rl?.[Symbol.asyncIterator]();

  const input = { ...sender };
  let lookup;
  try {
    if (askSender) {
      err('About you (set SENDER_NAME, SENDER_COMPANY and SENDER_OFFER in .env to skip these):');
      input.senderName ||= await askRequired(lines, 'Your name: ');
      input.senderCompany ||= await askRequired(lines, 'Your company: ');
      input.offer ||= await askRequired(lines, 'What do you offer? One or two sentences: ');
      if (values.proof === undefined && !config.sender.proof) {
        input.proof = await askOptional(lines, 'A real result or customer you can mention (optional, Enter to skip): ');
      }
      err('\nAbout them:');
    }
    input.recipientName = values.name?.trim() || (await askRequired(lines, "Recipient's name: "));
    input.companyName = values.company?.trim() || (await askRequired(lines, 'Their company: '));
    // Start the slow lookup now, so it runs while the user types the rest.
    lookup = startLookup(input.companyName, verbose);
    input.description = values.description?.trim() || (await askRequired(lines, 'What does their company do, and why are you reaching out? '));
    input.tone = values.tone?.trim().toLowerCase() || (await askTone(lines));
  } catch (e) {
    err(`\n${e.message}.`);
    return 1;
  } finally {
    rl?.close();
  }

  const problems = checkInput(input);
  if (problems.length) {
    err(`Invalid input: ${problems.join('; ')}.`);
    return 1;
  }

  err(config.helperUrl ? '\nLooking up the company...' : '');
  if (dryRun) {
    const assessment = assessHelper(await lookup);
    console.log(`===== SYSTEM (prompts/system.md) =====\n${SYSTEM_PROMPT}\n===== USER =====\n${buildUserMessage(input, assessment)}`);
    return 0;
  }

  let result;
  try {
    result = await createEmail({
      input,
      lookup,
      model: values.model,
      log: (line) => (/^(Lookup|Company lookup|No company lookup|  [✓·✗-] )/.test(line) ? err(line) : verbose(line)),
    });
  } catch (e) {
    err(`\nOpenAI request failed: ${e.message}`);
    return 1;
  }

  err(`Angle: ${result.angle}. Lookup facts used: ${result.helperFactsUsed.join('; ') || 'none'}.`);
  if (!result.ok) {
    err(`\nNo email passed every rule after ${result.attempts} attempts:`);
    result.violations.forEach((v) => err(`  - ${v.message}`));
    if (values.verbose) err(`\nRejected draft (do not send):\n${result.email}`);
    return 2;
  }

  err('');
  console.log(`Subject: ${result.subject}\n\n${result.email}`);
  result.warnings.forEach((w) => err(`Note: ${w.message}`));
  verbose(`${result.attempts} attempt(s), ${result.stats.words} words, longest sentence ${result.stats.longestSentence} words, ${(result.ms / 1000).toFixed(1)}s, ${result.model}, ${result.usage.input} in / ${result.usage.output} out tokens`);
  return 0;
}
