#!/usr/bin/env bash
# Публикует выбранный конфиг в main и создаёт неизменяемый тег.
#   ENVIRONMENT=dev VERSION=1 MESSAGE="..." bash scripts/release.sh
set -euo pipefail
: "${VERSION:?VERSION не задан}"
: "${MESSAGE:?MESSAGE не задан}"
ENVIRONMENT="${ENVIRONMENT:-prod}"

case "$ENVIRONMENT" in
  prod) CONFIG_PATH="config.json"; TAG="1.0.${VERSION}" ;;
  dev) CONFIG_PATH="dev/config.json"; TAG="dev-1.0.${VERSION}" ;;
  *) echo "::error::Неизвестное окружение: ${ENVIRONMENT}"; exit 1 ;;
esac

# Тег должен соответствовать версии ВНУТРИ конверта (SAM-809: config.json — {p,s}).
# Самодостаточно (только node:fs): release.sh запускают из корня репо, где scripts/ может
# быть недоступен для импорта при прогоне в изолированном окружении.
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [path, version] = process.argv.slice(1);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const config =
    parsed && typeof parsed.p === "string" && typeof parsed.s === "string"
      ? JSON.parse(Buffer.from(parsed.p, "base64url").toString("utf8"))
      : parsed;
  if (!config || !Number.isSafeInteger(config.version) || config.version < 1 || String(config.version) !== version) {
    console.error(`::error::VERSION ${version} не совпадает с version внутри конверта ${path}`);
    process.exit(1);
  }
' "$CONFIG_PATH" "$VERSION"

PUBLISHED=false
if git show-ref --verify --quiet "refs/tags/${TAG}"; then
  # Повторный запуск — без нового коммита и без перемещения существующего тега.
  if ! git show "${TAG}:${CONFIG_PATH}" | cmp -s "$CONFIG_PATH" -; then
    echo "::error::Тег ${TAG} уже существует с другим конфигом. Опубликованные теги не перезаписываются."
    exit 1
  fi
  echo "${ENVIRONMENT}: version ${VERSION} уже опубликована (${TAG})."
else
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add -- "$CONFIG_PATH"
  if ! git diff --cached --quiet -- "$CONFIG_PATH"; then
    git commit -q --only -m "config (${ENVIRONMENT}): version ${VERSION}" -m "$MESSAGE" -- "$CONFIG_PATH"
  fi
  # Люди меняют hosts.json, бот — config.json. Забираем новые коммиты перед тегом.
  git pull -q --rebase origin main
  git tag "$TAG"
  # Конфиг и тег должны попасть на GitHub вместе, в том числе при повторе после ошибки.
  git push -q --atomic origin HEAD:main "refs/tags/${TAG}"
  PUBLISHED=true
fi

# Сброс кэша jsDelivr: приложение читает prod по диапазону @1, dev — по ветке @main. Без сброса
# jsDelivr часами отдаёт старый документ. Публикация к этому моменту уже состоялась, поэтому
# сбой сброса прогон не роняет, но и не глотается молча (SAM-809): 3 попытки, потом предупреждение.
purge() {
  local url="$1" attempt
  for attempt in 1 2 3; do
    if curl -fsS --max-time 30 "$url"; then
      echo
      return 0
    fi
    echo "сброс кэша jsDelivr не удался (попытка ${attempt} из 3): ${url}" >&2
    [ "$attempt" -lt 3 ] && sleep "${PURGE_RETRY_DELAY:-5}"
  done
  echo "::warning::Кэш jsDelivr не сброшен: ${url}. Новый документ дойдёт через jsDelivr с задержкой до 12 ч. Сбрось вручную: открой эту ссылку в браузере."
  return 0
}

if [ "$PUBLISHED" = true ]; then
  case "$ENVIRONMENT" in
    prod) purge "https://purge.jsdelivr.net/gh/${GITHUB_REPOSITORY}@1/config.json" ;;
    dev) purge "https://purge.jsdelivr.net/gh/${GITHUB_REPOSITORY}@main/dev/config.json" ;;
  esac
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  # Окружений в Varioqub нет: prod-релиз приложения читает флаг endpoint_document, остальные сборки — endpoint_document_dev.
  if [ "$ENVIRONMENT" = prod ]; then VARIOQUB_FLAG=endpoint_document; else VARIOQUB_FLAG=endpoint_document_dev; fi
  {
    echo "### ${ENVIRONMENT}: version ${VERSION} (${TAG})"
    echo
    echo "- jsDelivr: https://cdn.jsdelivr.net/gh/${GITHUB_REPOSITORY}@${TAG}/${CONFIG_PATH}"
    echo "- raw (main): https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/main/${CONFIG_PATH}"
    echo
    echo "**Шаг 2 — Varioqub (${ENVIRONMENT}).** Вставьте строку ниже целиком в строковый флаг \`${VARIOQUB_FLAG}\` (окружений в Varioqub нет — dev и prod различаются именем флага). Это компактная форма того же документа — подписанный {p,s} не влезает в лимит флага 500 символов:"
    echo
    echo '```'
    node "$(dirname "$0")/varioqub-string.mjs" "$CONFIG_PATH"
    echo '```'
  } >> "${GITHUB_STEP_SUMMARY}"
fi
