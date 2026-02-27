# Frontend: Арбитражные возможности — Техническое задание

## Обзор

Фронтенд получает и отображает арбитражные возможности между предиктивными маркетами (Polymarket, Kalshi, Opinion). Данные приходят двумя путями:

1. **REST API** — первичная загрузка списка + статистика
2. **WebSocket** — real-time обновления (новые, обновлённые, истёкшие)

Оба источника нужно комбинировать для актуального UI.

---

## 1. Подключение

### REST API

```
Base URL: http://localhost:3000/arbitrage
```

Все запросы — `GET`, ответы — `JSON`. Аутентификация для этих эндпоинтов не требуется.

### WebSocket

```
URL: ws://localhost:3000/arbitrage
Библиотека: socket.io-client (НЕ нативный WebSocket)
```

```typescript
import { io } from "socket.io-client";

const socket = io("http://localhost:3000/arbitrage", {
  transports: ["websocket"],
});
```

---

## 2. REST API эндпоинты

### 2.1. Получить активные арбитражные возможности

```
GET /arbitrage/opportunities?limit=50&offset=0
```

**Query параметры:**

| Параметр | Тип    | Default | Описание                  |
|----------|--------|---------|---------------------------|
| `limit`  | number | 50      | Кол-во элементов (1-100)  |
| `offset` | number | 0       | Смещение для пагинации    |

**Ответ:**

```typescript
interface OpportunitiesResponse {
  items: Opportunity[];
  total: number;   // общее кол-во активных
  limit: number;
  offset: number;
}

interface Opportunity {
  id: string;                  // UUID
  type: "binary" | "multi";    // тип маркета
  profitPercentage: number;    // процент прибыли (например, 2.45)
  totalCost: number;           // суммарная стоимость всех ног (< 1.0 = есть арбитраж)
  guaranteedPayout: number;    // гарантированная выплата (всегда 1.0)
  legs: ArbitrageLeg[];        // ноги арбитража — что и где покупать
  status: "active";            // всегда active для этого эндпоинта
  foundAt: string;             // ISO datetime — когда найден
  lastValidatedAt: string;     // ISO datetime — последняя проверка
  expiredAt: string | null;    // ISO datetime или null
  matchTitle: string;          // название матча между маркетами
}

interface ArbitrageLeg {
  platformSlug: string;        // "polymarket" | "kalshi" | "opinion"
  platformName: string;        // "Polymarket" | "Kalshi" | "Opinion"
  eventExternalId: string;     // ID ивента на платформе
  eventTitle: string;          // заголовок ивента на платформе
  outcomeExternalId: string;   // ID конкретного исхода
  outcomeName: string;         // "Yes", "No", "Trump", "Arsenal" и т.д.
  price: number;               // цена (0.0 - 1.0) = вероятность
  url?: string;                // прямая ссылка на маркет на платформе
}
```

**Пример ответа:**

```json
{
  "items": [
    {
      "id": "a1b2c3d4-...",
      "type": "binary",
      "profitPercentage": 3.25,
      "totalCost": 0.9685,
      "guaranteedPayout": 1.0,
      "legs": [
        {
          "platformSlug": "polymarket",
          "platformName": "Polymarket",
          "eventExternalId": "0x123...",
          "eventTitle": "Will BTC hit $150k by June 2026?",
          "outcomeExternalId": "token-yes-123",
          "outcomeName": "Yes",
          "price": 0.55,
          "url": "https://polymarket.com/event/btc-150k"
        },
        {
          "platformSlug": "kalshi",
          "platformName": "Kalshi",
          "eventExternalId": "BTC-150K-JUN26",
          "eventTitle": "Bitcoin above $150,000 by June 30?",
          "outcomeExternalId": "BTC-150K-JUN26-no",
          "outcomeName": "No",
          "price": 0.4185,
          "url": "https://kalshi.com/markets/btc-150k"
        }
      ],
      "status": "active",
      "foundAt": "2026-02-12T14:30:00.000Z",
      "lastValidatedAt": "2026-02-12T15:52:00.000Z",
      "expiredAt": null,
      "matchTitle": "Will BTC hit $150k by June 2026?"
    }
  ],
  "total": 5,
  "limit": 50,
  "offset": 0
}
```

### 2.2. Ордербук и исполняемые тиры арбитража

```
GET /arbitrage/opportunities/:id/orderbook
```

Главный эндпоинт для реальной торговли. Фетчит ордербуки с платформ в реальном времени, проходит по стакану и строит **тиры** — сколько контрактов можно реально купить на каждом уровне цены, с каким профитом.

**Ответ:**

```typescript
interface OrderBookAnalysisResponse {
  opportunityId: string;
  matchTitle?: string;
  /** Ордербук каждой ноги (сырые данные) */
  legs: LegOrderBook[];
  /** Исполняемые тиры арбитража */
  tiers: ArbitrageTiersSummary;
  /** Когда был сделан анализ */
  analyzedAt: string;
}

interface ArbitrageTiersSummary {
  /** Тиры от лучшего к худшему профиту */
  tiers: ArbitrageTier[];
  /** Суммарно контрактов по всем тирам */
  totalQuantity: number;
  /** Суммарное вложение ($) */
  totalInvestment: number;
  /** Суммарный гросс профит ($) */
  totalGrossProfit: number;
  /** Средневзвешенный % прибыли */
  weightedAvgProfit: number;
  /** Лучший % (первый тир) */
  bestProfitPercentage: number;
  /** Худший % (последний тир, но всё ещё прибыльный) */
  worstProfitPercentage: number;
}

interface ArbitrageTier {
  /** Кол-во контрактов в этом тире */
  quantity: number;
  /** Цена на каждой платформе */
  legPrices: {
    platformSlug: string;
    platformName: string;
    outcomeName: string;
    price: number;        // цена ASK на этом уровне
    url?: string;
  }[];
  /** Суммарная стоимость за 1 контракт (все ноги) */
  totalCostPerContract: number;
  /** % прибыли: (1.0 - totalCost) / totalCost × 100 */
  profitPercentage: number;
  /** Вложение для этого тира: quantity × totalCostPerContract */
  investmentAmount: number;
  /** Гросс профит: quantity × (1.0 - totalCostPerContract) */
  grossProfit: number;
}

interface LegOrderBook {
  platformSlug: string;
  platformName: string;
  outcomeName: string;
  orderBook: OrderBook;
  /** Суммарное кол-во контрактов в стакане (asks) */
  availableQuantity: number;
  /** Лучший ASK */
  effectivePrice: number;
}

interface OrderBook {
  bids: OrderBookEntry[];  // DESC (лучший бид первый)
  asks: OrderBookEntry[];  // ASC (лучший аск первый)
  lastPrice?: number;
  timestamp?: number;      // Unix ms
}

interface OrderBookEntry {
  price: number;     // 0.0 - 1.0
  quantity: number;  // кол-во контрактов
}
```

**Пример ответа:**

```json
{
  "opportunityId": "a1b2c3d4-...",
  "matchTitle": "Will BTC hit $150k by June 2026?",
  "legs": [
    {
      "platformSlug": "opinion",
      "platformName": "Opinion",
      "outcomeName": "No",
      "orderBook": {
        "asks": [
          { "price": 0.40, "quantity": 200 },
          { "price": 0.42, "quantity": 500 },
          { "price": 0.45, "quantity": 1000 }
        ],
        "bids": [ ... ],
        "lastPrice": 0.39,
        "timestamp": 1771168482351
      },
      "availableQuantity": 1700,
      "effectivePrice": 0.40
    },
    {
      "platformSlug": "polymarket",
      "platformName": "Polymarket",
      "outcomeName": "Yes",
      "orderBook": {
        "asks": [
          { "price": 0.53, "quantity": 300 },
          { "price": 0.55, "quantity": 800 },
          { "price": 0.57, "quantity": 2000 }
        ],
        "bids": [ ... ],
        "timestamp": 1771168482351
      },
      "availableQuantity": 3100,
      "effectivePrice": 0.53
    }
  ],
  "tiers": {
    "tiers": [
      {
        "quantity": 200,
        "legPrices": [
          { "platformSlug": "opinion", "platformName": "Opinion", "outcomeName": "No", "price": 0.40 },
          { "platformSlug": "polymarket", "platformName": "Polymarket", "outcomeName": "Yes", "price": 0.53 }
        ],
        "totalCostPerContract": 0.93,
        "profitPercentage": 7.53,
        "investmentAmount": 186.0,
        "grossProfit": 14.0
      },
      {
        "quantity": 100,
        "legPrices": [
          { "platformSlug": "opinion", "platformName": "Opinion", "outcomeName": "No", "price": 0.42 },
          { "platformSlug": "polymarket", "platformName": "Polymarket", "outcomeName": "Yes", "price": 0.53 }
        ],
        "totalCostPerContract": 0.95,
        "profitPercentage": 5.26,
        "investmentAmount": 95.0,
        "grossProfit": 5.0
      },
      {
        "quantity": 500,
        "legPrices": [
          { "platformSlug": "opinion", "platformName": "Opinion", "outcomeName": "No", "price": 0.42 },
          { "platformSlug": "polymarket", "platformName": "Polymarket", "outcomeName": "Yes", "price": 0.55 }
        ],
        "totalCostPerContract": 0.97,
        "profitPercentage": 3.09,
        "investmentAmount": 485.0,
        "grossProfit": 15.0
      }
    ],
    "totalQuantity": 800,
    "totalInvestment": 766.0,
    "totalGrossProfit": 34.0,
    "weightedAvgProfit": 4.44,
    "bestProfitPercentage": 7.53,
    "worstProfitPercentage": 3.09
  },
  "analyzedAt": "2026-02-12T16:00:00.000Z"
}
```

**Как это показывать на фронте:**

1. **Карточка возможности** — показывать `bestProfitPercentage` как заголовок + `totalQuantity` контрактов
2. **Таблица тиров** — каждая строка = 1 тир:

| Контракты | Opinion (No) | Polymarket (Yes) | Стоимость | Профит % | Вложение | Профит $ |
|-----------|-------------|-------------------|-----------|----------|----------|----------|
| 200       | $0.40       | $0.53             | $0.93     | 7.53%    | $186     | $14      |
| 100       | $0.42       | $0.53             | $0.95     | 5.26%    | $95      | $5       |
| 500       | $0.42       | $0.55             | $0.97     | 3.09%    | $485     | $15      |

3. **Итого** — `totalInvestment`, `totalGrossProfit`, `weightedAvgProfit`

**Важные моменты:**

- Если `tiers` пуст — арбитража по ордерам нет (стакан пуст или totalCost ≥ 1.0)
- Запрос к API платформ — 1-3 сек, показывайте loader
- Тиры — это РЕАЛЬНЫЕ ордера, не теоретические цены
- `profitPercentage` на основном эндпоинте `/opportunities` — теоретический (по "лучшей цене"), а тут — по реальному стакану
- Поддерживаются: Opinion + Polymarket. Если у ноги нет ордербука — тиры не строятся

### 2.3. Получить статистику

```
GET /arbitrage/stats
```

**Ответ:**

```typescript
interface StatsResponse {
  activeCount: number;       // кол-во активных возможностей
  avgProfit: number;         // средний % прибыли
  maxProfit: number;         // максимальный % прибыли
  totalFound: number;        // всего найдено (активных)
  connectedClients: number;  // кол-во подключённых по WebSocket
}
```

### 2.3. Получить платформы

```
GET /arbitrage/platforms
```

**Ответ:**

```typescript
interface Platform {
  id: string;
  slug: string;              // "polymarket" | "kalshi" | "opinion"
  name: string;              // "Polymarket" | "Kalshi" | "Opinion"
  baseUrl: string;           // "https://polymarket.com" и т.д.
  isActive: boolean;
  pollIntervalMs: number;    // интервал опроса в мс
  lastPolledAt: string;      // ISO datetime последнего опроса
}
```

---

## 3. WebSocket события

После подключения к `ws://localhost:3000/arbitrage` клиент получает три типа событий:

### 3.1. `opportunity:new` — Новая возможность

Приходит когда система обнаружила новый арбитраж.

```typescript
socket.on("opportunity:new", (data: NewOpportunityEvent) => {
  // Добавить в список
});

interface NewOpportunityEvent {
  id: string;
  matchTitle: string;
  profitPercentage: number;
  totalCost: number;
  legs: ArbitrageLeg[];
  type: "binary" | "multi";
  foundAt: string;
}
```

### 3.2. `opportunity:updated` — Обновление цен

Приходит каждые ~30 сек при ревалидации, если цены изменились.

```typescript
socket.on("opportunity:updated", (data: UpdatedOpportunityEvent) => {
  // Обновить существующую запись в списке по id
});

interface UpdatedOpportunityEvent {
  id: string;
  profitPercentage: number;  // новый процент прибыли
  totalCost: number;         // новая суммарная стоимость
  legs: ArbitrageLeg[];      // обновлённые ноги с новыми ценами
  lastValidatedAt: string;
}
```

### 3.3. `opportunity:expired` — Арбитраж исчез

Приходит когда цены сдвинулись и арбитраж больше не существует.

```typescript
socket.on("opportunity:expired", (data: ExpiredOpportunityEvent) => {
  // Удалить из списка или пометить как expired
});

interface ExpiredOpportunityEvent {
  id: string;
  expiredAt: string;
}
```

---

## 4. Рекомендуемая архитектура на фронте

### 4.1. Стор (state management)

```typescript
// Стейт
interface ArbitrageState {
  opportunities: Map<string, Opportunity>;  // id -> opportunity
  stats: StatsResponse | null;
  platforms: Platform[];
  isConnected: boolean;                     // статус WebSocket
  isLoading: boolean;
}
```

### 4.2. Последовательность инициализации

```
1. Подключить WebSocket → socket.io connect
2. Загрузить GET /arbitrage/opportunities → заполнить стор
3. Загрузить GET /arbitrage/stats → отобразить статистику
4. Загрузить GET /arbitrage/platforms → показать статусы платформ
5. Слушать WS события → мутировать стор в реальном времени
```

### 4.3. Обработка WS событий

```typescript
// При получении нового арбитража
socket.on("opportunity:new", (data) => {
  store.opportunities.set(data.id, {
    ...data,
    status: "active",
    lastValidatedAt: data.foundAt,
    expiredAt: null,
    guaranteedPayout: 1.0,
  });
  // Опционально: показать toast/notification
  // Опционально: пересортировать по profitPercentage
});

// При обновлении цен
socket.on("opportunity:updated", (data) => {
  const existing = store.opportunities.get(data.id);
  if (existing) {
    existing.profitPercentage = data.profitPercentage;
    existing.totalCost = data.totalCost;
    existing.legs = data.legs;
    existing.lastValidatedAt = data.lastValidatedAt;
  }
});

// При истечении арбитража
socket.on("opportunity:expired", (data) => {
  store.opportunities.delete(data.id);
  // Или: пометить как expired и показать анимацию удаления
});
```

### 4.4. Переподключение

```typescript
const socket = io("http://localhost:3000/arbitrage", {
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

socket.on("connect", () => {
  store.isConnected = true;
  // ВАЖНО: при переподключении заново загрузить opportunities по REST,
  // т.к. могли пропустить WS-события пока были отключены
  fetchOpportunities();
});

socket.on("disconnect", () => {
  store.isConnected = false;
});
```

---

## 5. Что отображать в UI

### 5.1. Карточка арбитражной возможности

Каждый элемент `Opportunity` — карточка со следующей информацией:

```
┌─────────────────────────────────────────────────────┐
│  🔥 +3.25% прибыль              binary   ● active   │
│                                                      │
│  "Will BTC hit $150k by June 2026?"                 │
│                                                      │
│  ┌──────────────┐    ┌──────────────┐               │
│  │ Polymarket    │    │ Kalshi        │              │
│  │ Buy: Yes      │    │ Buy: No       │              │
│  │ Price: $0.55  │    │ Price: $0.42  │              │
│  │ [Открыть →]   │    │ [Открыть →]   │              │
│  └──────────────┘    └──────────────┘               │
│                                                      │
│  Стоимость: $0.97  →  Выплата: $1.00               │
│  Найден: 14:30  │  Проверен: 15:52                  │
└─────────────────────────────────────────────────────┘
```

**Ключевые поля:**

| Поле | Откуда | Что показать |
|------|--------|-------------|
| Прибыль | `profitPercentage` | `+{value}%` (зелёный если > 0) |
| Тип | `type` | `binary` / `multi` бейдж |
| Заголовок | `matchTitle` | Название события |
| Ноги | `legs[]` | Карточка для каждой ноги |
| Платформа | `leg.platformName` | Название + иконка |
| Исход | `leg.outcomeName` | "Yes", "No", "Arsenal" и т.д. |
| Цена | `leg.price` | `$0.XX` или `XX¢` |
| Ссылка | `leg.url` | Кнопка "Открыть на платформе" |
| Стоимость | `totalCost` | Суммарная стоимость |
| Выплата | `guaranteedPayout` | Всегда $1.00 |
| Найден | `foundAt` | Relative time ("5 мин назад") |
| Проверен | `lastValidatedAt` | Relative time |

### 5.2. Сортировка

Бэкенд возвращает отсортированные по `profitPercentage DESC`. На фронте можно добавить клиентскую сортировку:

- По прибыли (default)
- По времени обнаружения (новые сверху)
- По платформе

### 5.3. Фильтрация (клиентская)

- По типу: `binary` / `multi`
- По платформе: фильтр по `leg.platformSlug`
- Минимальный % прибыли: слайдер

### 5.4. Статистика (шапка / sidebar)

```
Активных: 5  |  Средняя прибыль: 2.1%  |  Макс: 5.8%  |  WS: ● Online
```

Данные из `GET /arbitrage/stats`. Обновлять при каждом WS событии или по таймеру (раз в 30 сек).

---

## 6. Таймлайн обновлений

Для понимания, как часто приходят данные:

| Процесс | Интервал | Что делает |
|----------|----------|-----------|
| Полный поллинг маркетов | ~60 сек | Собирает цены со всех платформ |
| Ревалидация цен | ~30 сек | Перепроверяет активные арбитражи |
| WS `opportunity:new` | При обнаружении | Новый арбитраж |
| WS `opportunity:updated` | ~30 сек | Обновлённые цены |
| WS `opportunity:expired` | При истечении | Арбитраж исчез |

Фронтенд **не должен поллить** REST API по таймеру — все обновления приходят через WebSocket. REST используется только для:
- Первичной загрузки при открытии страницы
- Восстановления после обрыва WebSocket-соединения
- Пагинации (если возможностей станет > 50)

---

## 7. Обработка edge cases

| Кейс | Как обрабатывать |
|------|-----------------|
| WS disconnect | Показать индикатор "Reconnecting...", при reconnect — перезагрузить данные по REST |
| `opportunity:expired` для неизвестного id | Игнорировать (мы могли не загрузить его) |
| `opportunity:updated` для неизвестного id | Запросить полный список по REST (могли пропустить `new`) |
| `profitPercentage` ≈ 0 | Не показывать или показывать серым — на грани исчезновения |
| `legs` с > 2 элементами | Multi-арбитраж — показать все ноги |
| `leg.url` отсутствует | Скрыть кнопку "Открыть на платформе" |
| Пустой список | Показать заглушку "Арбитражных возможностей пока нет" |

---

## 8. Примечания

- Все цены в `legs[].price` — это вероятности от 0.0 до 1.0. Для отображения в долларах умножать не нужно: `$0.55` означает 55 центов за контракт с выплатой $1.00.
- `profitPercentage` уже рассчитан бэкендом: `(guaranteedPayout - totalCost) / totalCost * 100`.
- `totalCost` — сумма всех `legs[].price`. Если < 1.0 — есть арбитраж.
- Арбитражи живут недолго (секунды-минуты). UI должен быть отзывчивым.
