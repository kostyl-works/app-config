// Общие правила формата конфига хостов. Без внешних зависимостей.
import { existsSync, readFileSync } from 'node:fs';

/** Роли в порядке вывода. Новая роль = релиз приложения, которое её понимает. */
export const ROLES = ['api', 'superapi', 'web', 'oauth', 'cdn', 'analytics'];
export const MAX_HOSTS_PER_ROLE = 5;
/** Varioqub хранит конфиг строковым флагом — держим файл маленьким. */
export const MAX_CONFIG_BYTES = 2048;

/** Хост — только origin: https, без пути, query, логина. Пути добавляет приложение. */
export function normalizeHost(raw) {
  const value = String(raw).trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`не URL: "${value}"`);
  }
  if (url.protocol !== 'https:') throw new Error(`только https: "${value}"`);
  if (url.username || url.password) throw new Error(`логин/пароль в URL запрещены: "${value}"`);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`только origin, без пути и параметров: "${value}"`);
  }
  return url.origin;
}

/** Проверяет полный набор ролей и нормализует хосты. Возвращает роли в порядке ROLES. */
export function validateHosts(hosts) {
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) {
    throw new Error('ожидается объект {"роль": ["https://хост", ...]}');
  }
  const keys = Object.keys(hosts);
  const missing = ROLES.filter((role) => !keys.includes(role));
  const unknown = keys.filter((key) => !ROLES.includes(key));
  if (missing.length) throw new Error(`не хватает ролей: ${missing.join(', ')}`);
  if (unknown.length) throw new Error(`неизвестные роли: ${unknown.join(', ')}`);

  const result = {};
  for (const role of ROLES) {
    const list = hosts[role];
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_HOSTS_PER_ROLE) {
      throw new Error(`${role}: нужен список от 1 до ${MAX_HOSTS_PER_ROLE} хостов в квадратных скобках`);
    }
    const normalized = list.map((host) => {
      try {
        return normalizeHost(host);
      } catch (error) {
        throw new Error(`${role}: ${error.message}`);
      }
    });
    if (new Set(normalized).size !== normalized.length) throw new Error(`${role}: повторяющиеся хосты`);
    result[role] = normalized;
  }
  return result;
}

/**
 * hosts.json целиком: флаг endpoints_enabled + хосты по ролям.
 * Флаг касается только адресов: false — приложение игнорирует хосты из конфига и живёт
 * на встроенных; true — хосты из конфига главнее встроенных. Другие разделы (например,
 * будущее управление прокси) получат свои флаги.
 */
export function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('ожидается объект {"endpoints_enabled": false, "роль": ["https://хост", ...]}');
  }
  const { endpoints_enabled: endpointsEnabled, ...hosts } = source;
  if (typeof endpointsEnabled !== 'boolean') {
    throw new Error('endpoints_enabled: нужно true или false (без кавычек)');
  }
  return { endpoints_enabled: endpointsEnabled, ...validateHosts(hosts) };
}

/** Содержимое опубликованного конфига без version — для сравнения «изменилось ли что-то». */
export function pickContent(config) {
  return {
    endpoints_enabled: config.endpoints_enabled,
    ...Object.fromEntries(ROLES.map((role) => [role, config[role]])),
  };
}

/** JSON с понятной ошибкой: hosts.json правят руками в браузере. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} не читается как JSON — проверьте запятые и кавычки (${error.message})`);
  }
}

/**
 * SAM-809: опубликованный config.json — подписанный конверт {"p": base64url(bytes конфига),
 * "s": base64url(подпись)}. Возвращает САМ конфиг (внутренние байты из `p`) как объект.
 * Legacy-плейнтекст (ещё без конверта) возвращается как есть. `null` — пусто/не объект.
 */
export function unwrapEnvelope(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.p === 'string' && typeof parsed.s === 'string') {
    try {
      return JSON.parse(Buffer.from(parsed.p, 'base64url').toString('utf8'));
    } catch (error) {
      throw new Error(`config.json: поле "p" конверта не разбирается как JSON (${error.message})`);
    }
  }
  return parsed; // legacy-плейнтекст
}

/** Прочитать опубликованный конфиг (конверт или legacy) как внутренний объект, либо null. */
export function readInnerConfig(path) {
  return existsSync(path) ? unwrapEnvelope(readJson(path)) : null;
}

/**
 * Секрет refresh-токенов Rutube — свой у каждого окружения, как ключи подписи. Общий словарь
 * нельзя: секрет GitHub не читается, слить в него новую метку нельзя, а запись обратно целиком
 * перетёрла бы чужие метки. dev, пока нет RUTUBE_TOKENS_DEV, читает старый общий RUTUBE_TOKENS
 * (в env — RUTUBE_TOKENS_LEGACY) и после ротации пишет уже в RUTUBE_TOKENS_DEV.
 * @returns {{secret: string, raw: string}} имя секрета для записи обратно и его значение
 */
export function rutubeTokenSource(environment, env) {
  if (environment === 'prod') {
    return { secret: 'RUTUBE_TOKENS_PROD', raw: env.RUTUBE_TOKENS_PROD ?? '' };
  }
  if (environment === 'dev') {
    return {
      secret: 'RUTUBE_TOKENS_DEV',
      raw: env.RUTUBE_TOKENS_DEV || env.RUTUBE_TOKENS_LEGACY || '',
    };
  }
  throw new Error(`неизвестное окружение "${environment}" (ожидается prod или dev)`);
}
