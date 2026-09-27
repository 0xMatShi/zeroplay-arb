# SubLine

Монорепозиторий сканера арбитражных возможностей между prediction markets и букмекерскими площадками. Веб-интерфейс работает через NestJS API и WebSocket; в репозитории также находятся сайт документации и Telegram-боты.

## Overview

Основной активный сценарий backend — спортивный арбитраж между `Polymarket` и букмекерскими площадками, а также сопоставление линий `DexSport` с букмекерами. Backend получает события и котировки, сопоставляет матчи и рынки, рассчитывает возможные связки и выдаёт их клиентам через REST и `Socket.IO`.

React-приложение показывает сканер, калькулятор, пользовательский dashboard и страницы продукта. Доступ к защищённым функциям связан с API-ключами и подписками. `PostgreSQL` хранит пользователей, подписки и данные dashboard; состояние активного спортивного сканера хранится в памяти процесса.

В проекте есть отдельная реализация арбитража между prediction markets (`PM↔PM`), но сейчас она не подключена в корневом NestJS-модуле. Поэтому её REST и `Socket.IO` маршруты недоступны при обычном запуске backend.

## Features

- Сбор спортивных событий и котировок `Polymarket`, `DexSport` и подключённых букмекерских адаптеров. В активном `SportsArbModule` зарегистрированы `Pinnacle`, `Cloudbet`, Pari и Fonbet; Stake adapter сейчас закомментирован.
- Сопоставление событий и рынков, расчёт арбитражных возможностей, обновление результатов по мере поступления цен.
- REST API и `Socket.IO` namespace для спортивного сканера.
- Фильтры и калькулятор во frontend, а также dashboard для записей о сделках и статистики.
- API-ключи, сессии, подписки и защищённые endpoints для интеграции с ботами.
- Telegram-боты для уведомлений и управления подписками/платежами.
- Русская и английская локализации UI и документации.

Сканер обнаруживает возможности, но активный спортивный модуль не размещает ставки на площадках.

## Tech Stack

| Компонент | Стек |
|---|---|
| Backend | Node.js, TypeScript, NestJS 10, TypeORM, Swagger, `Socket.IO` |
| Frontend | React 18, TypeScript, Vite, React Router, TanStack Query, i18next |
| Database | `PostgreSQL`; `SQLite` для локального состояния Telegram-ботов |
| Documentation | Docusaurus 3, MDX, React |
| Notification bot | Python 3.11+, python-telegram-bot, python-socketio, aiosqlite |
| Payment bot | Python 3.14+, aiogram, aiohttp, `SQLite`, EVM/Solana/Tron RPC clients |
| Local infrastructure | Docker Compose для `PostgreSQL` 15 и `FlareSolverr` |

В корне нет общего package manager workspace или единого compose-файла. Для backend и frontend есть отдельные lock-файлы и команды; Python-проекты устанавливаются независимо через `uv`. Redis и очередь сообщений в активной конфигурации не используются.

## Architecture

~~~mermaid
flowchart LR
  PM["Polymarket Sports API / CLOB WS"]
  Books["DexSport и букмекерские источники"]
  Adapters["NestJS адаптеры"]
  Matcher["Сопоставление событий и рынков"]
  Scanner["Расчёт арбитражных возможностей"]
  API["NestJS REST + Socket.IO"]
  FE["React/Vite frontend"]
  DB[("PostgreSQL")]
  PayBot["payment-bot"]
  NotifyBot["notification-bot"]
  PMPM["PM↔PM модуль, сейчас не подключён"]

  PM --> Adapters
  Books --> Adapters
  Adapters --> Matcher --> Scanner --> API
  API <--> FE
  API <--> DB
  PayBot -->|"HTTP /bot/*"| API
  NotifyBot -.->|"ожидает namespace /arbitrage"| PMPM
  PMPM -.->|"не импортирован в AppModule"| API
~~~

Активные адаптеры и сервисы спортивного pipeline находятся в `andex-arb-be/src/arbitrage/pm-bm-arb`: адаптеры получают данные, matcher сопоставляет события и рынки, scanner пересчитывает связки при обновлении котировок, а controller и gateway предоставляют REST и события клиентам.

`PostgreSQL` используется backend для пользователей, подписок, dashboard и состояния blockchain sync. Спортивные возможности не сохраняются в этой БД и теряются при перезапуске backend. Отдельный модуль pm-pm-arb содержит собственные сущности, адаптеры и schedulers, но `ArbitrageModule` закомментирован в `src/app.module.ts`.

`payment-bot` обращается к защищённым HTTP endpoints backend после обработки подписок. `notification-bot` подключается к `Socket.IO` namespace `/arbitrage`; этот namespace относится к отключённому `PM↔PM` модулю и сейчас не доступен из стандартного запуска.

У спортивного scheduler есть методы с @Cron, но активная конфигурация не импортирует `ScheduleModule.forRoot()`: этот вызов находится в отключённом `PM↔PM` модуле. Не рассчитывайте на выполнение cron-задач спортивного модуля, пока модуль расписания не подключён.

## Project Structure

~~~text
.
├── andex-arb-be/
│   ├── src/main.ts                       # запуск NestJS, Swagger, CORS, порт
│   ├── src/app.module.ts                 # активные backend-модули
│   ├── src/arbitrage/pm-bm-arb/          # активный спортивный сканер
│   ├── src/arbitrage/pm-pm-arb/          # PM↔PM реализация, не подключена
│   ├── src/auth/                         # API key и session guards
│   ├── src/subscriptions/                # подписки
│   ├── src/users/                         # пользователи
│   ├── src/dashboard/                    # dashboard API и сущности
│   ├── src/blockchain/                   # EVM transfer scanner
│   ├── src/migrations/                   # TypeORM migrations
│   ├── scripts/                           # ручные диагностические скрипты
│   └── docker-compose.yml                # PostgreSQL и FlareSolverr
├── andex-arb-fe/
│   └── src/                              # React pages, API client и Socket.IO hooks
├── andex-arb-docs/
│   ├── docs/                             # пользовательская документация
│   └── docusaurus.config.ts
├── notification-bot/
│   ├── main.py
│   └── src/                              # Telegram UI, WebSocket, SQLite
├── payment-bot/
│   ├── main.py                           # Telegram bot
│   ├── manage.py                         # интерактивная админ-консоль
│   └── src/                              # платежи, SQLite, backend и RPC
└── nginx-docs.conf                       # пример Nginx-конфигурации docs
~~~

## Prerequisites

- Node.js и `Corepack`. Docusaurus явно требует Node.js 20 или новее; backend и frontend не задают поле engines. Node.js 20+ — практичная общая версия для JavaScript-подпроектов.
- `PostgreSQL`. Для локальной разработки можно запустить `PostgreSQL` 15 через compose-файл backend.
- Docker с Docker Compose — только если используете `PostgreSQL` из compose.
- `uv` и Python: 3.11+ для `notification-bot`, 3.14+ для `payment-bot`.
- Доступ в интернет для загрузки котировок, API/WebSocket площадок, Telegram и, при включённом мониторинге переводов, RPC сетей.
- Для авторизованного подключения `Pinnacle` адаптер запускает браузер через Puppeteer; может понадобиться установленный Chromium/Chrome. Путь к браузеру задаётся через `CHROME_PATH`.

## Installation / Quick Start

Запускайте команды из каталога соответствующего приложения. В корне репозитория нет общего install-скрипта.

### 1. Backend и `PostgreSQL`

Файл `andex-arb-be/.env.example` уже содержит локальные параметры `PostgreSQL` для compose: порт хоста 5433, имя БД arb_be. Скопируйте файл и проверьте настройки перед запуском.

~~~bash
cd andex-arb-be
cp .env.example .env
corepack pnpm install
docker compose up -d
corepack pnpm migration:run
corepack pnpm start:dev
~~~

Backend слушает порт 3000 по умолчанию. Для ручного запуска `PostgreSQL` задайте в .env актуальные DB_* значения.

### 2. Frontend

Во втором терминале:

~~~bash
cd andex-arb-fe
cp .env.example .env
corepack pnpm install
corepack pnpm dev
~~~

Vite открывает приложение на http://localhost:5173; API по умолчанию ожидается на http://localhost:3000.

Чтобы открыть защищённые разделы frontend, нужен действительный API-ключ пользователя с активной подпиской. Одного запуска backend недостаточно, чтобы создать такой аккаунт.

### 3. Документация

~~~bash
cd andex-arb-docs
npm ci
npm start
~~~

Локальный сервер документации запускается на http://localhost:3002.

## Configuration

Backend загружает .env.local, затем .env из текущего рабочего каталога. Frontend использует переменные `VITE_*` во время сборки.

### Backend

Основной шаблон — `andex-arb-be/.env.example`. Таблица ниже перечисляет параметры, используемые активной конфигурацией.

| Variable | Required | Description | Default |
|---|---:|---|---|
| `APP_PORT` | Нет | HTTP-порт NestJS | 3000 |
| `APP_NAME`, `APP_VERSION` | Нет | Значения endpoint /version и версии Swagger | arb-be, 1.0.0 |
| `NODE_ENV` | Нет | При значении development TypeORM включает synchronize | development в шаблоне |
| `DB_HOST` | Для backend | `PostgreSQL` host | localhost |
| `DB_PORT` | Для backend | `PostgreSQL` port; compose публикует контейнерный 5432 на 5433 | 5432 в коде, 5433 в .env.example |
| `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | Для backend | Учётные данные и имя `PostgreSQL` database | postgres, postgres, arb_be |
| `ADMIN_API_KEY` | Для admin-клиента | Ключ для подключения admin-клиента к спортивному WebSocket. AdminGuard также используется PM↔PM endpoints, которые сейчас отключены | Не задан |
| `BOT_SECRET` | Для интеграции ботов | Секрет заголовка `X-Bot-Secret` для `/bot/*`; должен совпадать в backend и боте | Не задан |
| `PAYMENT_WALLET_ADDRESS` | Для blockchain monitor | Адрес, входящие переводы на который отслеживает модуль blockchain | Не задан |
| `ETHEREUM_RPC_URL`, `BSC_RPC_URL`, `ARBITRUM_RPC_URL`, `BASE_RPC_URL` | Нет | RPC для включения мониторинга соответствующих EVM-сетей; сеть запускается только при заданном RPC и wallet address | Не заданы |
| `ETHEREUM_CONFIRMATIONS`, `BSC_CONFIRMATIONS`, `ARBITRUM_CONFIRMATIONS`, `BASE_CONFIRMATIONS` | Нет | Число подтверждений для соответствующей сети | 12, 15, 5, 5 |
| `PAYMENT_POLL_INTERVAL_MS` | Нет | Интервал сканирования переводов в миллисекундах | 20000 |
| `PINNACLE_USERNAME`, `PINNACLE_PASSWORD` | Нет | Учётные данные `Pinnacle`; без них адаптер не загружает авторизованные данные | Не заданы |
| `CHROME_PATH`, `PINNACLE_PROXY_URL` | Нет | Путь к браузеру и proxy для интеграции `Pinnacle` | В коде есть fallback для Chrome; proxy не задан |
| `CLOUDBET_API_KEY` | Нет | Ключ `Cloudbet`; без него адаптер работает без данных площадки | Не задан |
| `DEXSPORT_USER_HASH` | Нет | Необязательная конфигурация пользовательского доступа `DexSport` | Не задан |

Для обычного запуска сканера переменные RPC и wallet address не нужны. Значения в шаблоне для интеграций пустые; задавайте только те, которые настроены для вашей среды. Не используйте локальные DB defaults вне разработки.

В шаблоне также есть параметры SIWE и AI, которые текущие активные модули не читают. Ключи `PREDICT_FUN_API_KEY`, `MATCH_CONFIDENCE_THRESHOLD` и `ARB_MIN_PROFIT_PERCENTAGE` относятся к `PM↔PM` коду, который не подключён в AppModule; установка этих значений сама по себе не включает `PM↔PM` API.

### Frontend

Шаблон — `andex-arb-fe/.env.example`.

| Variable | Required | Description | Default |
|---|---:|---|---|
| `VITE_BACKEND_URL` | Нет | Base URL backend API и `Socket.IO` | http://localhost:3000 |
| `VITE_TELEGRAM_BOT_URL` | Нет | Ссылка на Telegram-бота в UI | Placeholder в шаблоне |
| `VITE_TELEGRAM_SUPPORT_URL` | Нет | Ссылка на поддержку Telegram | Placeholder в шаблоне |
| `VITE_COOKIE_DOMAIN` | Нет | Домен для auth-cookie helper | Пустая строка |

### Notification bot

Шаблон — `notification-bot/.env.example`. Замените URL на локальный backend при локальной разработке.

| Variable | Required | Description | Default |
|---|---:|---|---|
| `TELEGRAM_BOT_TOKEN` | Да | Токен Telegram bot | Нет |
| `ADMIN_API_KEY` | Да | API-ключ для подключения к namespace `/arbitrage` | Нет |
| `BOT_SECRET` | Да для проверки ключей | Секрет для HTTP-запросов к /bot/verify-key | Пустая строка |
| `BACKEND_URL` | Нет | Base URL HTTP API | В шаблоне production URL |
| `BACKEND_WS_URL` | Нет | URL `Socket.IO` backend | В шаблоне production URL |
| `DB_PATH` | Нет | Путь к локальной `SQLite` database | bot.db |

В текущем состоянии namespace `/arbitrage` отключён вместе с `PM↔PM` модулем, поэтому WebSocket-уведомления этого бота не заработают при стандартном запуске backend.

### Payment bot

Для `payment-bot` файла .env.example нет; создайте локальный .env в каталоге бота и задайте настройки по реальному окружению.

| Variable | Required | Description | Default |
|---|---:|---|---|
| `TELEGRAM_BOT_TOKEN` | Да | Токен Telegram bot | Нет |
| `PRIVATE_GROUP_ID` | Для управления приватной группой | ID Telegram-группы для управления доступом по подписке | 0 |
| `BACKEND_URL` | Для синхронизации с backend | Base URL API | http://localhost:3000 |
| `BOT_SECRET` | Для синхронизации с backend | Должен совпадать с `BOT_SECRET` backend | Пустая строка |
| `BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `SOLANA_RPC_URL`, `TRONGRID_API_URL`, `TRONGRID_API_KEY` | Нет | Необязательные RPC/API overrides для мониторинга сетей | Для большинства сетей в коде есть публичные URL |
| `WITHDRAWAL_WALLET_KEY` | Только для withdrawal функций | Приватный ключ EVM-кошелька для отправки USDC | Не задан |
| `ADMIN_CHAT_ID`, `WITHDRAWAL_CHAT_ID` | Для уведомлений/выводов администратору | Telegram chat IDs | Не заданы |

Payment bot хранит своё состояние в `payment-bot/data/bot.db`; путь задан в коде. Никогда не добавляйте в git bot tokens, `BOT_SECRET`, RPC credentials или приватные ключи.

## Running the Project

Для ежедневной разработки backend и frontend запускаются отдельно командами из Quick Start. Backend предоставляет `/api` с Swagger UI и `/api/json` с OpenAPI JSON.

Дополнительные приложения запускаются независимо:

~~~bash
cd notification-bot
cp .env.example .env
uv sync --locked
uv run python main.py
~~~

`notification-bot` требует Python 3.11+ и заполненные обязательные Telegram/backend настройки. Сейчас он ожидает отключённый namespace `/arbitrage`.

~~~bash
cd payment-bot
uv sync --locked
uv run python main.py
~~~

`payment-bot` требует Python 3.14+, созданный вручную .env и `TELEGRAM_BOT_TOKEN`. Административная консоль запускается отдельно:

~~~bash
cd payment-bot
uv run python manage.py
~~~

## Docker

Docker Compose поддерживается только для вспомогательных сервисов backend. Dockerfile для сборки и запуска самого приложения в репозитории нет.

Из каталога `andex-arb-be` команда `docker compose up -d postgres` запускает `PostgreSQL` 15, доступный с host-порта 5433. Compose также описывает `FlareSolverr` на 8191; текущий активный `SportsArbModule` не подключает Stake adapter, который использует `FlareSolverr`, поэтому для стандартного запуска этот сервис не требуется.

## Database / Migrations

Backend использует `PostgreSQL` и TypeORM. Миграции находятся в `andex-arb-be/src/migrations`; автоматически при старте они не запускаются (migrationsRun: false).

~~~bash
cd andex-arb-be
corepack pnpm migration:run
~~~

Откат последней миграции:

~~~bash
cd andex-arb-be
corepack pnpm migration:revert
~~~

При `NODE_ENV`=development TypeORM дополнительно включает synchronize. Это упрощает локальный старт, но не заменяет миграции для окружений с `NODE_ENV`=production.

Уведомления и платёжный бот используют собственные `SQLite`-файлы; отдельные внешние database-сервисы им не нужны.

## API

NestJS не добавляет общий URL prefix. Swagger UI доступен на `/api`, OpenAPI JSON — на `/api/json`.

Несмотря на префикс `/auth/siwe`, текущий `POST /auth/siwe/session` принимает уже существующий API key и выдаёт session token. Endpoints для выдачи SIWE message и проверки wallet signature в активном контроллере отсутствуют.

| Route group | Main routes | Access |
|---|---|---|
| Version | `GET /version` | Публичный |
| Auth | `POST /auth/siwe/session`, `GET /auth/siwe/whoami`, `GET /auth/siwe/check` | API key/session; /check также используется Nginx auth_request |
| Subscriptions | `GET /subscriptions/active`, `GET /subscriptions/history`, `GET /subscriptions/status` | API key с активной подпиской |
| Sports arbitrage | `GET /sports-arbitrage/opportunities`, `GET /sports-arbitrage/stats`, `GET /sports-arbitrage/matches`, `GET /sports-arbitrage/bybit-rate` | API key с активной подпиской |
| Dashboard | `GET /dashboard/stats`, `GET /dashboard/trades`, `GET /dashboard/leaderboard`; профили, my-stats и my-trades требуют API key | Публичные сводные endpoints; пользовательские endpoints требуют API key |
| Bot integration | `POST /bot/activate`, `GET /bot/subscriptions`, `POST /bot/deactivate`, `POST /bot/verify-key` | `X-Bot-Secret` |

Для dashboard также доступны `POST /dashboard/trades`, `PUT /dashboard/trades/:id` и `DELETE /dashboard/trades/:id`; пользовательские операции требуют API key.

Активный `Socket.IO` namespace — `/sports-arbitrage`. Клиенты передают API key в handshake.auth.apiKey; для пользовательских клиентов требуется активная подписка. События включают `sports:new`, `sports:updated`, `sports:expired` и `sports:snapshot`.

Маршруты `/arbitrage/*` и namespace `/arbitrage` реализованы в исходниках `PM↔PM`, но не зарегистрированы текущим AppModule; они не входят в работающий API до подключения модуля.

## Development

Команды запускайте из каталога приложения.

| App | Command | Purpose |
|---|---|---|
| Backend | `corepack pnpm start:dev` | NestJS dev server с watch |
| Backend | `corepack pnpm build` | Компиляция в dist/ |
| Backend | `corepack pnpm format` | Prettier для src и test |
| Backend | `corepack pnpm lint` | ESLint с --fix, команда может менять файлы |
| Backend | `corepack pnpm test` | Jest |
| Frontend | `corepack pnpm dev` | Vite dev server |
| Frontend | `corepack pnpm build` | TypeScript check и production bundle |
| Frontend | `corepack pnpm lint` | ESLint |
| Frontend | `corepack pnpm preview` | Просмотр собранного Vite bundle |
| Docs | `npm start` | Docusaurus dev server на порту 3002 |
| Docs | `npm run typecheck` | TypeScript check |
| Docs | `npm run build` | Сборка статического сайта |

В backend есть дополнительные ручные интеграционные скрипты в `andex-arb-be/scripts`. Это не замена unit-тестам.

## Testing

В backend настроен Jest, но в текущем дереве нет файлов *.spec.ts. Скрипт test:e2e также ссылается на отсутствующий конфиг test/jest-e2e.json. Frontend и Python-подпроекты не содержат тестовых команд или найденных тестовых файлов.

Чтобы запустить backend Jest, используйте:

~~~bash
cd andex-arb-be
corepack pnpm test
~~~

Для реальных проверок интеграций используйте отдельные скрипты из `andex-arb-be/scripts`; они могут обращаться к внешним сервисам и требуют соответствующей сетевой доступности/учётных данных.

## Build

- Backend: `corepack pnpm build` в `andex-arb-be`, результат — `andex-arb-be/dist`.
- Frontend: `corepack pnpm build` в `andex-arb-fe`, результат — `andex-arb-fe/dist`.
- Docs: `npm run build` в `andex-arb-docs`, результат — `andex-arb-docs/build`.

Для backend в package scripts предусмотрен production запуск через `corepack pnpm start:prod`; перед ним соберите backend и примените production migrations. Автоматизированный deploy workflow или контейнерный образ приложения в репозитории отсутствуют.

Полный набор команд для production-сборки и запуска:

~~~bash
cd andex-arb-be
corepack pnpm build
corepack pnpm migration:run:prod
corepack pnpm start:prod
~~~
