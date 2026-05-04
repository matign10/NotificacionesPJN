import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { KeycloakClient } from './pjn-api/keycloak';
import { NotificacionesClient } from './pjn-api/notificaciones';

dotenv.config();

async function main() {
  const refreshToken = process.env.PJN_REFRESH_TOKEN;
  const clientId = process.env.PJN_CLIENT_ID || 'pjn-sne';
  if (!refreshToken) {
    throw new Error('Falta PJN_REFRESH_TOKEN en .env. Corre `npm run bootstrap:token` primero.');
  }

  const keycloak = new KeycloakClient({ clientId, refreshToken });
  const notifs = new NotificacionesClient(keycloak);

  console.log('1) Refrescando access token...');
  const at = await keycloak.getAccessToken();
  console.log(`   OK. access_token len=${at.length}`);

  const fechaHasta = new Date();
  const fechaDesde = new Date();
  fechaDesde.setMonth(fechaDesde.getMonth() - 2);

  console.log(`\n2) Listando notificaciones RECIBIDAS desde ${fechaDesde.toISOString().slice(0, 10)} hasta ${fechaHasta.toISOString().slice(0, 10)}...`);
  const items = await notifs.listAll({ bandeja: 'RECIBIDAS', fechaDesde, fechaHasta });
  console.log(`   Total: ${items.length}`);
  for (const n of items.slice(0, 5)) {
    console.log(`   - id=${n.id}  exp=${n.expediente.numeracion}  fecha=${n.fecha}`);
    console.log(`     ${n.expediente.caratula}`);
  }
  if (items.length > 5) console.log(`   ... +${items.length - 5} más`);

  if (items.length > 0) {
    const first = items[0];
    console.log(`\n3) Descargando PDF de la notificación ${first.id}...`);
    const pdf = await notifs.getPdf(first.id);
    const outDir = path.join(__dirname, '..', 'data', 'pdfs');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `test-${first.id}.pdf`);
    fs.writeFileSync(outPath, pdf);
    console.log(`   PDF guardado en ${outPath} (${pdf.length} bytes)`);
  } else {
    console.log('\n3) Sin notificaciones para descargar — saltando paso PDF.');
  }

  console.log('\nFlujo completo OK.');
}

main().catch((err) => {
  console.error('test-api-flow falló:', err);
  process.exit(1);
});
