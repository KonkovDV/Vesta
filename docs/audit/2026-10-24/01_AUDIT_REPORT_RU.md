# Аудит Vesta / MicroPhoenix kernel — триаж, Red Team, Murder Board, фактчекинг

**Объект:** `github.com/KonkovDV/Vesta`, коммит `e6814bbd7e040749a5e1ddc5e37535251f351f98` (main, 2026-10-24), пакет `microphoenix@2.9.0`.
**Результат:** 24 коммита поверх `e6814bb` (версия 2.10.0), патчи и исправленное дерево — в этом архиве.
**Дата:** 2026-10-24. **Среда проверки:** Node.js 24.22.1, PostgreSQL 16.15 + pgvector, Redis 7.0.15, Linux; TypeScript 7 (native) из lock-файла проекта.

---

## 0. Вердикт в одном абзаце

Исходный срез **не готов** к эксплуатации даже в доверенном контуре: три главных обещания README не выполняются в поставляемой конфигурации. (1) «Агентный цикл не запускает инструмент без согласия человека» — политика ядра никогда не просит согласия, а маршрута для записи решения нет (V-02). (2) «Ядро отказывается заменять свои сервисы» — глобальный DI-контейнер разрешает перезапись, и расширение молча подменяет политику инструментов (V-01). (3) «Outbox доставляет хотя бы один раз» — доставка заканчивается на Redis Pub/Sub, который теряет сообщение без подписчика (V-06). Поверх этого `RetryAspect` повторяет каждую ошибку всех адаптеров трижды, включая платежи и вызовы инструментов (V-03). После 24 исправлений все Critical, кроме V-06 (частично), закрыты и закреплены тестами; оставшиеся открытые пункты — архитектурные (размер и состав «ядра», транспорт событий, авторизация продуктовых маршрутов) и расписаны в плане `02_WORK_PLAN_FOR_AI.md`. **Murder Board: GO для пилота в доверенном контуре после применения патчей и задач фазы 1; NO-GO для внешних пользователей и данных пациентов до закрытия V-19, V-06, V-41.**

## 1. Метод и границы

| Что делалось | Как |
| --- | --- |
| Чтение документации | README, AGENTS, AUDIT, KNOWN_ISSUES, CHANGELOG, RELEASE_POLICY, SECURITY, CONTRIBUTING, `docs/*`, 3 ADR, литературная карта |
| Сплошной статический анализ | ts-morph по всем 989 файлам: строки, классы, 5 492 функции и метода (длина, цикломатическая сложность, параметры), межслойные импорты, опасные паттерны. Выход: `evidence/layers.json`, `evidence/functions.csv`, `evidence/hazards.json` |
| Ручной разбор | ядро и загрузка, DI, агентный цикл, ToolRegistry и политика, event store, outbox, Redis-шина, миграции, SSRF, HTTP-слой и аутентификация, плагины, инструменты агента, адаптер Anthropic, MCP клиент/сервер, все 19 мест SQL-интерполяции |
| Запуск | сборка и typecheck; ядро против PostgreSQL+Redis; миграции дважды; установка как git-зависимость; разрешение **всех 366** DI-токенов; обход **всех 61** HTTP-маршрута без учётных данных; 15 проб воспроизведения (`probes/`) |
| Проверка исправлений | 57 юнит- и 9 интеграционных тестов; на исходном коде из нового набора проходят 3 из 57 (`evidence/red-green-baseline.txt`); повтор проб на исправленной сборке |

**Не проверено (честно):** достижимость loopback через IPv4-mapped IPv6 на уровне сокета (в песочнице нет IPv6 — проверен валидатор); сборка Docker-образа; установка с github.com (проверена установка из `git+file://` того же коммита); реальные LLM-провайдеры; статус GitHub Actions (API недоступен из песочницы); глубокая логика модулей MAS, healthcare, research, graph-memory (~110 тыс. строк) — по ним только сплошной анализ и маршруты.

## 2. Сводка триажа

| Критичность | Исправлено | Частично | Открыто | Всего |
| --- | --- | --- | --- | --- |
| Critical | 5 | 1 | 0 | 6 |
| High | 12 | 2 | 1 | 15 |
| Medium | 6 | 6 | 11 | 23 |
| Low | 2 | 0 | 5 | 7 |
| **Итого** | **25** | **9** | **17** | **51** |

Критерии: **Critical** — нарушает заявленный инвариант безопасности/корректности или даёт выполнение кода / двойной побочный эффект; **High** — эксплуатируемо при реалистичных условиях или ломает функцию целиком; **Medium** — надёжность, производительность, гигиена безопасности; **Low** — качество и информационные утечки.

## 3. Архитектура по слоям

### 3.1 Масштаб

| Показатель | Значение |
| --- | --- |
| TypeScript-файлов / строк | 989 / 200 659 |
| Функций и методов | 5 492 (медиана сложности 2; 526 длиннее 50 строк; 111 длиннее 100; 112 со сложностью >15; 15 со сложностью >30) |
| Модулей, загружаемых при старте (граф `require` от `dist/index.js`) | 729 из 982 |
| DI-токенов, зарегистрированных во время работы | 366 (не разрешаются 27 — `evidence/resolve-all-*.txt`) |
| Пулов PostgreSQL / клиентов Redis в коде | 5 / 7 |
| RSS в простое / время до `/health/live` | ≈360 МБ / 2,9–4,1 с |
| HTTP-маршрутов | 61 (36 требуют ключ, 7 открыты: health, `/metrics` вне prod, `/health/migration`, Slack-вебхук) |
| Установка как git-зависимость | 291 с, 1,1 ГБ `node_modules`, 7 пакетов с install-скриптами |

### 3.2 Слои

| Слой | Файлов | Строк | Классов | Пустых catch | console.* | process.env |
| --- | --- | --- | --- | --- | --- | --- |
| infrastructure | 361 | 98899 | 325 | 79 | 228 | 78 |
| domain | 317 | 42386 | 109 | 2 | 48 | 1 |
| application | 153 | 34382 | 114 | 90 | 10 | 3 |
| core | 77 | 12966 | 41 | 5 | 44 | 1 |
| memory | 22 | 5380 | 19 | 15 | 3 | 0 |
| monitoring | 8 | 2228 | 0 | 24 | 0 | 0 |
| config | 12 | 1012 | 2 | 0 | 7 | 9 |
| presentation | 17 | 965 | 11 | 0 | 0 | 0 |
| protocol | 2 | 812 | 1 | 0 | 0 | 0 |
| ai-types | 1 | 603 | 0 | 0 | 0 | 0 |
| kernel | 1 | 326 | 1 | 0 | 11 | 0 |
| plugins | 6 | 307 | 3 | 0 | 0 | 0 |
| types | 7 | 191 | 0 | 0 | 0 | 0 |
| integration | 3 | 158 | 2 | 0 | 0 | 0 |

### 3.3 Направления зависимостей

| Направление импорта | Импортов значений | Оценка |
| --- | --- | --- |
| infrastructure -> domain | 219 | ожидаемо |
| infrastructure -> core | 215 | ожидаемо |
| application -> domain | 94 | ожидаемо |
| application -> core | 59 | ожидаемо |
| domain -> core | 59 | допустимо для утилит/типов, проверить отсутствие DI/конфига |
| infrastructure -> application | 46 | допустимо (адаптеры реализуют порты приложения), но 46 — много |
| infrastructure -> config | 37 | ожидаемо |
| infrastructure -> monitoring | 23 | ожидаемо |
| application -> monitoring | 19 | ожидаемо |
| presentation -> application | 11 | ожидаемо |
| infrastructure -> memory | 10 | ожидаемо |
| presentation -> core | 10 | ожидаемо |
| core -> config | 9 | спорно: core должен получать конфиг через DI |
| presentation -> domain | 9 | ожидаемо |
| plugins -> domain | 7 | ожидаемо |
| application -> protocol | 6 | ожидаемо |

Импортов `domain → infrastructure/application/presentation` нет — это заслуга проекта. Нарушения — в периферийных папках (`memory`, `monitoring`, `infrastructure → presentation`) и в зависимости `core` от `config`.

### 3.4 Самые сложные функции (кандидаты на декомпозицию)

| Сложность | Строк | Функция |
| --- | --- | --- |
| 71 | 709 | `registerSota2026MultiAgentModule` — `infrastructure/di/modules/sota-2026-multiagent.module.ts:165` |
| 64 | 252 | `buildMasSessionFailedDiagnostics` — `application/agents/events/mas-events.ts:384` |
| 55 | 190 | `loadConfigFromEnv` — `config/index.ts:46` |
| 52 | 392 | `ContextCoordinatorV1.getContextWindow` — `application/agents/impl/context-coordinator-v1.ts:104` |
| 46 | 388 | `KuzuCodeGraphAdapter.ingestRepository` |
| 44 | 373 | `TaskOrchestrator.executeWrapper` |
| 34 | 336 | `PostgresEventStore.saveEvents` |

Полный список — `evidence/functions.csv` (слой, файл, строка, имя, длина, параметры, сложность).

### 3.5 Наблюдения по слоям

- **core.** Глобальный синглтон-контейнер с разрешённой перезаписью (V-01); два DI-механизма — собственный контейнер и декораторы inversify, причём inversify-метаданные в боевой связке не используются (V-40); AOP по маскам имён классов (`*Adapter`, `*Service`) превращает соглашение об именовании в политику повторов и логирования (V-03, V-25).
- **config.** Схема приводит типы (`z.coerce`), а читатели ждут строки (V-16); разбор без кэша на горячих путях (V-26); `JWT_SECRET` обязателен, но не используется (V-43).
- **domain.** Чистый по зависимостям, но содержит продуктовые домены (`healthcare`, `research`, `a2a`/x402) вопреки ADR-0003 (V-41).
- **application.** Агентный цикл спроектирован грамотно (журнал, spill-файлы, хеш набора инструментов, проверка версий), но без захвата исполнения, без устойчивого восстановления и без включённого HITL (V-02, V-04, V-07). Политика инструментов: коллизия алиасов с deny-листом (V-18), профиль по префиксу имени агента (V-48).
- **infrastructure.** Сильные стороны: параметризованный SQL (19 интерполяций проверены — инъекций нет), `IdGenerator` на `crypto`, пиннинг DNS в загрузке документов. Слабые: транспорт Pub/Sub (V-06), outbox без backoff/fencing (V-15), DDL при старте с гонкой (V-28), «песочницы» на `node:vm` и `new Function` (V-05, V-33), мёртвые защитные компоненты (V-31).
- **presentation.** Продуктовые маршруты HR/продаж/медицины без scope (V-19); MCP-сервер смонтирован после 404 (V-20).
- **plugins.** Все три стандартных плагина не загружались (V-12) и все три были небезопасны (V-05, V-13).

## 4. Триаж — полный реестр

Машиночитаемая версия: `03_findings.json` (поля: id, severity, layer, category, status, evidence, files, fix_commit, test, known_issue, owasp, plan_task, red_team).

### Critical

| ID | Слой | Суть | Как подтверждено | Статус | Тест / задача |
| --- | --- | --- | --- | --- | --- |
| V-01 | core/kernel | Расширение может молча заменить любой токен ядра, включая IToolExecutionPolicy: глобальный контейнер создан с setAllowOverrides(true); unregister доступен | runtime probe: probes/di-override.cjs → policy=extension | fixed | tests/unit/kernel-extensions.test.ts · MP-K11 |
| V-02 | application/security | Human-in-the-loop не срабатывает никогда: поставляемая ToolPolicyService не возвращает requiresApproval ни для одного инструмента; маршрута записи решения нет | runtime probe: probes/policy.cjs — requiresApproval=false для всех 11 комбинаций; grep decideApproval — 0 вызовов | fixed | tests/unit/tool-policy-service.test.ts, tests/unit/agent-run-routes.test.ts · MP-K27, MP-K28 |
| V-03 | core/aop | RetryAspect повторяет любой метод любого *Adapter/*Repository 3 раза при любой ошибке: платежи x402, исполнение инструментов, MCP-вызовы выполняются повторно; каждый 401 — 300 мс | runtime probe: probes/retry-dup.cjs → 3 побочных эффекта на 1 вызов; curl 401 = 0,33 с | fixed | tests/unit/retry-aspect.test.ts · MP-K13 |
| V-04 | application/agents | Одобренный инструмент выполняется дважды при параллельном resume(): нет оптимистичной блокировки потока | runtime probe: probes/agent-run.cjs → pay executed 2 time(s) | fixed | tests/unit/agent-run-service.test.ts, tests/integration/agent-run-postgres.test.ts · MP-K12 |
| V-05 | plugins | code_execute исполняет код в node:vm: console.log.constructor("return process")() возвращает хостовый process (uid 0) → RCE. Латентно: спасал только баг V-12 | runtime probe: probes/vm-escape.cjs → escaped: pid, uid=0 | fixed | tests/unit/standard-plugins.test.ts · MP-K17 |
| V-06 | infrastructure/events | Шина — Redis Pub/Sub: outbox помечает строку PUBLISHED, когда Redis принял сообщение, даже без подписчиков; at-least-once (C5) обрывается на Redis | runtime probe: вставка в outbox → PUBLISHED при PUBSUB CHANNELS = пусто | partly fixed | tests/integration/redis-bus-strict.test.ts · MP-K22 |

### High

| ID | Слой | Суть | Как подтверждено | Статус | Тест / задача |
| --- | --- | --- | --- | --- | --- |
| V-07 | application/agents | После сбоя посреди инструмента или удержания одобрения посреди нескольких tool-call модель получает tool_use без tool_result → провайдер отвечает 400, прогон умирает | runtime probe: probes/agent-run.cjs — транскрипты assistant[a,b,c] tool<a> tool<b>; assistant[k] | fixed | tests/unit/agent-run-service.test.ts · MP-K12 |
| V-08 | application/agents | BOLA: любой ключ с agents.run читает поток событий любого прогона; любой ключ отменяет любой run id (и создаёт поток для несуществующего) | code reading + test | fixed | tests/unit/agent-run-routes.test.ts · MP-K19 |
| V-09 | application/agents | Политика оценивает сырые аргументы, а инструмент получает аргументы после схемы и санитизации (TOCTOU); человек одобряет сырые аргументы без значений по умолчанию | test: default recipient виден только после схемы | fixed | tests/unit/tool-registry.test.ts, tests/unit/agent-run-service.test.ts |
| V-10 | application/agents | Вывод инструмента может закрыть ограду </untrusted> и писать «вне данных» (spotlighting обходится одной строкой) | runtime probe: probes/agent-run.cjs п.4 | fixed | tests/unit/agent-run-service.test.ts |
| V-11 | infrastructure/security | SSRF-guard при blockIpv6:false пропускает [::ffff:127.0.0.1], NAT64, 6to4, IPv4-compatible, site-local, 198.18/15, 192.0.0/24; pinnedExchange читает тело без лимита; pinned fetch пересылает Authorization при межорigin-редиректе | runtime probe: probes/ssrf.cjs (8 ALLOWED). Достижимость сокета через IPv6 не проверена: в песочнице нет IPv6 | fixed | tests/unit/ssrf.test.ts · MP-K14 |
| V-12 | infrastructure/plugins | Ни один стандартный плагин не загружается (в DI под IPluginRegistry другой класс без getPlugin), хотя MP-K2 отмечен «closed» | runtime probe: лог ядра «this.registry.getPlugin is not a function» ×3 | fixed | tests/unit/standard-plugins.test.ts + живая загрузка · MP-K16 |
| V-13 | plugins | file-system: префиксная проверка (sandbox/fs-other) и симлинки; web-browser: file://, приватные адреса, Chrome с --no-sandbox | test | fixed | tests/unit/standard-plugins.test.ts · MP-K18 |
| V-14 | application/agents/tools | read_file выходит из workspace через симлинк на каталог (прочитан /etc/hostname); читает файл целиком без лимита | runtime probe: probes/readfile.cjs → content "vm" | fixed | tests/unit/workspace-read-file.test.ts · MP-K18 |
| V-15 | infrastructure/events | Outbox: повтор без backoff, «ядовитое» сообщение по истёкшей аренде крутится вечно, отметка без fencing-токена, v2 агрегата может уйти раньше v1 | test (PostgreSQL 16) | fixed | tests/integration/outbox-delivery.test.ts · MP-K21 |
| V-16 | core/config | REDIS_PORT/REDIS_DB игнорируются (z.coerce.number() против readInt, принимающего только строки): ядро не стартует на нестандартном порту Redis | runtime probe: «Cache is not available», ECONNREFUSED 127.0.0.1:6379 при REDIS_PORT=56379 | fixed | tests/unit/app-config.test.ts · MP-K15 |
| V-17 | infrastructure/events | Читатель по GSN пропускает событие, чья транзакция взяла меньший gsn и закоммитилась позже | runtime probe: probes/gsn-skip.cjs → SKIPPED gsn=6 | partly fixed | tests/integration/event-commit-order.test.ts · MP-K23 |
| V-18 | application/security | bash и python всегда запрещены: алиас exec совпадает с записью глобального deny-листа | runtime probe: probes/policy.cjs → allowed=false | fixed | tests/unit/tool-policy-service.test.ts · MP-K29 |
| V-19 | presentation/http | BFLA: маршруты sales/hr/healthcare (включая MRI second opinion) проверяют только аутентификацию, без scope | runtime probe: ключ со scope agents.run дошёл до валидации обработчика healthcare | open | план T1.4 · MP-K32 |
| V-20 | infrastructure/http | MCP HTTP-сервер берёт agentId политики из URL (:clientName): researcher-* → профиль full. Латентно: маршруты отвечают 404 (смонтированы после 404-обработчика) | runtime probe: /api/mcp/* → 404 при логе mcp_http_routes_mounted | partly fixed | план T1.5 · MP-K30, MP-K31 |
| V-21 | infrastructure/mcp | Исходящий MCP (SSE/streamable HTTP) не закреплён на проверенных адресах | test | fixed | tests/unit/mcp-consumer-pin.test.ts · MP-K10 |

### Medium

| ID | Слой | Суть | Как подтверждено | Статус | Тест / задача |
| --- | --- | --- | --- | --- | --- |
| V-22 | application/http | Метки метрик — сырой путь: одна серия на каждый run id (+60 серий за 60 запросов); /metrics без аутентификации вне production | runtime probe: до +60, после +1 | fixed | tests/unit/http-identity.test.ts · MP-K20 |
| V-23 | application/services | API-ключ в query-строке принимается вне production и пишется в лог открытым текстом | runtime probe: ключ найден в логе | fixed | tests/unit/http-identity.test.ts · MP-K20 |
| V-24 | application/http | Ключ лимитера — первый хоп X-Forwarded-For (подделывается клиентом); «штрафная коробка» банит по req.ip на 10 мин — за прокси без TRUST_PROXY банит всех | code reading + test | partly fixed | tests/unit/http-identity.test.ts · MP-K26 |
| V-25 | core/aop | Усиление логов: ~4,2 КБ и запись «урока об ошибке» в БД на каждый неаутентифицированный запрос | runtime probe: 4219 → 2237 байт/запрос | partly fixed | tests/unit/logging-aspect.test.ts · MP-K25 |
| V-26 | config | getConfig() без кэша: полный Zod-разбор process.env ≈209 мкс на вызов, вызывается с горячих путей | runtime probe: 209 мкс → 0,3 мкс | fixed | tests/unit/app-config.test.ts |
| V-27 | infrastructure/database | Раннер миграций продолжает после ошибки, нет lock_timeout, «empty» вместо «skipped»; разбиение CONCURRENTLY-файлов по «;», журнал по basename, lock id 1337 | test | partly fixed | tests/unit/migration-runner.test.ts · MP-K6 |
| V-28 | infrastructure | DDL во время старта из нескольких компонентов: гонка (duplicate key pg_type_typname_nsp_index), 7 таблиц вне миграций, нужны DDL-права у приложения | runtime probe: лог старта | open | план T1.3 · MP-K24 |
| V-29 | infrastructure/di | USE_MOCK_AI=true не заглушает модель агентного цикла: при ANTHROPIC_BASE_URL идут реальные вызовы | runtime probe: agent_model_error ×3 в mock-режиме | fixed | живой прогон → completed · MP-K33 |
| V-30 | infrastructure/di | 27 из 366 токенов не разрешаются в mock-режиме, 24 — «No LLM providers configured» (включая IOutputGuardrailPipeline) | runtime probe: evidence/resolve-all-*.txt | open | план T2.3 · MP-K35 |
| V-31 | infrastructure/security | Мёртвая защита: 19 «защитных» токенов никто не запрашивает (firewall не передан в ToolRegistry, guardrails, sanitization, HMAC-«анклав», TEE-верификатор) | runtime probe + scan: evidence/di-consistency.json | open | план T2.1 · MP-K36 |
| V-32 | config | TLS к БД без проверки сертификата: OUTBOX_SSL → rejectUnauthorized:false; общий хелпер по умолчанию тоже без проверки без CA | code reading | partly fixed | план T2.6 · MP-K34 |
| V-33 | infrastructure/agent-runner | Worker исполняет сгенерированный код через new Function + with(context) в worker_thread с доступом к process (не изоляция; инъекции не найдено) | code reading | open | план T2.1 · MP-K37 |
| V-34 | deps | Уязвимости production-зависимостей: 4 (2 high: body-parser, undici), multer 1.x | runtime probe: npm audit 4 → 0 | fixed | CI: npm audit --omit=dev |
| V-35 | infrastructure/adapters | Anthropic: меняющийся каталог function_results сливается в system → кэш префикса сбрасывается каждый шаг; нет cache_control; модели захардкожены | test | fixed | tests/unit/anthropic-chat-model.test.ts |
| V-36 | application/agents | SSE: полный getEvents каждые 250 мс (O(n²)), цикл не прекращался при отключении клиента | code reading | partly fixed | план T2.8 |
| V-37 | infrastructure/events | Event store: SERIALIZABLE + FOR UPDATE на каждый append; TIMESTAMP без зоны; GIN по payload/metadata и HNSW прямо на журнале (усиление записи) | code reading | open | план T2.6 |
| V-38 | infrastructure/events | Путь outbox при 23505 пересчитывает версии и повторяет — оптимистичная блокировка агрегата обходится для вызывающих с ожидаемой версией | code reading | open | план T1.6 |
| V-39 | core/bootstrap | Остановка: пул БД закрывается раньше прочих синглтонов; нет фазы «не готов» перед остановкой HTTP; сброс outbox без таймаута | code reading | open | план T2.9 |
| V-40 | core/di | Два DI-механизма (свой контейнер + inversify) и строковые токены: 356 нетипизированных resolve → класс ошибок как V-12 | code reading | open | план T2.3 |
| V-41 | architecture | Ядро нарушает собственный ADR-0003: медицина (MRI), HR, продажи, исследования, x402, «singularity/dream_state», 36 @sota-stub; 200 659 строк, 729 модулей при старте, 366 токенов, ~360 МБ RSS | runtime probe + scan: evidence/layers.json | open | план T2.1 · MP-K38 |
| V-42 | build | Установка из git: 291 с, 1,1 ГБ, 7 пакетов с install-скриптами (better-sqlite3, puppeteer, onnxruntime-node, node-pty, koffi, protobufjs, prepare) | runtime probe: git+file install | partly fixed | план T4.1 · MP-K5 |
| V-43 | application/services | JWT_SECRET обязателен, но нигде не используется; аутентификация — только API-ключи (в памяти, без хеширования для env-ключей), нет OIDC | code reading | open | план T2.5 |
| V-44 | infrastructure/adapters | 25+ захардкоженных идентификаторов моделей, часть несуществующих (claude-4-opus, claude-opus-4.6, claude-4.6-opus) | scan | open | план T3.6 |

### Low

| ID | Слой | Суть | Как подтверждено | Статус | Тест / задача |
| --- | --- | --- | --- | --- | --- |
| V-45 | application/http | /health/migration без аутентификации раскрывает внутреннее состояние rollout | runtime probe | open | план T2.4 |
| V-46 | application/memory | Блокировка SSRF при загрузке документа отвечает 500 вместо 4xx | runtime probe | open | план T2.4 |
| V-47 | core/bootstrap | Проверки целостности database/redis «проходят» за 0,17 мс — проверка отложена, отчёт вводит в заблуждение | runtime probe | open | план T2.9 |
| V-48 | application/security | Профиль инструментов выбирается по префиксу имени агента (researcher-* → full) — идентичность по метке, а не по принципалу | code reading | open | план T3.1 |
| V-49 | all | 215 пустых catch, 21 setInterval без unref, 362 console.*, 87 прямых process.env | scan: evidence/hazards.json | open | план T2.4 |
| V-50 | core/kernel | KernelStartError терял cause; имена расширений сравнивались без trim | test | fixed | tests/unit/kernel-extensions.test.ts |
| V-51 | build | Node 24 вышел из Active LTS 20.10.2026; Node 26 станет LTS 28.10.2026 — в CI только 24, тестов не было | calendar | fixed | — |

## 5. Red Team

Модель нарушителя: внешний неаутентифицированный клиент; держатель ключа с минимальным scope; контент, который агент читает (непрямая prompt-инъекция); вредоносное или ошибочное расширение/плагин; вредоносный удалённый сервер (MCP/A2A/страница); сосед по сети; цепочка поставок.

| ID | Нарушитель → вход | Техника | До (e6814bb) | После | Остаток |
| --- | --- | --- | --- | --- | --- |
| RT-1 | Расширение → `register(container)` | `register('IToolExecutionPolicy', allowAll)` или `unregister` | **Успех** (V-01, проба `di-override.cjs`) | `KernelExtensionError` | Код расширения работает в том же процессе и может изменить разрешённый объект: защита от ошибок, не песочница (формулировка C9 исправлена) |
| RT-2 | Контент страницы/файла → вывод инструмента | `</untrusted>` + «SYSTEM: …», затем вызов инструмента с побочным эффектом | **Успех**: ограда закрывается (V-10); вызов идёт без согласия (V-02) | Ограда экранируется; эффекты требуют согласия, решение привязано к хешу аргументов после схемы | Детекторы инъекций обходятся адаптивными атаками (Nasr et al., 2025) — нужен IFC/CaMeL-подход (план T3.2) |
| RT-3 | Ключ с `agents.run` | Чтение `/api/agents/runs/<чужой>/events`, отмена чужого прогона, `/api/v1/healthcare/*` | **Успех** (V-08, V-19) | Прогоны: 404 чужим | **Открыто**: продуктовые маршруты без scope (V-19) |
| RT-4 | Аноним | Подделка `X-Forwarded-For`, взрыв кардинальности метрик, усиление логов/латентности 401 | **Успех**: +60 серий/60 запросов; 4,2 КБ лога + запись в БД; 0,33 с на 401 | +1 серия; 2,2 КБ; 5–8 мс | «Штрафная коробка» банит всех за прокси без `TRUST_PROXY` (V-24); `/health/migration` открыт (V-45) |
| RT-5 | Удалённый адрес | SSRF через IPv6-формы, редирект с `Authorization`, безлимитное тело, исходящий MCP | **Успех** на валидаторе для 8 форм (V-11); MCP без пиннинга (V-21) | Блокируются; MCP закреплён | Браузер (Chrome) резолвит сам — нужен egress-прокси |
| RT-6 | Модель/плагин → исполнение кода | `node:vm`-побег, `new Function` в worker | **Успех**: хостовый `process`, uid 0 (V-05) | `code_execute` отключён | Worker с `new Function` остаётся (V-33) |
| RT-7 | Модель → файловые инструменты | Симлинк на каталог, соседний префикс | **Успех**: прочитан `/etc/hostname` (V-14); `fs-other` (V-13) | `realpath`-проверка, `O_NOFOLLOW` | TOCTOU между проверкой и открытием в spill-записи (низкий) |
| RT-8 | Сосед по сети / сбой Redis | MITM TLS к БД; потеря событий без подписчика | `OUTBOX_SSL` без проверки (V-32); потеря (V-06) | Проверка по умолчанию для outbox; строгий режим шины | Общий SSL-хелпер; транспорт Pub/Sub |
| RT-9 | Цепочка поставок | install-скрипты при git-установке, уязвимые зависимости | 4 уязвимости (2 high), multer 1.x, 7 install-скриптов | 0 уязвимостей; CI ставит с `--ignore-scripts` | Тяжёлые нативные зависимости в runtime (V-42) |
| RT-10 | Гонки | Два `resume()`, истёкшая аренда outbox, поздний коммит GSN | **Успех**: двойная оплата (V-04); v2 раньше v1; пропуск gsn=6 (V-17) | Захват через OCC; fencing; читатель по `(xid8, gsn)` | `SemanticEmbeddingWorker` читает по gsn |
| RT-11 | Ключ → MCP HTTP | `/api/mcp/researcher-x/...` выбирает профиль `full` | Латентно (маршруты 404) | `agentId` фиксирован | Решить судьбу MCP-сервера (T1.5) |

Сопоставление с OWASP Top 10 for Agentic Applications 2026: ASI01 (V-10), ASI02 (V-02, V-04, V-09), ASI03 (V-20, V-48), ASI04 (V-01, V-34, V-42), ASI05 (V-05, V-13, V-33), ASI08 (V-03), ASI09 (V-02), ASI10 (V-31). OWASP API Security 2023: API1 (V-08), API2 (V-23, V-43), API4 (V-22, V-24, V-25, V-36), API5 (V-19), API7 (V-11, V-21), API8 (V-45).

## 6. Фактчекинг заявлений проекта

| Заявление | Где | Вердикт | Доказательство |
| --- | --- | --- | --- |
| «The agent loop does not run a tool until a person grants that call» | README | **Ложно для поставки** | Политика не возвращает `requiresApproval`; маршрута решения нет (V-02). Исправлено |
| «Refuses to replace a service the kernel already registered» / «A kernel DI token cannot be replaced» | README, CHANGELOG 2.9.0 | **Ложно** | `setAllowOverrides(true)` на глобальном контейнере; проба (V-01). Исправлено |
| «`USE_MOCK_AI=true` starts a stub model client» | README, limitations | **Частично** | Только `IAIClient`; модель цикла не заглушена (V-29). Исправлено |
| «The workflow badge runs `npm run typecheck` only» | README | Верно | `ci.yml` |
| `/health/ready` = 200 при трёх флагах | README, limitations | Верно | Живой запуск |
| Глубокий импорт → `ERR_PACKAGE_PATH_NOT_EXPORTED` | README | Верно | Проверено после git-установки |
| Повторный прогон миграций пропускает базу | README, C6 | Верно | Два прогона; итог `0 succeeded` |
| C1 «One process listens» | claims | Верно, с уточнением | Процесс один, но слушают два сокета: приложение и `MetricsServer` (`METRICS_PORT`) |
| C3 «does not start a timer» | claims, README | **Частично** | Cron-таймера нет, но при старте запускаются периодические задачи: 24-часовая очистка памяти, опрос outbox, очистка лимитера |
| C4 шлюз одобрения в `ToolRegistry` | claims | Механизм верен, **не активирован** | Тест MP-K8 проходит; политика не просит одобрения (V-02) |
| C5 at-least-once | claims, ADR-0002 | **Частично** | До Redis — да; до потребителя — нет (V-06) |
| C7 пиннинг выбранных вызовов | claims | Верно | Загрузка документа блокирует адрес метаданных облака на живом процессе; MCP не закреплён — признавалось (MP-K10). Исправлено |
| MP-K2 «closed» | KNOWN_ISSUES | **Ложно на runtime** | Все 3 плагина падают при загрузке (V-12) |
| MP-K5 git-установка не выполнялась | KNOWN_ISSUES | Было верно | Выполнена: 291 с, 1,1 ГБ, импорт работает |
| MP-K8 закрыт | KNOWN_ISSUES | Верно | `tests/unit/tool-registry.test.ts` |
| «main на `8b2d8b3` зелёный (ci и CodeQL)» | AUDIT.md | **Не проверено** | Нет доступа к GitHub Actions API из этой сессии |
| «src 1718, test files 1535, LOC 296172, DI 444» | AUDIT.md | Не про этот срез (проект это оговаривает) | В срезе: 989 файлов, 200 659 строк, 0 тестов, 366 токенов |
| ADR-0003: в ядре нет покупателя/статуса/предметной области | ADR | **Нарушено кодом** | `healthcare` (MRI second opinion), `hr`, `sales`, `research`, x402 (V-41) |
| ADR-0002 инв. 3: эффект идемпотентен, доставка повторяема | ADR | **Нарушалось** | `RetryAspect` повторял записи (V-03). Исправлено |
| ADR-0002 инв. 8: полная медиация | ADR | Механизм есть; firewall не подключён | `new ToolRegistry(logger, policy)` без firewall (V-31) |
| Библиография `docs/research/long-running-case.md` (12 ссылок) | research | Верно | Saltzer & Schroeder 1975; Anderson ESD-TR-73-51; ReAct ICLR 2023; Sagas SIGMOD Record 16(3) 1987; Helland CIDR 2007 и CACM 55(5) 2012; Kleppmann 2017; Lamport CACM 21(7) 1978; Greshake et al. AISec 2023; Catala ICFP 2021; Brown–Cai–DasGupta Stat. Sci. 16(2) 2001. Уточнение: CaMeL опубликован на SaTML 2026 |

## 7. Murder Board

### 7.1 Архитектурные решения

| Решение | Вердикт | Почему | Замена |
| --- | --- | --- | --- |
| Redis Pub/Sub как шина после outbox | **Отклонить** | Нет хранения, нет подтверждения потребителем; гарантия C5 не доходит до потребителя | Redis Streams с consumer groups (`XADD`/`XREADGROUP`/`XACK`/`XAUTOCLAIM`, в проекте уже есть `MasEventsRedisStreamsProjector`) или потребители, читающие журнал по курсору коммитов |
| AOP-повторы и логирование по маскам имён классов | **Отклонить** | Имя класса не говорит об идемпотентности; повтор записи = двойной эффект | Явная пометка идемпотентности на методе; по умолчанию без повторов |
| DDL при старте приложения | **Отклонить** | Гонки, дрейф схемы, лишние права | Только миграции; `initialize()` проверяет схему |
| Строковые DI-токены + два DI-механизма | **Отклонить** | Ошибки связки не видит компилятор (V-12) | Типизированные токены (`InjectionToken<T>`), один контейнер, тест «разрешить всё» в CI |
| «Песочницы» `node:vm` / `new Function` | **Отклонить** | Документация Node: `vm` — не механизм безопасности | Только `IProcessContainer` (MXC), уже есть для bash/python |
| Профиль инструментов по префиксу имени агента | **Пересмотреть** | Метка ≠ личность | Профиль из scope аутентифицированного принципала |
| Ядро как пакет по 40-символьному SHA (ADR-0001) | **Сохранить** | Дисциплина версий верная | Публиковать собранный пакет с provenance; тяжёлые зависимости — опциональные peer |
| Таблицы claims/limitations, «limitations win» | **Сохранить** | Редкая для проекта честность границ | Каждое заявление — со ссылкой на тест (сделано для C4–C11) |
| SERIALIZABLE + `FOR UPDATE` на каждый append | **Пересмотреть** | Уникальный индекс `(aggregate_id, version)` уже даёт OCC | READ COMMITTED + `expectedVersion` |

### 7.2 Самопроверка: что Murder Board нашёл в моих собственных исправлениях

| # | Возражение | Проверка | Итог |
| --- | --- | --- | --- |
| 1 | Порядок публикации outbox по агрегату может навсегда заблокировать v2, если v1 исчерпал попытки при отключённом DLQ | Интеграционный тест | **Подтвердилось → исправлено**: блокируют только ещё доставляемые версии; «ядовитая» строка без DLQ становится терминальной |
| 2 | Эвристика «читающих» префиксов в `RetryAspect` включала `check`, а `checkLimit` списывает токен | Сканер `readonly-writes.cjs`: 32 метода с «читающим» именем пишут | **Подтвердилось → сужено** (`check/load/fetch/is` убраны, граница слова); эвристика остаётся эвристикой → план T2.2 |
| 3 | Человек одобряет сырые аргументы, исполняются аргументы после схемы | Тест со значением по умолчанию `recipient` | **Подтвердилось → исправлено**: одобряются и хешируются нормализованные аргументы. Остаток: неидемпотентные `transform` в zod |
| 4 | Защита контейнера расширения не изолирует код расширения | Анализ | **Верно → формулировка C9 исправлена** |
| 5 | Кэш `getConfig()` может пропустить переменные из `.env`, прочитанного `ConfigLoader` позже | Код | **Подтвердилось → исправлено** (`reloadConfig()` в `ConfigLoader.load`) |
| 6 | Захват вызова читает весь поток на каждый инструмент — O(n) | Анализ | Принято для прогонов ≤8 шагов; в плане — проверка версии без чтения потока |
| 7 | Читатель по `(xid8, gsn)` встаёт за любой долгой транзакцией кластера | Анализ | Задокументировано (MP-K23); в плане — `idle_in_transaction_session_timeout` и метрика задержки |
| 8 | Список инструментов, требующих одобрения, меняет поведение | Анализ | Да: `bash`/`python` из «всегда запрещено» стали «разрешено с согласием». Задокументировано, отключается `TOOL_APPROVAL_REQUIRED=` |
| 9 | Строгий режим шины ловит «нет подписчика», но не падение подписчика | Анализ | Верно → Redis Streams в фазе 1 плана |
| 10 | `STANDARD_PLUGINS` по умолчанию пуст — продукт может лишиться плагинов | Анализ | До исправления плагины не загружались вовсе, поведение не ухудшилось |

## 8. Что сделано

24 коммита (`patches/SERIES.txt`), каждый с тестом или доказательством:

| Область | Изменение |
| --- | --- |
| Ядро | Охраняемый контейнер расширений; `KernelExtension.toolPolicy` (только ужесточение); `cause` в `KernelStartError` |
| HITL | Политика требует согласия для инструментов с внешним эффектом; маршрут решения с `argumentsHash` и `decidedBy`; одно решение на вызов |
| Агентный цикл | Захват вызова через OCC (`ToolCallStarted`); устойчивое восстановление (`outcome_unknown`); отложенные вызовы; нормализованные аргументы; backoff; экранирование ограды |
| Инструменты | Политика на итоговых аргументах; запрет теневой регистрации; `read_file` по `realpath` |
| Плагины | Правильный реестр; opt-in загрузка; `code_execute` отключён; безопасные `file-system`/`web-browser` |
| Сеть | SSRF по разобранным адресам (IPv4/IPv6 спецдиапазоны); лимит тела; без учётных данных при межorigin-редиректе; пиннинг исходящего MCP |
| События | Outbox: backoff, fencing, учёт «ядовитых», порядок по агрегату; строгий режим шины; читатель журнала в порядке коммитов |
| HTTP | `req.ip`, шаблонные метки метрик, ключи не в логах, владелец прогона, SSE до отключения |
| Надёжность | Повторы только для транзиентных ошибок чтения; конфиг с кэшем и верными типами; миграции fail-fast + `lock_timeout` |
| LLM | Стабильный кэшируемый префикс Anthropic, `cache_control`, модели через env, mock-модель цикла |
| Зависимости и CI | 0 уязвимостей prod; multer 2, uuid 11; тесты, матрица Node 24/26, интеграционный job с pgvector и Redis |
| Документация | CHANGELOG 2.10.0, KNOWN_ISSUES MP-K10…MP-K38, claims C8–C11, доказательства в `docs/audit/2026-10-24/` |

### До и после

| Метрика | До (`e6814bb`) | После |
| --- | --- | --- |
| Тестов в репозитории | 0 | 57 юнит + 9 интеграционных |
| Новый набор на исходном коде | 3 из 57 проходят | 57 из 57 |
| Уязвимости prod (`npm audit --omit=dev`) | 4 (2 high) | 0 |
| Ответ на запрос без ключа | 0,33 с | 0,005–0,008 с |
| Исполнений побочного эффекта при ошибке метода адаптера | 3 | 1 |
| Исполнений одобренного вызова при двух `resume()` | 2 | 1 |
| Новых серий метрик на 60 разных run id | 60 | 1 |
| Лог на один 401 | 4 219 Б + запись «урока» в БД | 2 237 Б |
| `getConfig()` | 209 мкс | 0,3 мкс |
| Старт при `REDIS_PORT≠6379` | не стартует | стартует |
| Загруженных стандартных плагинов | 0 из 3 | 3 из 3 (при `STANDARD_PLUGINS`) |
| Инструментов, требующих согласия | 0 | все с внешним эффектом (14 имён/групп) |
| `bash`/`python` | всегда запрещены | разрешены с согласием |
| SSRF-форм из пробы, прошедших валидатор | 8 | 0 |
| Пропуск события читателем журнала | есть (gsn 6) | нет (новый читатель) |
| API-ключ в логе | да | нет |

Время старта (4,1 → 2,9 с) измерено единичными запусками и шумит; утверждать улучшение нельзя без серии замеров.

## 9. Сопоставление с актуальными исследованиями и практиками

- **Защита агентов от инъекций.** CaMeL (Debenedetti et al., «Defeating Prompt Injections by Design», SaTML 2026) выводит поток управления и данных из доверенного запроса и не даёт недоверенным данным менять действия; «The Attacker Moves Second» (Nasr, Carlini и др., arXiv:2510.09023, 2025) обходит 12 опубликованных защит с успехом >90% адаптивными атаками. Вывод для ядра: эвристические сканеры (`PromptInjectionScanner`) — не граница; граница — детерминированная политика на аргументах, согласие человека на эффекты и, следующим шагом, отслеживание происхождения данных (план T3.2). Обзор детерминированных слоёв CaMeL/FIDES/Progent — препринт arXiv:2606.26479 (не рецензирован).
- **Таксономия рисков.** OWASP Top 10 for Agentic Applications 2026 (декабрь 2025) — карта ASI01–ASI10 в разделе 5.
- **Порядок событий в PostgreSQL.** `gsn` из последовательности видим только при коммите; стандартное решение — `xid8` и граница `pg_snapshot_xmin(pg_current_snapshot())` с курсором по `(tx_id, позиция)` (Event-Driven.io «How Postgres sequences issues can impact your messaging guarantees»; документация PostgreSQL, системные функции). Реализовано (миграция 003).
- **Устойчивое исполнение агентов.** Подход Temporal/DBOS — фиксировать шаг до и после эффекта и восстанавливаться с последнего завершённого — соответствует `ToolCallStarted`/`ToolCallCompleted` и журналированию `outcome_unknown` (идея Helland о неопределённом исходе).
- **MCP.** Спецификация 2025-11-25 закрепила OAuth 2.1 для удалённых серверов; описания инструментов из `tools/list` не подписаны — отсюда «отравление» и «rug pull» (план T3.5: фиксация хеша определений).
- **Цепочка поставок npm.** Волны Shai-Hulud (2025) и последующие (2026) шли через lifecycle-скрипты, включая `prepare` git-зависимостей; рекомендации — `--ignore-scripts` в CI, явный allowlist скриптов, задержка новых версий (pnpm `minimumReleaseAge`). npm, поставляемый с Node 24.22, уже требует одобрения install-скриптов (наблюдалось при git-установке).
- **Наблюдаемость.** Семантические конвенции OpenTelemetry GenAI (`invoke_agent`, `execute_tool`) всё ещё в статусе Development; проект их уже использует — сохранить, держать захват содержимого выключенным по умолчанию.
- **Платформа.** Node 26 становится Active LTS 28.10.2026, Node 24 переходит в Maintenance (до апреля 2028); с Node 27 — ежегодные релизы. PostgreSQL 18 (асинхронный ввод-вывод, `uuidv7()`), PostgreSQL 19 в бете. В CI добавлена матрица 24/26.

## 10. Как воспроизвести

```bash
# исходный коммит и пробы «до»
git clone https://github.com/KonkovDV/Vesta && cd Vesta && git checkout e6814bb
npm ci --ignore-scripts && npm run build
# PostgreSQL+pgvector и Redis, переменные — probes/kernel.env.example
node probes/di-override.cjs "$PWD/dist"   # V-01
node probes/policy.cjs "$PWD/dist"        # V-02, V-18
node probes/retry-dup.cjs "$PWD/dist"     # V-03
node probes/vm-escape.cjs "$PWD/dist"     # V-05
node probes/ssrf.cjs "$PWD/dist"          # V-11
node probes/gsn-skip.cjs "$PWD" postgresql://...   # V-17
# «после»
git am ../patches/*.patch && npm ci --ignore-scripts && npm test
TEST_DATABASE_URL=postgresql://... TEST_REDIS_URL=redis://... npm run test:integration
```
