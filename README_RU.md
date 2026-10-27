# Vesta

Серверное ядро. Имя пакета — `microphoenix`. Продукт закрепляет один коммит [github.com/KonkovDV/Vesta](https://github.com/KonkovDV/Vesta).

Язык: [EN](README.md) | **RU**

| | |
| --- | --- |
| Ветка по умолчанию | `main` |
| Репозиторий | [KonkovDV/Vesta](https://github.com/KonkovDV/Vesta) |

[![CI](https://github.com/KonkovDV/Vesta/actions/workflows/ci.yml/badge.svg)](https://github.com/KonkovDV/Vesta/actions/workflows/ci.yml)
[![Node.js 24](https://img.shields.io/badge/node.js-24-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![cite](https://img.shields.io/badge/cite-CITATION.cff-orange.svg)](CITATION.cff)

Журнал лежит в PostgreSQL. Наружу событие выходит через outbox. Шина — Redis. HTTP — Express. Цикл агента не выполняет инструмент с внешним эффектом, пока человек не разрешит этот вызов (`TOOL_APPROVAL_REQUIRED`, `POST /api/agents/runs/:id/approvals/:toolCallId`). Свой проект добавляет сервисы, маршруты, SQL и более строгие правила инструментов, не правя это дерево.

Если эта страница расходится с [docs/limitations.md](docs/limitations.md) или с [docs/claims.md](docs/claims.md), верны они.

| Поле | Значение |
| --- | --- |
| Версия | 2.14.0 (`package.json`) |
| Среда | Node.js 24 |
| Готовность | Самооценка TRL 4 в смысле ISO 16290: компонент проверен в лаборатории. Это не сертификат и не развёрнутый сервис. |
| Слова статусов | `pinned` — продукт называет 40-символьный коммит. `ready` — `/health/ready` ответил 200 при трёх флагах настоящих хранилищ. Ни то ни другое не значит, что модель точна или что подача ушла. |
| Автор | Коньков Д. В. (`@KonkovDV`) |
| Форма | Один репозиторий ядра и отдельные репозитории продуктов, как у [SynAPS](https://github.com/KonkovDV/SynAPS). Правило размещения: [docs/adr/0003-product-placement.md](docs/adr/0003-product-placement.md). |

## Что заявлено

Точка входа, пин, outbox и ворота разрешения перечислены в [docs/claims.md](docs/claims.md). Этот репозиторий не запускает таймер cron. Значок сборки гоняет проверку типов, `npm test` на Node 24 и 26, сборку, аудит production-зависимостей и интеграционную задачу с pgvector и Redis. Та же задача разрешает каждый DI-токен по фиксированному потолку и вызывает каждый маршрут без ключа. Ссылка на работу — [CITATION.cff](CITATION.cff) вместе с закреплённым коммитом.

## Чего не заявлено

Веб-клиент, продукт взыскания, измеренное качество модели, ровно одна доставка в чужую систему, калькулятор нормы. `USE_MOCK_AI=true` поднимает заглушки `IAIClient` и модели цикла агента. Карта литературы: [docs/research/long-running-case.md](docs/research/long-running-case.md).

## Что делает

- Поднимает один процесс: `src/index.ts` вызывает `runKernel()`.
- Восстанавливает состояние из журнала событий.
- Публикует через outbox. Шина по умолчанию — Redis Pub/Sub: публикация без подписчика теряется. `EVENT_BUS_TRANSPORT=streams` хранит запись, пока потребитель её не подтвердит. MP-K22.
- Принимает сервисы, маршруты и SQL проекта, не требуя правок ядра.
- Не даёт заменить сервис, который ядро уже зарегистрировало.
- В `ToolRegistry` не выполняет тело инструмента, если вызов требует разрешения и не несёт `approvalGranted`.
- Для перечисленных ниже исходящих вызовов соединяется с адресами, которые охранник DNS только что проверил. Свой HTTP-клиент проекта этот охранник не наследует.

## Чего не делает

См. [docs/limitations.md](docs/limitations.md). Это не веб-клиент и не продукт взыскания. `USE_MOCK_AI=true` запускает заглушку модели, а не измеренное качество.

## Сервер

```bash
cp .env.example .env
docker compose up -d postgres redis
docker compose --profile migrate run --rm migrate
docker compose up --build app
```

`JWT_SECRET` — не короче 32 символов (`openssl rand -hex 32`). `/health/ready` отвечает 200, когда журнал, шина и outbox доступны. Postgres и Redis наружу не публикуются. Занятый порт 3000 заменяется переменной `APP_PORT`.

Без Docker, на Node.js 24:

```bash
npm ci
npm run build
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB npm run migrate
npm start
```

Готовность смотрит настоящие хранилища только при `FF_USEREALEVENTSTORE`, `FF_USEREALEVENTBUS` и `FF_USEREALOUTBOX`. В `docker-compose.yml` они включены.

## Зависимость на коммит

```json
{
  "dependencies": {
    "microphoenix": "github:KonkovDV/Vesta#<40-символьный SHA>"
  }
}
```

`npm install` собирает `dist/` скриптом `prepare`. Коммит меняют осознанно и проверяют тестами проекта. Ветку не закрепляют.

```ts
import path from 'node:path';
import { runKernel, type KernelExtension } from 'microphoenix';

const cases: KernelExtension = {
  name: 'cases',
  register(container) {
    container.register('CaseRepository', () => ({ ready: true }), { lifecycle: 'singleton' });
  },
  routes(app, { authMw, rateLimitMw }) {
    app.get('/api/v1/cases', authMw, rateLimitMw, (_req, res) => {
      res.json({ items: [] });
    });
  },
  migrationsDir: path.resolve(__dirname, '../migrations'),
};

void runKernel({ extensions: [cases] });
```

`register` идёт после DI ядра. Повторная регистрация токена ядра — ошибка старта. `routes` идут после маршрутов ядра и до 404. SQL проекта — после SQL ядра: `npx microphoenix-migrate --dir ./migrations`.

Импорт только `microphoenix`. Путь `microphoenix/dist/...` даёт `ERR_PACKAGE_PATH_NOT_EXPORTED`.

`runKernel()` при ошибке старта бросает `KernelStartError` и не завершает процесс. Завершает его `src/index.ts` с кодом 1. Обработчики `SIGTERM`, `SIGINT` и необработанных ошибок процесс завершают. `processHandlers: false` оставляют это внешнему наблюдателю.

## Команды

| Команда | Действие |
| --- | --- |
| `npm run typecheck` | типы без сборки |
| `npm test` | юнит-тесты (`tests/unit`, node:test + tsx) |
| `npm run test:integration` | интеграционные тесты; нужны `TEST_DATABASE_URL` и `TEST_REDIS_URL` |
| `npm run build` | `dist/` и `.d.ts`, копия SQL, замена `@/` на относительные пути |
| `npm run migrate` | миграции ядра; каталоги проекта: `npm run migrate -- --dir ./migrations` |
| `npm start` | `node dist/index.js` |

Базовая миграция ядра — `001_consolidated.sql`, следом идёт `002_runtime_tables.sql`. Повторный прогон пропускает файл, если контрольная сумма совпала. Каталог проекта через `--dir` применяется после них. База, которая уже применила старую копию `001_consolidated.sql`, новую контрольную сумму этого файла не примет.

## Исходящий HTTP

Когда зарегистрирован `ISsrfDnsGuard`, эти вызовы открывают сокет на закреплённых адресах. Более поздний ответ DNS для этого сокета не используется. Редирект закрепляется снова. Переход с HTTPS на HTTP закрывается.

| Вызов | Как |
| --- | --- |
| Загрузка документа | `selectIngestionHttpClient` |
| Расчёт x402 | `pinnedExchange` |
| GET к реестру образов | `pinnedExchange`, если у охранника есть `pinUrl` |
| Обнаружение A2A, JSON-RPC и поток событий | тот же пин, его передаёт DI |
| Исходящий MCP (SSE, streamable HTTP) | `createPinnedFetch` передаётся транспорту SDK |

Проверка, которая умеет только `isSafe` или `validateUrl`, сначала отвечает «можно», потом вызывает обычный `fetch`. Это не закрепление. Лабораторное хранилище медиа и лабораторный реестр MCP-клиентов в этот срез не входят. См. [docs/limitations.md](docs/limitations.md).

## Документы

| Путь | Содержание |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Процесс, слои, порядок старта |
| [docs/extensions.md](docs/extensions.md) | Пин, `register`, маршруты, SQL |
| [docs/overlays.md](docs/overlays.md) | Долгое дело поверх ядра |
| [docs/limitations.md](docs/limitations.md) | Не-утверждения. Имеют приоритет над этой страницей |
| [docs/claims.md](docs/claims.md) | Утверждения и файл, который каждое из них держит |
| [docs/research/long-running-case.md](docs/research/long-running-case.md) | Литература и файл, который она ограничивает |
| [docs/adr/0001-kernel-as-package.md](docs/adr/0001-kernel-as-package.md) | Пакет, а не форк |
| [docs/adr/0002-long-running-case.md](docs/adr/0002-long-running-case.md) | Дело на месяцы — не эпизод агента |
| [docs/adr/0003-product-placement.md](docs/adr/0003-product-placement.md) | Какие правила остаются в ядре |
| [AUDIT.md](AUDIT.md) | Что проверено на этой машине |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | Открытые и закрытые границы среза |
| [SECURITY.md](SECURITY.md) | Как сообщать об уязвимости |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Как устроена правка |
| [RELEASE_POLICY.md](RELEASE_POLICY.md) | Как двигается пин |

## Лицензия

[MIT](LICENSE)
