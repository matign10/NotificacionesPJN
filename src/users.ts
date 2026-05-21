/**
 * Configuración multi-usuario. Cada usuario PJN tiene sus propias
 * credenciales (para el auto-bootstrap) y su propio bot de Telegram.
 *
 * Fuente principal: el secret PJN_USERS, un JSON array. Ejemplo:
 *   [{"id":"matias","pjnUsername":"20...","pjnPassword":"...",
 *     "telegramBotToken":"...","telegramChatId":"..."}]
 *
 * Fallback (un solo usuario) desde las vars legacy, para no romper setups
 * viejos que todavía no migraron a PJN_USERS.
 */

export interface PjnUser {
  id: string;
  pjnUsername?: string;
  pjnPassword?: string;
  telegramBotToken: string;
  telegramChatId: string;
}

const DEFAULT_USER_ID = 'matias';

export function rtKeySne(userId: string): string {
  return `pjn_refresh_token_sne_${userId}`;
}

export function rtKeyPortal(userId: string): string {
  return `pjn_refresh_token_portal_${userId}`;
}

export function alertKey(userId: string): string {
  return `last_session_dead_alert_at_${userId}`;
}

export function loadUsers(): PjnUser[] {
  const raw = process.env.PJN_USERS;
  if (raw && raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`PJN_USERS no es JSON válido: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('PJN_USERS debe ser un array JSON no vacío.');
    }
    const users = parsed.map(validateUser);
    const ids = new Set<string>();
    for (const u of users) {
      if (ids.has(u.id)) throw new Error(`PJN_USERS tiene un id duplicado: "${u.id}".`);
      ids.add(u.id);
    }
    return users;
  }

  const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '');
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim().replace(/^["']|["']$/g, '');
  if (botToken && chatId) {
    return [
      {
        id: process.env.PJN_USER_ID || DEFAULT_USER_ID,
        pjnUsername: process.env.PJN_USERNAME,
        pjnPassword: process.env.PJN_PASSWORD,
        telegramBotToken: botToken,
        telegramChatId: chatId,
      },
    ];
  }

  throw new Error(
    'No hay usuarios configurados: definí PJN_USERS (JSON array) o las vars legacy TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.'
  );
}

function validateUser(u: unknown, i: number): PjnUser {
  if (!u || typeof u !== 'object') throw new Error(`PJN_USERS[${i}] no es un objeto.`);
  const obj = u as Record<string, unknown>;
  if (!obj.id) throw new Error(`PJN_USERS[${i}] no tiene "id".`);
  const id = String(obj.id);
  const telegramBotToken = String(obj.telegramBotToken ?? '').trim().replace(/^["']|["']$/g, '');
  const telegramChatId = String(obj.telegramChatId ?? '').trim().replace(/^["']|["']$/g, '');
  if (!telegramBotToken || !telegramChatId) {
    throw new Error(`Usuario "${id}" sin telegramBotToken y/o telegramChatId.`);
  }
  return {
    id,
    pjnUsername: obj.pjnUsername ? String(obj.pjnUsername) : undefined,
    pjnPassword: obj.pjnPassword ? String(obj.pjnPassword) : undefined,
    telegramBotToken,
    telegramChatId,
  };
}
