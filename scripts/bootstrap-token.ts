import dotenv from 'dotenv';
import { runBootstrap } from '../src/bootstrap/auto-bootstrap';
import { loadUsers } from '../src/users';

dotenv.config();

async function main() {
  const users = loadUsers();
  const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

  for (const user of users) {
    console.log(`\n===== Bootstrap usuario "${user.id}" =====`);
    const tokens = await runBootstrap({
      userId: user.id,
      username: user.pjnUsername,
      password: user.pjnPassword,
      headless: process.env.HEADLESS_MODE === 'true',
    });

    if (!hasSupabase) {
      console.log(`Sin Supabase. RTs capturados para "${user.id}":`);
      for (const [key, value] of Object.entries(tokens)) {
        console.log(`${key}=${value}`);
      }
    } else {
      console.log(`Listo "${user.id}". Ambos refresh_tokens en kv_config de Supabase.`);
    }
  }
}

main().catch((err) => {
  console.error('Bootstrap fallo:', err);
  process.exit(1);
});
