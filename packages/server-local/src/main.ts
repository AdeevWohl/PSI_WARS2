import { startServer } from './index';

const port = Number(process.env.PORT ?? 8787);
void startServer({ port }).then(({ port: p }) => {
  console.log(`\n  Psi Wars local server ready: http://localhost:${p}`);
  console.log('  Share it over the internet (no account needed):');
  console.log(`    cloudflared tunnel --url http://localhost:${p}\n`);
});
