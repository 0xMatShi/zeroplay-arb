# Andex Arb FE

Фронтенд приложение для подключения MetaMask и подписания SIWE (Sign-In With Ethereum) сообщений.

## Технологии

- **Vite** - сборщик и dev-сервер
- **TypeScript** - типизация
- **React** - UI библиотека
- **Wagmi** - React хуки для работы с Ethereum
- **Viem** - утилиты для работы с Ethereum
- **SIWE** - Sign-In With Ethereum

## Установка

```bash
npm install
```

## Настройка

Создайте файл `.env` на основе `.env.example`:

```bash
cp .env.example .env
```

Укажите URL вашего backend'а:

```
VITE_BACKEND_URL=http://localhost:3000
```

## Запуск

```bash
npm run dev
```

## Backend API

Приложение ожидает следующие endpoints на backend'е:

### POST `/api/siwe/message`

Запрос SIWE сообщения для подписания.

**Request:**
```json
{
  "address": "0x..."
}
```

**Response:**
```json
{
  "message": "domain wants you to sign in with your Ethereum account:\n..."
}
```

### POST `/api/siwe/verify`

Верификация подписанного SIWE сообщения.

**Request:**
```json
{
  "message": "...",
  "signature": "0x..."
}
```

**Response:**
```json
{
  "success": true,
  "data": { ... }
}
```

## Использование

1. Откройте приложение в браузере
2. Нажмите "Connect Wallet" и выберите MetaMask
3. После подключения нажмите "Sign In with Ethereum"
4. Подтвердите подпись в MetaMask
5. Сообщение будет отправлено на backend для верификации
