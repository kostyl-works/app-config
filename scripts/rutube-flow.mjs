// SAM-809: порядок публикации описаний Rutube. Зависимости приходят снаружи, чтобы порядок
// проверялся тестом (scripts/rutube-flow.test.mjs):
//   сверка описания → обмен токена (только если есть что писать) → СРАЗУ запись нового токена →
//   запись описаний → подтверждение чтением (с повторами).
// Refresh-токен одноразовый: если записать его после описаний, сбой записи описания оставит в
// секрете мёртвый токен, и канал встанет до ручного перевыпуска.
// Сверка до записи бережёт токен: актуальное описание не переписывается, токен не обменивается —
// поэтому повтор публикации безопасен.
// Подтверждение после записи ловит неверный CIPHER_KEY: Rutube примет любое описание, а приложение
// его не расшифрует. Rutube отдаёт новое описание не сразу (прогон 44024383675: чтение через доли
// секунды после PATCH вернуло старое) — поэтому подтверждение ждёт, а не читает один раз.
//
// fail(message) управление не возвращает (в скрипте — выход из процесса, в тесте — исключение).

/** Сколько раз и с какой паузой перечитывать описание после записи (до 30 с). */
export const CONFIRM = { attempts: 6, delayMs: 5000 };

/**
 * Ждёт, пока check() вернёт true: перед каждой попыткой пауза delayMs, попыток attempts.
 * @param {() => Promise<boolean>} check
 * @param {{attempts: number, delayMs: number, sleep: (ms: number) => Promise<void>, onRetry?: (attempt: number) => void}} options
 * @returns {Promise<boolean>} true — подтвердилось
 */
export async function confirmWritten(check, { attempts, delayMs, sleep, onRetry = () => {} }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(delayMs);
    if (await check()) return true;
    if (attempt < attempts) onRetry(attempt);
  }
  return false;
}

/**
 * @param {object} deps
 * @param {{id: string, token: string}[]} deps.videos
 * @param {Record<string, string>} deps.tokens метка → refresh-токен
 * @param {(videoId: string) => Promise<boolean>} deps.verify в описании уже текущий конверт
 * @param {(label: string, refresh: string) => Promise<{access: string, refresh: string}>} deps.refresh
 * @param {(tokens: Record<string, string>) => void} deps.writeBack записать словарь токенов в секрет
 * @param {(videoId: string, access: string) => Promise<void>} deps.patch записать описание (сбой — fail)
 * @param {(ms: number) => Promise<void>} deps.sleep пауза перед перечитыванием
 * @param {{attempts: number, delayMs: number}} [deps.confirm] повторы подтверждения
 * @param {(line: string) => void} deps.log
 * @param {(message: string) => never} deps.fail
 * @param {string} deps.secret имя секрета — для сообщений
 * @param {string} deps.manual где мануал — для сообщений
 * @returns {Promise<{written: number, current: number}>}
 */
export async function publishDescriptions({
  videos,
  tokens,
  verify,
  refresh,
  writeBack,
  patch,
  sleep,
  confirm = CONFIRM,
  log,
  fail,
  secret,
  manual,
}) {
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
      await patch(id, access);
      const ok = await confirmWritten(() => verify(id), {
        ...confirm,
        sleep,
        onRetry: (attempt) => log(`  видео ${id}: Rutube ещё отдаёт старое описание, жду (попытка ${attempt}/${confirm.attempts})`),
      });
      log(`${ok ? 'OK  ' : 'БЕЗ ПОДТВЕРЖДЕНИЯ '}видео ${id} (метка "${label}")`);
      if (!ok) {
        const seconds = Math.round((confirm.attempts * confirm.delayMs) / 1000);
        fail(
          `видео ${id}: описание записано, но за ${seconds} с конверт из него так и не прочитался. Либо Rutube ` +
            `ещё отдаёт старое описание — запусти публикацию ещё раз (доехавшее описание пропустится, токен не ` +
            `обменяется), либо CIPHER_KEY не тот, что в сборке приложения — сверь ключ шифрования.`,
        );
      }
      written++;
    }
  }
  return { written, current };
}
