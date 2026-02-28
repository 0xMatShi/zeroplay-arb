import os
import aiosqlite

DB_PATH = os.getenv("DB_PATH", "bot.db")


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS telegram_users (
                telegram_id   INTEGER PRIMARY KEY,
                username      TEXT,
                first_name    TEXT,
                has_subscription INTEGER NOT NULL DEFAULT 0,
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.commit()


async def register_user(telegram_id: int, username: str | None, first_name: str | None) -> bool:
    """Регистрирует пользователя. Возвращает True если пользователь новый."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT telegram_id FROM telegram_users WHERE telegram_id = ?",
            (telegram_id,),
        )
        exists = await cursor.fetchone()
        if not exists:
            await db.execute(
                "INSERT INTO telegram_users (telegram_id, username, first_name) VALUES (?, ?, ?)",
                (telegram_id, username or "", first_name or ""),
            )
            await db.commit()
            return True
        return False


async def get_subscribed_chat_ids() -> list[int]:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT telegram_id FROM telegram_users WHERE has_subscription = 1"
        )
        rows = await cursor.fetchall()
        return [row[0] for row in rows]
