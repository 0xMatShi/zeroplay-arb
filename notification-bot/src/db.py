import os
import aiosqlite

DB_PATH = os.getenv("DB_PATH", "bot.db")


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS telegram_users (
                telegram_id      INTEGER PRIMARY KEY,
                username         TEXT,
                first_name       TEXT,
                has_subscription INTEGER NOT NULL DEFAULT 0,
                created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS presets (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id        INTEGER NOT NULL,
                name               TEXT NOT NULL,
                min_profit_usd     REAL,
                max_profit_usd     REAL,
                min_profit_pct     REAL,
                max_profit_pct     REAL,
                disabled_exchanges TEXT NOT NULL DEFAULT '',
                created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.commit()


# ---------------------------------------------------------------------------
# Пользователи
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Пресеты
# ---------------------------------------------------------------------------

def _row_to_preset(row: tuple) -> dict:
    disabled = [e for e in row[7].split(",") if e] if row[7] else []
    return {
        "id": row[0],
        "telegram_id": row[1],
        "name": row[2],
        "min_usd": row[3],
        "max_usd": row[4],
        "min_pct": row[5],
        "max_pct": row[6],
        "disabled_exchanges": disabled,
    }


async def get_presets(telegram_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT id, telegram_id, name, min_profit_usd, max_profit_usd, "
            "min_profit_pct, max_profit_pct, disabled_exchanges "
            "FROM presets WHERE telegram_id = ? ORDER BY created_at",
            (telegram_id,),
        )
        rows = await cursor.fetchall()
    return [_row_to_preset(r) for r in rows]


async def get_preset_by_id(preset_id: int) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT id, telegram_id, name, min_profit_usd, max_profit_usd, "
            "min_profit_pct, max_profit_pct, disabled_exchanges "
            "FROM presets WHERE id = ?",
            (preset_id,),
        )
        row = await cursor.fetchone()
    return _row_to_preset(row) if row else None


async def create_preset(
    telegram_id: int,
    name: str,
    min_usd: float | None,
    max_usd: float | None,
    min_pct: float | None,
    max_pct: float | None,
    disabled_exchanges: list[str],
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO presets "
            "(telegram_id, name, min_profit_usd, max_profit_usd, min_profit_pct, max_profit_pct, disabled_exchanges) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (telegram_id, name, min_usd, max_usd, min_pct, max_pct, ",".join(disabled_exchanges)),
        )
        await db.commit()
        return cursor.lastrowid


async def update_preset_by_id(
    preset_id: int,
    name: str,
    min_usd: float | None,
    max_usd: float | None,
    min_pct: float | None,
    max_pct: float | None,
    disabled_exchanges: list[str],
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE presets SET name=?, min_profit_usd=?, max_profit_usd=?, "
            "min_profit_pct=?, max_profit_pct=?, disabled_exchanges=? WHERE id=?",
            (name, min_usd, max_usd, min_pct, max_pct, ",".join(disabled_exchanges), preset_id),
        )
        await db.commit()
