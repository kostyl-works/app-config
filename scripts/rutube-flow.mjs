// SAM-809: порядок публикации описаний Rutube. Зависимости приходят снаружи, чтобы порядок
// проверялся тестом (scripts/rutube-flow.test.mjs):
//   сверка описания → обмен токена (только если есть что писать) → СРАЗУ запись нового токена →
//   запись описаний → подтверждение чтением (с ожиданием).
// Refresh-токен одноразовый: если записать его после описаний, сбой записи описания оставит в
// секрете мёртвый токен, и канал встанет до ручного перевыпуска.
// Сверка до записи бережёт токен: актуальное описание не переписывается, токен не обменивается —
// поэтому повтор публикации безопасен.
//
// Подтверждение после записи ловит одно: Rutube исказил описание при сохранении (или его
// переписали). Неверный CIPHER_KEY оно НЕ ловит — читает тем же ключом, каким писало; ключ
// шифрования сверяет «проверка каналов» скрипта ключей (там ключ из связки = ключ сборки).
// Анонимное чтение Rutube отдаёт новое описание с задержкой: прогон 44031738153 — дольше 30 с.
// Поэтому ждём до CONFIRM, а решаем по ПОСЛЕДНЕМУ состоянию:
//   current — подтверждено;
//   stale / missing / unreadable — ещё не доехало: предупреждение, не ошибка (PATCH вернул 200,
//     старое описание подписано прежним действующим ключом — приложение его просто не применит);
//   broken — между метками не конверт: ошибка. Пока ждём, broken не роняет — при выпуске ключей с
//     нуля старое описание зашифровано прежним ключом шифрования и тоже выглядит как broken.
//
// fail(message) управление не возвращает (в скрипте — выход из процесса, в тесте — исключение).

/** Сколько раз и с какой паузой перечитывать описание после записи (до 3 минут). */
export const CONFIRM = { attempts: 18, delayMs: 10_000 };

/** Состояние описания видео при анонимном чтении. */
export const DESCRIPTION = {
  current: 'current', // текущий конверт
  stale: 'stale', // другой (прежний) конверт
  missing: 'missing', // меток конверта нет
  broken: 'broken', // между метками не конверт: искажено или зашифровано другим ключом
  unreadable: 'unreadable', // не прочиталось (HTTP, сеть)
};

const WHAT = {
  stale: 'прежний конверт',
  missing: 'описание без конверта',
  broken: 'описание, которое не расшифровывается в конверт',
  unreadable: 'ошибку чтения',
};

/**
 * Перечитывает описание, пока оно не станет текущим: перед каждой попыткой пауза delayMs, попыток
 * attempts. Возвращает последнее состояние и сколько ждали.
 * @param {() => Promise<string>} read
 * @param {{attempts: number, delayMs: number, sleep: (ms: number) => Promise<void>, onRetry?: (status: string, waitedMs: number) => void}} options
 * @returns {Promise<{status: string, waitedMs: number}>}
 */
export async function waitForCurrent(read, { attempts, delayMs, sleep, onRetry = () => {} }) {
  let status = DESCRIPTION.unreadable;
  let waitedMs = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(delayMs);
    waitedMs += delayMs;
    status = await read();
    if (status === DESCRIPTION.current) break;
    if (attempt < attempts) onRetry(status, waitedMs);
  }
  return { status, waitedMs };
}

/**
 * @param {object} deps
 * @param {{id: string, token: string}[]} deps.videos
 * @param {Record<string, string>} deps.tokens метка → refresh-токен
 * @param {(videoId: string) => Promise<string>} deps.verify состояние описания ({@link DESCRIPTION})
 * @param {(label: string, refresh: string) => Promise<{access: string, refresh: string}>} deps.refresh
 * @param {(tokens: Record<string, string>) => void} deps.writeBack записать словарь токенов в секрет
 * @param {(videoId: string, access: string) => Promise<void>} deps.patch записать описание (сбой — fail)
 * @param {(ms: number) => Promise<void>} deps.sleep пауза перед перечитыванием
 * @param {{attempts: number, delayMs: number}} [deps.confirm] ожидание подтверждения
 * @param {(line: string) => void} deps.log
 * @param {(message: string) => void} deps.warn предупреждение (прогон не падает)
 * @param {(message: string) => never} deps.fail
 * @param {string} deps.secret имя секрета — для сообщений
 * @param {string} deps.manual где мануал — для сообщений
 * @returns {Promise<{written: number, current: number, unconfirmed: number}>}
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
  warn,
  fail,
  secret,
  manual,
}) {
  const byLabel = new Map();
  for (const v of videos) byLabel.set(v.token, [...(byLabel.get(v.token) ?? []), v.id]);

  const updated = { ...tokens };
  let written = 0;
  let current = 0;
  let unconfirmed = 0;
  for (const [label, ids] of byLabel) {
    const stale = [];
    for (const id of ids) {
      if ((await verify(id)) === DESCRIPTION.current) {
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
    const totalSeconds = Math.round((confirm.attempts * confirm.delayMs) / 1000);
    for (const id of stale) {
      await patch(id, access);
      written++;
      const { status, waitedMs } = await waitForCurrent(() => verify(id), {
        ...confirm,
        sleep,
        onRetry: (seen, waited) =>
          log(`  видео ${id}: Rutube ещё отдаёт ${WHAT[seen] ?? seen}, жду (${Math.round(waited / 1000)} с из ${totalSeconds})`),
      });
      const seconds = Math.round(waitedMs / 1000);
      if (status === DESCRIPTION.current) {
        log(`OK  видео ${id} (метка "${label}") — подтверждено через ${seconds} с`);
        continue;
      }
      if (status === DESCRIPTION.broken) {
        fail(
          `видео ${id}: описание записано (PATCH 200), но через ${seconds} с между метками всё ещё не конверт — ` +
            `Rutube исказил описание при сохранении, или его переписали. Открой описание видео и сверь; ` +
            `повтор публикации запишет заново.`,
        );
      }
      unconfirmed++;
      log(`НЕ ДОЕХАЛО  видео ${id} (метка "${label}") — за ${seconds} с Rutube так и отдаёт ${WHAT[status] ?? status}`);
      warn(
        `видео ${id}: описание записано (PATCH 200), но анонимное чтение Rutube за ${seconds} с так и отдаёт ` +
          `${WHAT[status] ?? status}. Обычно это задержка Rutube: новое описание доедет само. Проверь позже ` +
          `скриптом ключей → «Статус» → проверка каналов; повтор публикации безопасен (доехавшее пропустится, ` +
          `токен не обменяется).`,
      );
    }
  }
  return { written, current, unconfirmed };
}
