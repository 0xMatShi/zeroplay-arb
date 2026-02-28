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
                is_active          INTEGER NOT NULL DEFAULT 0,
                min_profit_usd     REAL,
                max_profit_usd     REAL,
                min_profit_pct     REAL,
                max_profit_pct     REAL,
                disabled_exchanges TEXT NOT NULL DEFAULT '',
                created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.commit()

    # Миграции: добавляем колонки, которых могло не быть в старой схеме
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("PRAGMA table_info(presets)")
        columns = {row[1] for row in await cursor.fetchall()}
        if "is_active" not in columns:
            await db.execute(
                "ALTER TABLE presets ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0"
            )
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


async def has_subscription(telegram_id: int) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT has_subscription FROM telegram_users WHERE telegram_id = ?",
            (telegram_id,),
        )
        row = await cursor.fetchone()
    return bool(row and row[0])


async def get_subscribed_chat_ids() -> list[int]:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT telegram_id FROM telegram_users WHERE has_subscription = 1"
        )
        rows = await cursor.fetchall()
        return [row[0] for row in rows]


async def get_subscribed_users_with_active_presets() -> list[tuple[int, list[dict]]]:
    """Возвращает [(telegram_id, [активные пресеты]), ...] для всех подписчиков."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT telegram_id FROM telegram_users WHERE has_subscription = 1"
        )
        user_ids = [row[0] for row in await cursor.fetchall()]

        result = []
        for uid in user_ids:
            cursor = await db.execute(
                f"{_SELECT_PRESET} WHERE telegram_id = ? AND is_active = 1",
                (uid,),
            )
            rows = await cursor.fetchall()
            result.append((uid, [_row_to_preset(r) for r in rows]))
    return result


# ---------------------------------------------------------------------------
# Пресеты
# ---------------------------------------------------------------------------

def _row_to_preset(row: tuple) -> dict:
    disabled = [e for e in row[8].split(",") if e] if row[8] else []
    return {
        "id": row[0],
        "telegram_id": row[1],
        "name": row[2],
        "is_active": bool(row[3]),
        "min_usd": row[4],
        "max_usd": row[5],
        "min_pct": row[6],
        "max_pct": row[7],
        "disabled_exchanges": disabled,
    }

_SELECT_PRESET = (
    "SELECT id, telegram_id, name, is_active, min_profit_usd, max_profit_usd, "
    "min_profit_pct, max_profit_pct, disabled_exchanges FROM presets"
)


async def get_presets(telegram_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            f"{_SELECT_PRESET} WHERE telegram_id = ? ORDER BY created_at",
            (telegram_id,),
        )
        rows = await cursor.fetchall()
    return [_row_to_preset(r) for r in rows]


async def get_preset_by_id(preset_id: int) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(f"{_SELECT_PRESET} WHERE id = ?", (preset_id,))
        row = await cursor.fetchone()
    return _row_to_preset(row) if row else None


async def toggle_preset_active(preset_id: int) -> bool:
    """Переключает is_active. Возвращает новое состояние."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("SELECT is_active FROM presets WHERE id = ?", (preset_id,))
        row = await cursor.fetchone()
        if not row:
            return False
        new_state = 0 if row[0] else 1
        await db.execute("UPDATE presets SET is_active = ? WHERE id = ?", (new_state, preset_id))
        await db.commit()
    return bool(new_state)


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
