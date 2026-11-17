// SAM-809: строка для флага Varioqub — компактная форма "<z>.<s>" опубликованного конверта {p,s}.
// Подписанный {p,s} (~570 символов) не влезает в строковый флаг Varioqub (лимит 500), компактный —
// ~170. Подпись та же, приложение распаковывает и проверяет её так же, как у {p,s}.
// Запуск: node scripts/varioqub-string.mjs <config.json>
import { readFileSync } from 'node:fs';
import { compactEnvelope } from './crypto.mjs';

const path = process.argv[2];
if (!path) {
  console.error('использование: node scripts/varioqub-string.mjs <config.json>');
  process.exit(2);
}
process.stdout.write(`${compactEnvelope(readFileSync(path, 'utf8').trim())}\n`);
