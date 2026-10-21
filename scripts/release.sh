#!/usr/bin/env bash
# Коммитит dist/config.json, ставит тег 1.0.<version> и пушит; пишет итог в summary.
# Тег — голая версия "1.0.<version>" без "v": так jsDelivr-адрес @1.0.<version> совпадает
# с именем тега один в один, а диапазон @1 считается по semver.
#   VERSION=42 MESSAGE="..." bash src/scripts/release.sh
set -euo pipefail
: "${VERSION:?VERSION не задан}"
: "${MESSAGE:?MESSAGE не задан}"
TAG="1.0.${VERSION}"

cd dist
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add config.json
git commit -q -m "version ${VERSION}: ${MESSAGE}" -m "run: ${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-local}"
git tag "${TAG}"
git push -q origin HEAD:dist "refs/tags/${TAG}"

# Purge — только ускоритель для @1: приложение спрашивает точную версию @1.0.<version+1>,
# которой purge не нужен. Без выданного jsDelivr доступа вернёт ошибку — не страшно.
curl -sS --max-time 30 "https://purge.jsdelivr.net/gh/${GITHUB_REPOSITORY}@1/config.json" || true
echo

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Опубликована version ${VERSION}"
    echo
    echo "- jsDelivr: https://cdn.jsdelivr.net/gh/${GITHUB_REPOSITORY}@${TAG}/config.json"
    echo "- raw: https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${TAG}/config.json"
    echo
    echo "**Шаг 2 — Varioqub.** Вставьте строку ниже целиком в флаг \`endpoints_config\`:"
    echo
    echo '```'
    cat config.json
    echo '```'
  } >> "${GITHUB_STEP_SUMMARY}"
fi
