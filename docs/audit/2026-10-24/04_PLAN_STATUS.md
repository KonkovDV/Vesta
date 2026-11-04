# Статус плана 02 относительно дерева, 2026-11-04

План — `02_WORK_PLAN_FOR_AI.md`. Здесь сверено, что из него есть в дереве после коммита `05e566b` (2.18.3), и чем это проверено. Строка без теста или команды — не заявление.

Среда этого прохода: Node 24.22.1, PostgreSQL 16.15 с pgvector 0.8.1 (собран из исходников), Redis 7.0.15, Linux. CI использует `pgvector/pgvector:pg17`. Workflow запускается на push в `main` и на pull request. У ветки этого прохода нет PR, поэтому GitHub Actions на этих коммитах не запускался.

## Задачи плана

| Задача | Статус | Коммиты | Проверка | Что осталось |
| --- | --- | --- | --- | --- |
| Фаза 0 | сделано | `4489884` (2.10.0) | CHANGELOG 2.10.0 | — |
| T1.1 Redis Streams | сделано, кроме умолчания | `5508ed7` (2.13.0) | `tests/integration/redis-streams-bus.test.ts` | `EVENT_BUS_TRANSPORT=streams` по умолчанию — мажорная версия и решение владельца. MP-K22 |
| T1.2 читатели журнала в порядке коммитов | сделано | `f34e352` (2.11.0), `0e7e1da` (2.17.0) | `tests/integration/event-commit-order.test.ts`, `tests/unit/semantic-embedding-worker.test.ts`. Ни один потребитель ядра не читает по gsn; `heldSince` и `event_consumer_lag_seconds` | `idle_in_transaction_session_timeout` — настройка роли БД, ядро её не ставит (`docs/limitations.md`) |
| T1.3 DDL вне старта | сделано | `281bf17` (2.14.0), `8665d0f` (2.16.0), `a3e6c17` (2.16.1) | `tests/integration/runtime-tables.test.ts`: событийный триггер `ddl_command_start` после migrate записал 0 команд (до правки — 15 от четырёх хранилищ). 20 параллельных стартов на одной БД: 20 из 20, 0 DDL в логе (`log_statement=ddl`), 0 ошибок `pg_type_typname_nsp_index` | — |
| T1.4 scope продуктовых маршрутов | сделано | `f34e352` (2.11.0) | `tests/unit/product-route-scopes.test.ts` | — |
| T1.5 MCP HTTP | сделан вариант A | `162364d`, `f1bf39b` (2.15.0) | `tests/unit/mcp-http-mount.test.ts` | OAuth 2.1 для MCP не реализован |
| T1.6 ожидаемая версия на пути outbox | сделано, кроме UoW | `f34e352` (2.11.0), `cdd4792` (2.12.3), `681a64f` (2.16.2) | `tests/integration/outbox-delivery.test.ts`, `tests/integration/repository-version-race.test.ts`: 10 параллельных пар сохранений одной версии — до правки каждая пара коммитила дважды, после — ровно один раз, второе сохранение получает `CONFLICT` | `PostgresUnitOfWork` не сравнивает версию и перенумеровывает. MP-K40 |
| T1.7 гейты CI | сделано | `72e3d08` (2.12.2), `1cebed5` | `tests/unit/ci-gates.test.ts`; `scripts/ci-resolve-all.cjs`, `scripts/ci-routes-auth.cjs` | — |
| T2.1 сократить ядро по ADR-0003 | не начато | — | — | `decision: owner`. MP-K36, MP-K37, MP-K38 |
| T2.2 явная идемпотентность | сделано | `8d3f624` (2.18.0), `b4236b9` | `tests/unit/retry-aspect.test.ts`: непомеченный метод не повторяется ни при какой ошибке, помеченный — только при транзиентной | Помечены два GET реестра образов. `Idempotency-Key` для x402 не добавлен |
| T2.3 типизированный DI | не начато | — | — | 367 зарегистрированных токенов, codemod |

## Найдено и исправлено по ходу

| ID | Что было | Коммит | Проверка |
| --- | --- | --- | --- |
| MP-K43 | Проба записи в проверке ФС называлась по `Date.now()`: 1 из 20 параллельных стартов останавливался на критической проверке | `a3e6c17` (2.16.1) | `tests/unit/filesystem-check.test.ts` |
| MP-K45 | `PostgresAdapter.transaction`: `SERIALIZABLE` выполнялся на READ COMMITTED, таймаут транзакции оставался на соединении пула | `adc2d80` (2.16.3) | `tests/integration/postgres-adapter-transaction.test.ts` |
| MP-K25 | `StructuredLogger` игнорировал `LOG_LEVEL` и придумывал стек для ошибки без стека. Ответ 401: 1752 байта лога до правки, 581 при `LOG_LEVEL=info` | `942523e` (2.18.1) | `tests/unit/structured-logger-level.test.ts` |
| MP-K46 | `RedisAdapter.existsMany` читал счётчик `EXISTS` как битовую маску | `95f02ec` (2.18.2) | `tests/integration/redis-adapter-exists.test.ts` |
| — | Аудит production-зависимостей падал на неизменённом дереве: две high-уязвимости в `follow-redirects` и `systeminformation` | `05e566b` (2.18.3) | `npm audit --omit=dev --audit-level=high` — код 0; 7 moderate остаются |

Открыто по ходу: MP-K44 — `PostgresResearchReportRepository.findById` всегда падает, `rehydrate` работает.

## Прогоны на `05e566b`

| Команда | Результат |
| --- | --- |
| `npm run typecheck` | код 0 |
| `npm test` | 97 из 97 |
| `npm run test:integration` (PostgreSQL 16.15 + pgvector 0.8.1, Redis 7.0.15) | 22 из 22 |
| `npm run build` | код 0 |
| `migrate-cli` на пустой БД, дважды | `3 succeeded`, затем `0 succeeded, 0 failed, 3 skipped` |
| `migrate-cli` на БД версии 2.15.0 | `1 succeeded, 0 failed, 2 skipped` |
| `node scripts/ci-resolve-all.cjs` | `registered=367 failed=27 budget=27 unexpected=0` |
| `node scripts/ci-routes-auth.cjs` | `total=58 protected=51 unexpected=0` |
| `npm audit --omit=dev --audit-level=high` | код 0 |

Не проверялось: сборка Docker-образа, PostgreSQL 17, реальные провайдеры моделей, установка пакета с github.com.

## Промт следующего прохода

```text
Ты работаешь в репозитории KonkovDV/Vesta (пакет microphoenix), база — последний коммит ветки
с этим файлом (2.18.3). Вход: docs/audit/2026-10-24/02_WORK_PLAN_FOR_AI.md, этот файл (04),
KNOWN_ISSUES.md, docs/claims.md, docs/limitations.md, AGENTS.md.

0. Среда: Node 24, PostgreSQL ≥ 16 с pgvector ≥ 0.8, Redis 7. Базовая линия, вывод сохранить:
   npm ci --ignore-scripts; npm run typecheck; npm test; npm run build; migrate дважды на пустой БД;
   npm run test:integration; node scripts/ci-resolve-all.cjs; node scripts/ci-routes-auth.cjs;
   npm audit --omit=dev --audit-level=high. Красное до правок — записать и остановиться.
1. Спросить владельца, прежде чем трогать: T1.1 (streams по умолчанию, мажорная версия),
   T2.1 (вынос healthcare/hr/sales/research/x402 из ядра), судьбу MP-K44 (research в ядре или нет).
2. Без решения владельца, по порядку:
   a. T1.6 остаток: PostgresUnitOfWork — версия по агрегату, если её знает вызывающий,
      иначе транзакционная блокировка агрегата (lockAggregateForWrite) до записи. Тест — гонка,
      как в tests/integration/repository-version-race.test.ts.
   b. T2.3 по шагам: InjectionToken<T> и типизированный resolve рядом со строковыми; перевести
      токены одного модуля; тест-фикстура, на которой tsc ловит несовпадение типа; потолок
      строковых resolve в CI — только вниз.
   c. MP-K35: LLMAdapterFactory при USE_MOCK_AI=true. Бюджет tests/gates/resolve-all-budget.json —
      только уменьшать.
   d. T2.4 из реестра 03: V-45 (/health/migration без ключа), V-46 (SSRF при загрузке → 4xx, не 500).
3. Каждая задача: сначала тест, падающий на текущем коде, показать падение, потом исправление.
   Не ослаблять проверки, не удалять тесты, не расширять public-routes.json.
4. Одна задача — один коммит. В каждом: CHANGELOG, KNOWN_ISSUES, claims/limitations, если меняется
   заявление; версия в package.json, package-lock.json, Dockerfile, README, README_RU.
5. Перед каждым коммитом зелёные: typecheck, npm test, test:integration, build. После последнего —
   migrate дважды, оба CI-гейта, аудит. Обновить этот файл. Push в рабочую ветку, PR не открывать.
```
