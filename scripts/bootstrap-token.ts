import dotenv from 'dotenv';
import { runBootstrap } from '../src/bootstrap/auto-bootstrap';

dotenv.config();

async function main() {
  const tokens = await runBootstrap({
    headless: process.env.HEADLESS_MODE === 'true',
  });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.log('\nSin Supabase. RTs capturados:');
    for (const [key, value] of Object.entries(tokens)) {
      console.log(`${key}=${value}`);
    }
  } else {
    console.log('\nListo. Ambos refresh_tokens en kv_config de Supabase.');
  }
}

main().catch((err) => {
  console.error('Bootstrap fallo:', err);
  process.exit(1);
});
