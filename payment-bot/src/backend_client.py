"""HTTP-клиент для взаимодействия с основным бэкендом."""
import os
from typing import Optional

import aiohttp

from src.logger import logger

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000")
BOT_SECRET = os.getenv("BOT_SECRET", "")

_HEADERS = {"X-Bot-Secret": BOT_SECRET, "Content-Type": "application/json"}


async def activate_subscription(
    telegram_user_id: int,
    plan_slug: str,
    expires_at: Optional[str],
) -> Optional[str]:
    """Активирует подписку в бэкенде и возвращает API-ключ пользователя.

    Args:
        telegram_user_id: Telegram user ID
        plan_slug: Название плана ('1month', '3months', 'forever')
        expires_at: ISO-строка даты истечения или None для бессрочной подписки

    Returns:
        API-ключ для входа на сайт или None при ошибке
    """
    payload = {
        "telegramUserId": telegram_user_id,
        "planSlug": plan_slug,
        "expiresAt": expires_at,
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BACKEND_URL}/bot/activate",
                json=payload,
                headers=_HEADERS,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status in (200, 201):
                    data = await resp.json()
                    api_key = data.get("apiKey")
                    logger.info(f"Backend: activated subscription for TG user {telegram_user_id}, plan={plan_slug}")
                    return api_key
                else:
                    text = await resp.text()
                    logger.error(f"Backend activate failed [{resp.status}] for user {telegram_user_id}: {text}")
                    return None
    except Exception as e:
        logger.error(f"Backend activate error for user {telegram_user_id}: {e}")
        return None


async def get_subscriptions() -> list[dict]:
    """Получает список всех активных подписок от бэкенда.

    Returns:
        Список словарей: [{"telegramUserId": int, "expiresAt": str | null}, ...]
    """
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{BACKEND_URL}/bot/subscriptions",
                headers=_HEADERS,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    return await resp.json()
                else:
                    text = await resp.text()
                    logger.error(f"Backend get_subscriptions failed [{resp.status}]: {text}")
                    return []
    except Exception as e:
        logger.error(f"Backend get_subscriptions error: {e}")
        return []


async def deactivate_subscriptions(telegram_user_ids: list[int]) -> bool:
    """Деактивирует подписки и удаляет API-ключи указанных пользователей.

    Args:
        telegram_user_ids: Список Telegram user ID, у которых истекла подписка

    Returns:
        True если запрос прошёл успешно
    """
    if not telegram_user_ids:
        return True
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BACKEND_URL}/bot/deactivate",
                json={"telegramUserIds": telegram_user_ids},
                headers=_HEADERS,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status in (200, 201):
                    logger.info(f"Backend: deactivated {len(telegram_user_ids)} subscriptions: {telegram_user_ids}")
                    return True
                else:
                    text = await resp.text()
                    logger.error(f"Backend deactivate failed [{resp.status}]: {text}")
                    return False
    except Exception as e:
        logger.error(f"Backend deactivate error: {e}")
        return False
