import logging
import os

import aiohttp

logger = logging.getLogger(__name__)

async def verify_api_key(api_key: str, telegram_user_id: int) -> bool | None:
    """
    Verifies that api_key belongs to telegram_user_id via the backend.
    Returns True if valid, False if invalid, None on server/network error.
    """
    backend_url = os.getenv("BACKEND_URL", "http://localhost:3000")
    bot_secret = os.getenv("BOT_SECRET", "")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{backend_url}/bot/verify-key",
                json={"apiKey": api_key, "telegramUserId": telegram_user_id},
                headers={"X-Bot-Secret": bot_secret},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status < 300:
                    data = await resp.json()
                    return bool(data.get("valid", False))
                logger.warning("verify_api_key: unexpected status %s", resp.status)
                return None
    except Exception as exc:
        logger.warning("verify_api_key error: %s", exc)
        return None
