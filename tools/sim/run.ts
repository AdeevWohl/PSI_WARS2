/**
 * AI-vs-AI batch simulator (build prompt §13).
 *
 *   npm run sim                                     500 games, starter decks, Normal AI
 *   npm run sim -- --games 2000 --ai hard
 *   npm run sim -- --balance data/balance/my-pass.json --out reports/my-pass.json
 *   npm run sim -- --decks creature-commander,robot-commander,path/to/deck.json --players 3
 *
 * Options
 *   --games N          number of games (default 500)
 *   --players N        2-4 seats (default 2)
 *   --ai LEVEL[,..]    easy | normal | hard, one for all or one per seat (default normal)
 *   --decks A,B        deck ids from data/decks or paths to deck .json files (default: both starters)
 *   --balance FILE     balance overlay layered over data/cards.json (e.g. exported from the card editor)
 *   --seed TEXT        base seed (default "sim"); the same seed and data give the same results
 *   --hp N             starting Lab HP
 *   --max-turns N      turn limit per game (default 150, ends in a draw)
 *   --mirrors          also play mirror matches
 *   --out FILE         also write the full report as JSON (or .md / .txt for the text report)
 *   --cards N          rows in the per-card table (default: all)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDefs, cleanBalance, formatReport, runSimulation, validateDeck, type AiLevel, type CardDef, type RulesData, type SimDeck } from '../../packages/engine/src/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

function args(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true;
    else {
      out[k] = v;
      i++;
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(`sim: ${msg}`);
  process.exit(1);
}

const a = args(process.argv.slice(2));
if (a.help || a.h) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]!.replace(/^\/\*\*?|^ \* ?/gm, ''));
  process.exit(0);
}
const baseCards = read(resolve(ROOT, 'data/cards.json')) as { cards: CardDef[] };
const rules = read(resolve(ROOT, 'data/rules.json')) as RulesData;

let balanceName = 'cards.json (no overlay)';
let defs = buildDefs(baseCards);
if (typeof a.balance === 'string') {
  const p = resolve(a.balance);
  if (!existsSync(p)) fail(`balance file not found: ${p}`);
  const { balance, errors } = cleanBalance(baseCards, read(p));
  for (const e of errors) console.warn(`balance: ${e}`);
  defs = buildDefs(baseCards, balance);
  balanceName = `${balance.name} (${basename(p)}, ${Object.keys(balance.cards).length} cards changed)`;
}

const deckArg = typeof a.decks === 'string' ? a.decks.split(',') : ['creature-commander', 'robot-commander'];
const decks: SimDeck[] = deckArg.map((d) => {
  const p = d.endsWith('.json') ? resolve(d) : resolve(ROOT, 'data/decks', `${d}.json`);
  if (!existsSync(p)) fail(`deck not found: ${d} (looked for ${p})`);
  const j = read(p);
  const problems = validateDeck(defs, rules, j);
  if (problems.length) fail(`deck "${j.name ?? d}" is not legal under this balance: ${problems.map((x) => x.message).join('; ')}`);
  return { name: j.name ?? basename(p, '.json'), deck: { battle: j.battle, resource: j.resource } };
});

const levels = (typeof a.ai === 'string' ? a.ai : 'normal').split(',') as AiLevel[];
for (const l of levels) if (!['easy', 'normal', 'hard'].includes(l)) fail(`unknown AI level "${l}"`);
const games = Number(a.games ?? 500);
const players = Number(a.players ?? 2);
if (!Number.isInteger(games) || games < 1) fail('--games must be a positive whole number');
if (![2, 3, 4].includes(players)) fail('--players must be 2, 3 or 4');

let last = 0;
const report = runSimulation({
  defs, rules, decks, games, players, ai: levels,
  seed: typeof a.seed === 'string' ? a.seed : 'sim',
  startingHP: a.hp ? Number(a.hp) : undefined,
  maxTurns: a['max-turns'] ? Number(a['max-turns']) : undefined,
  mirrors: !!a.mirrors,
  balanceName,
  now: () => performance.now(),
  onProgress: (done, total) => {
    const pctDone = Math.floor((done / total) * 20);
    if (process.stderr.isTTY && (pctDone !== last || done === total)) {
      last = pctDone;
      process.stderr.write(`\r  [${'#'.repeat(pctDone)}${' '.repeat(20 - pctDone)}] ${done}/${total} games`);
      if (done === total) process.stderr.write('\n');
    }
  },
});

const text = formatReport(report, { cards: a.cards ? Number(a.cards) : undefined });
console.log(text);
if (typeof a.out === 'string') {
  const p = resolve(a.out);
  mkdirSync(dirname(p), { recursive: true });
  const ext = extname(p).toLowerCase();
  writeFileSync(p, ext === '.md' || ext === '.txt' ? (ext === '.md' ? '```\n' + text + '\n```\n' : text + '\n') : JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${p}`);
}
if (report.errors.length) process.exit(2);
