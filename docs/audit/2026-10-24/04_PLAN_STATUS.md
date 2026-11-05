# Статус плана 02 относительно дерева, 2026-11-05

План — `02_WORK_PLAN_FOR_AI.md`. Здесь сверено, что из него есть в дереве версии 4.2.0, и чем это проверено. Строка без теста или команды — не заявление.

Среда проходов 2026-11-04 и 2026-11-05: Node 24.22.1, PostgreSQL 16.15 с pgvector 0.8.1 (собран из исходников), Redis 7.0.15 и Redis 8.10.3 (собран из исходников), Linux. CI использует `pgvector/pgvector:pg17` и с 3.0.0 — `redis:7-alpine` и `redis:8.10-alpine`. Workflow запускается на push в `main` и на pull request.

## Решения, принятые по поручению владельца (2026-11-05)

| Вопрос | Решение | Почему | Где записано |
| --- | --- | --- | --- |
| T1.1: Streams по умолчанию | Да, в 3.0.0. Pub/Sub — только `EVENT_BUS_TRANSPORT=pubsub` | Pub/Sub теряет публикацию без подписчика, и гарантия outbox обрывалась на Redis. С Redis 8.2 обрезка `ACKED` не трогает неподтверждённые записи, с 8.6 `IDMP` убирает дубли повторной публикации | ADR-0004 |
| T2.1: продуктовые домены в ядре | Шаг 1 в 4.0.0: каждый домен выключен, пока не задан `MODULE_<NAME>_ENABLED=true`. Шаг 2 — перенос каждого в репозиторий продукта как `KernelExtension` | Strangler fig: малые обратимые шаги без остановки системы, ядро сначала отделяется флагом, потом кодом | ADR-0005 |
| MP-K44 | Исправлено в 4.0.1, не дожидаясь шага 2 | `findById` и `find` возвращали ошибку на любой сохранённый отчёт; при включённом домене это поломка | `KNOWN_ISSUES.md` |
| `PostgresUnitOfWork` | Ожидаемая версия на каждый агрегат в одной пачке (4.1.0) | Так устроена атомарная запись в несколько потоков с ожидаемой ревизией на поток в KurrentDB 25.1 | `KNOWN_ISSUES.md` MP-K40 |
| T2.3 | Шаг 1 в 4.2.0: `InjectionToken<T>`, `inject`/`provide`, потолок строковых `resolve` в CI | Типизированный токен с фантомным типом — общий приём TypeScript-контейнеров; одна строка в рантайме позволяет переводить модули по одному | `KNOWN_ISSUES.md` MP-K48 |

## Задачи плана

| Задача | Статус | Коммиты | Проверка | Что осталось |
| --- | --- | --- | --- | --- |
| Фаза 0 | сделано | `4489884` (2.10.0) | CHANGELOG 2.10.0 | — |
| T1.1 Redis Streams | сделано | `5508ed7` (2.13.0), `3ab765a` (3.0.0) | `tests/integration/redis-streams-bus.test.ts` на Redis 7 и 8.10, `tests/unit/event-bus-transport.test.ts`. На Redis 8.10.3 группа, не прочитавшая ничего, сохранила 400 из 400 записей при пределе 10; прежний вызов — 100 | На Redis старше 8.2 отставшая больше `EVENT_BUS_STREAM_MAXLEN` группа теряет старые записи |
| T1.2 читатели журнала в порядке коммитов | сделано | `f34e352` (2.11.0), `0e7e1da` (2.17.0) | `tests/integration/event-commit-order.test.ts`, `tests/unit/semantic-embedding-worker.test.ts` | `idle_in_transaction_session_timeout` — настройка роли БД |
| T1.3 DDL вне старта | сделано | `281bf17`, `8665d0f`, `a3e6c17` | `tests/integration/runtime-tables.test.ts`: 0 DDL-команд после migrate; 20 из 20 параллельных стартов | — |
| T1.4 scope продуктовых маршрутов | сделано | `f34e352` (2.11.0) | `tests/unit/product-route-scopes.test.ts` | — |
| T1.5 MCP HTTP | сделан вариант A | `162364d`, `f1bf39b` (2.15.0) | `tests/unit/mcp-http-mount.test.ts` | OAuth 2.1 для MCP не реализован |
| T1.6 ожидаемая версия | сделано | `f34e352`, `cdd4792`, `681a64f` (2.16.2), `6109381` (4.1.0) | `tests/integration/repository-version-race.test.ts`, `tests/integration/unit-of-work-versions.test.ts`, `tests/integration/outbox-delivery.test.ts` | События с версией 0 по-прежнему дописываются в конец |
| T1.7 гейты CI | сделано | `72e3d08`, `1cebed5`, `48dc826` | `tests/unit/ci-gates.test.ts`; гейты гоняются с доменами по умолчанию и со всеми включёнными | — |
| T2.1 сократить ядро | шаг 1 сделан | `48dc826` (4.0.0) | `tests/unit/product-domains.test.ts`. С флагами по умолчанию: 327 токенов вместо 367, 50 маршрутов вместо 58 | Шаг 2: код доменов уходит из графа импортов; RSS (372–394 МБ) и число модулей пока не изменились |
| T2.2 явная идемпотентность | сделано | `8d3f624` (2.18.0) | `tests/unit/retry-aspect.test.ts` | `Idempotency-Key` для x402 не добавлен |
| T2.3 типизированный DI | шаг 1 сделан | `6ce80be` (4.2.0) | `src/core/di/injection-token.typecheck.ts`, `tests/unit/injection-token.test.ts`, `scripts/ci-di-literals.cjs` | 204 вызова `resolve` со строкой; переводить модуль за модулем и снижать потолок |

## Найдено и исправлено по ходу

| ID | Что было | Коммит | Проверка |
| --- | --- | --- | --- |
| MP-K43 | Проба записи в проверке ФС по `Date.now()`: 1 из 20 параллельных стартов падал | `a3e6c17` (2.16.1) | `tests/unit/filesystem-check.test.ts` |
| MP-K45 | `SERIALIZABLE` выполнялся на READ COMMITTED; таймаут транзакции оставался на соединении | `adc2d80` (2.16.3) | `tests/integration/postgres-adapter-transaction.test.ts` |
| MP-K25 | `LOG_LEVEL` игнорировался, логгер придумывал стек. 401: 1752 → 581 байт при `LOG_LEVEL=info` | `942523e` (2.18.1) | `tests/unit/structured-logger-level.test.ts` |
| MP-K46 | `existsMany` читал счётчик `EXISTS` как маску | `95f02ec` (2.18.2) | `tests/integration/redis-adapter-exists.test.ts` |
| MP-K47 | pg-pool завершает `end()` раньше закрытия сокетов; ошибка в этом окне падала uncaughtException. Тест гонки падал в 1 из 4 прогонов | `f868037` (3.0.1) | `tests/unit/end-pool.test.ts`; 10 из 10 прогонов теста гонки |
| MP-K44 | `findById` и `find` research-репозитория всегда возвращали ошибку | `54d4653` (4.0.1) | `tests/integration/repository-version-race.test.ts` |
| — | Две high-уязвимости в `follow-redirects` и `systeminformation` | `05e566b` (2.18.3) | `npm audit --omit=dev --audit-level=high` — код 0 |

## Прогоны на 4.2.0

| Команда | Результат |
| --- | --- |
| `npm run typecheck` (с фикстурой типизированных токенов) | код 0 |
| `node scripts/ci-di-literals.cjs` | `count=204 max=204` |
| `npm test` | 110 из 110 |
| `npm run test:integration`, Redis 7.0.15 | 27 прошли, 2 пропущены (`ACKED`, `IDMP` требуют 8.2/8.6) |
| `npm run test:integration`, Redis 8.10.3 | 29 из 29 |
| `npm run build` | код 0 |
| `migrate-cli` на пустой БД дважды | `3 succeeded`, затем `0 succeeded, 0 failed, 3 skipped` |
| гейты, флаги доменов не заданы | `registered=327 failed=24 budget=27 unexpected=0`; `total=50 protected=43 unexpected=0` |
| гейты, все домены включены | `registered=367 failed=27 budget=27 unexpected=0`; `total=58 protected=51 unexpected=0` |
| `npm audit --omit=dev --audit-level=high` | код 0, 7 moderate |

Не проверялось: сборка Docker-образа, PostgreSQL 17 локально, реальные провайдеры моделей, установка пакета с github.com.

## Источники решений

- Redis, команда `XADD`: `KEEPREF | DELREF | ACKED` с 8.2, `IDMP | IDMPAUTO` с 8.6. https://redis.io/docs/latest/commands/xadd/
- Redis, идемпотентная обработка сообщений, умолчания `IDMP-DURATION` и `IDMP-MAXSIZE`. https://redis.io/docs/latest/develop/data-types/streams/idempotency/
- Redis, потоковая обработка: at-least-once через `XREADGROUP`/`XACK`, `XAUTOCLAIM`. https://redis.io/docs/latest/develop/use-cases/streaming/
- OneUptime, выбор между Pub/Sub и Streams в Redis (2026-01-25). https://oneuptime.com/blog/post/2026-01-25-redis-pubsub-vs-streams/markdown
- Conduktor, transactional outbox: relay at-least-once и идемпотентный потребитель. https://www.conduktor.io/glossary/outbox-pattern-for-reliable-event-publishing
- Kurrent, KurrentDB 25.1: атомарная запись в несколько потоков с ожидаемой версией на поток. https://kurrent.io/releases/kurrentdb/25-1
- Strangler-миграция малыми обратимыми шагами. https://dev.to/oluwatosinolamilekan/from-monolith-to-modular-a-strangler-migration-playbook-527p
- От модульного монолита к сервисам: модули через интерфейсы. https://dev.to/sepehr/from-monolith-to-modular-monolith-to-microservices-realistic-migration-patterns-36f2
- Типизированные токены DI: `InjectionToken<T>` в Needle DI, `createToken<T>` в SuperDI. https://jsr.io/@needle-di/core/doc, https://github.com/piex/superdi
- Цепочка поставок npm 2026: задержка свежих версий, разрешённый список install-скриптов. https://arrangeactassert.com/posts/the-package-manager-settings-that-would-have-blocked-the-axios-attack/

## Промт следующего прохода

```text
Ты работаешь в репозитории KonkovDV/Vesta (пакет microphoenix), база — последний коммит ветки
с этим файлом (4.2.0). Вход: docs/audit/2026-10-24/02_WORK_PLAN_FOR_AI.md, этот файл (04),
ADR-0004 и ADR-0005, KNOWN_ISSUES.md, docs/claims.md, docs/limitations.md, AGENTS.md.

0. Среда: Node 24, PostgreSQL ≥ 16 с pgvector ≥ 0.8, Redis 7 и Redis ≥ 8.6. Базовая линия с
   сохранённым выводом: npm ci --ignore-scripts; npm run typecheck; node scripts/ci-di-literals.cjs;
   npm test; npm run build; migrate дважды; npm run test:integration на обоих Redis; оба CI-гейта
   с флагами доменов по умолчанию и со всеми MODULE_*_ENABLED=true; npm audit --omit=dev.
1. T2.1 шаг 2 (ADR-0005): вынести один домен, начиная с наименее связанного (x402 или HR), за
   пределы графа импортов ядра: ленивый импорт внутри включённой ветки, затем пакет-расширение
   KernelExtension. Мерить загруженные модули и RSS до и после, как в ADR-0005.
2. T2.3 шаг 2: перевести на container.inject модули, которые резолвят публичные порты, снизить
   tests/gates/di-literal-budget.json до нового счёта. Потолок только вниз.
3. MP-K35: LLMAdapterFactory учитывает USE_MOCK_AI=true; бюджет resolve-all — только вниз.
4. T2.4 из реестра 03: V-45 (/health/migration без ключа), V-46 (блок SSRF при загрузке → 4xx).
5. MP-K26: штрафная блокировка лимитера при отсутствии TRUST_PROXY.
6. Каждая задача: тест, падающий на текущем коде, затем исправление. Одна задача — один коммит;
   CHANGELOG, KNOWN_ISSUES, claims/limitations, версия в package.json, package-lock.json,
   Dockerfile, README, README_RU. Перед коммитом зелёные typecheck, тесты, build. Обновить этот файл.
```
