import os
import aiosqlite

DB_PATH = os.getenv("DB_PATH", "bot.db")

PRESET_COLUMNS = {
    "min_usd": "min_profit_usd",
    "max_usd": "max_profit_usd",
    "min_pct": "min_profit_pct",
    "max_pct": "max_profit_pct",
}


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
        await db.execute("""
            CREATE TABLE IF NOT EXISTS user_presets (
                telegram_id        INTEGER PRIMARY KEY,
                min_profit_usd     REAL,
                max_profit_usd     REAL,
                min_profit_pct     REAL,
                max_profit_pct     REAL,
                disabled_exchanges TEXT NOT NULL DEFAULT ''
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


async def get_preset(telegram_id: int) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT min_profit_usd, max_profit_usd, min_profit_pct, max_profit_pct, disabled_exchanges "
            "FROM user_presets WHERE telegram_id = ?",
            (telegram_id,),
        )
        row = await cursor.fetchone()
    if row:
        disabled = [e for e in row[4].split(",") if e] if row[4] else []
        return {
            "min_usd": row[0],
            "max_usd": row[1],
            "min_pct": row[2],
            "max_pct": row[3],
            "disabled_exchanges": disabled,
        }
    return {"min_usd": None, "max_usd": None, "min_pct": None, "max_pct": None, "disabled_exchanges": []}


async def update_preset(telegram_id: int, field: str, value: float) -> None:
    col = PRESET_COLUMNS[field]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"INSERT INTO user_presets (telegram_id, {col}) VALUES (?, ?) "
            f"ON CONFLICT(telegram_id) DO UPDATE SET {col} = excluded.{col}",
            (telegram_id, value),
        )
        await db.commit()


async def toggle_exchange(telegram_id: int, exchange: str) -> None:
    preset = await get_preset(telegram_id)
    disabled = preset["disabled_exchanges"]
    if exchange in disabled:
        disabled.remove(exchange)
    else:
        disabled.append(exchange)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO user_presets (telegram_id, disabled_exchanges) VALUES (?, ?) "
            "ON CONFLICT(telegram_id) DO UPDATE SET disabled_exchanges = excluded.disabled_exchanges",
            (telegram_id, ",".join(disabled)),
        )
        await db.commit()


async def get_subscribed_chat_ids() -> list[int]:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT telegram_id FROM telegram_users WHERE has_subscription = 1"
        )
        rows = await cursor.fetchall()
        return [row[0] for row in rows]
