import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Build prompt §17: "If a rules file imports the DOM, a timer or the network, that is a bug." */
const SRC = resolve(__dirname, '..', 'src');
const FORBIDDEN = [
  /\bdocument\b/, /\bwindow\./, /\bsetTimeout\b/, /\bsetInterval\b/, /\brequestAnimationFrame\b/,
  /\bfetch\(/, /\bWebSocket\b/, /\bXMLHttpRequest\b/, /Math\.random/, /Date\.now/, /new Date\(/,
  /performance\.now/, /\bprocess\./, /from 'node:/, /require\(/,
];

describe('engine purity', () => {
  for (const f of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
    it(`${f} uses no DOM, timers, network, clock or unseeded randomness`, () => {
      const code = readFileSync(join(SRC, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const re of FORBIDDEN) expect(code, `${f} matches ${re}`).not.toMatch(re);
    });
  }
});
