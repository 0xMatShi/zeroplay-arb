import logging
import os

import aiohttp

logger = logging.getLogger(__name__)

BACKEND_URL: str = os.getenv("BACKEND_URL", "http://localhost:3000")
BOT_SECRET: str = os.getenv("BOT_SECRET", "")


async def verify_api_key(api_key: str, telegram_user_id: int) -> bool | None:
    """
    Verifies that api_key belongs to telegram_user_id via the backend.
    Returns True if valid, False if invalid, None on server/network error.
    """
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{BACKEND_URL}/bot/verify-key",
                json={"apiKey": api_key, "telegramUserId": telegram_user_id},
                headers={"X-Bot-Secret": BOT_SECRET},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return bool(data.get("valid", False))
                logger.warning("verify_api_key: unexpected status %s", resp.status)
                return None
    except Exception as exc:
        logger.warning("verify_api_key error: %s", exc)
        return None
