// Общие правила формата конфига хостов. Без внешних зависимостей.
import { readFileSync } from 'node:fs';

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
 * hosts.json целиком: флаг enabled + хосты по ролям.
 * enabled=false — приложение игнорирует конфиг и живёт на встроенных адресах;
 * enabled=true — конфиг главнее встроенных адресов.
 */
export function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('ожидается объект {"enabled": false, "роль": ["https://хост", ...]}');
  }
  const { enabled, ...hosts } = source;
  if (typeof enabled !== 'boolean') throw new Error('enabled: нужно true или false (без кавычек)');
  return { enabled, ...validateHosts(hosts) };
}

/** Содержимое опубликованного конфига без version — для сравнения «изменилось ли что-то». */
export function pickContent(config) {
  return { enabled: config.enabled, ...Object.fromEntries(ROLES.map((role) => [role, config[role]])) };
}

/** JSON с понятной ошибкой: hosts.json правят руками в браузере. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} не читается как JSON — проверьте запятые и кавычки (${error.message})`);
  }
}
