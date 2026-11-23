/// <reference lib="webworker" />
/** Runs AI-vs-AI simulations off the main thread for the card editor's quick test. */
import { formatReport, runSimulation, type AiLevel, type CardDef, type RulesData, type SimDeck, type SimReport } from '@psi-wars/engine';

export interface SimRequest {
  runs: { label: string; defs: Record<string, CardDef>; balanceName: string }[];
  rules: RulesData;
  decks: SimDeck[];
  games: number;
  ai: AiLevel;
  seed: string;
}

export type SimMessage =
  | { t: 'progress'; run: number; done: number; total: number }
  | { t: 'done'; reports: { label: string; report: SimReport; text: string }[] }
  | { t: 'error'; message: string };

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const req = e.data;
  try {
    const reports = req.runs.map((r, run) => {
      let last = 0;
      const report = runSimulation({
        defs: r.defs, rules: req.rules, decks: req.decks, games: req.games, ai: req.ai, seed: req.seed, balanceName: r.balanceName,
        now: () => performance.now(),
        onProgress: (done, total) => {
          if (done - last >= Math.max(1, Math.floor(total / 50)) || done === total) {
            last = done;
            (self as unknown as Worker).postMessage({ t: 'progress', run, done, total } satisfies SimMessage);
          }
        },
      });
      return { label: r.label, report, text: formatReport(report) };
    });
    (self as unknown as Worker).postMessage({ t: 'done', reports } satisfies SimMessage);
  } catch (err) {
    (self as unknown as Worker).postMessage({ t: 'error', message: (err as Error).message } satisfies SimMessage);
  }
};
