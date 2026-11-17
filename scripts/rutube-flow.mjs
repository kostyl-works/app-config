// SAM-809: порядок публикации описаний Rutube. Зависимости приходят снаружи, чтобы порядок
// проверялся тестом (scripts/rutube-flow.test.mjs):
//   сверка описания → обмен токена (только если есть что писать) → СРАЗУ запись нового токена →
//   запись описаний.
// Refresh-токен одноразовый: если записать его после описаний, сбой записи описания оставит в
// секрете мёртвый токен, и канал встанет до ручного перевыпуска.
//
// fail(message) управление не возвращает (в скрипте — выход из процесса, в тесте — исключение).

/**
 * @param {object} deps
 * @param {{id: string, token: string}[]} deps.videos
 * @param {Record<string, string>} deps.tokens метка → refresh-токен
 * @param {(videoId: string) => Promise<boolean>} deps.verify в описании уже текущий конверт
 * @param {(label: string, refresh: string) => Promise<{access: string, refresh: string}>} deps.refresh
 * @param {(tokens: Record<string, string>) => void} deps.writeBack записать словарь токенов в секрет
 * @param {(videoId: string, access: string) => Promise<boolean>} deps.patch записать описание, true — подтверждено
 * @param {(line: string) => void} deps.log
 * @param {(message: string) => never} deps.fail
 * @param {string} deps.secret имя секрета — для сообщений
 * @param {string} deps.manual где мануал — для сообщений
 * @returns {Promise<{written: number, current: number}>}
 */
export async function publishDescriptions({ videos, tokens, verify, refresh, writeBack, patch, log, fail, secret, manual }) {
  const byLabel = new Map();
  for (const v of videos) byLabel.set(v.token, [...(byLabel.get(v.token) ?? []), v.id]);

  const updated = { ...tokens };
  let written = 0;
  let current = 0;
  for (const [label, ids] of byLabel) {
    const stale = [];
    for (const id of ids) {
      if (await verify(id)) {
        log(`АКТУАЛЬНО  видео ${id} (метка "${label}") — пропуск`);
        current++;
      } else {
        stale.push(id);
      }
    }
    if (stale.length === 0) continue;
    if (!tokens[label]) {
      fail(`в секрете ${secret} нет метки "${label}" (нужна для видео ${stale.join(', ')}). Добавь её. Мануал: ${manual}`);
    }
    const { access, refresh: newRefresh } = await refresh(label, tokens[label]);
    if (newRefresh !== updated[label]) {
      updated[label] = newRefresh;
      writeBack({ ...updated });
    }
    for (const id of stale) {
      const ok = await patch(id, access);
      log(`${ok ? 'OK  ' : 'БЕЗ ПОДТВЕРЖДЕНИЯ '}видео ${id} (метка "${label}")`);
      if (!ok) fail(`видео ${id}: описание записано, но конверт из него не расшифровался обратно. Проверь CIPHER_KEY.`);
      written++;
    }
  }
  return { written, current };
}
