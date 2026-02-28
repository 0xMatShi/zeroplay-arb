import asyncio
import logging
import os

from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

from src.db import get_subscribed_chat_ids, init_db, register_user
from src.ws_client import ArbitrageWSClient

load_dotenv()

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

TELEGRAM_BOT_TOKEN: str = os.environ["TELEGRAM_BOT_TOKEN"]
BACKEND_WS_URL: str = os.getenv("BACKEND_WS_URL", "http://localhost:3000")
ADMIN_API_KEY: str = os.environ["ADMIN_API_KEY"]


# ---------------------------------------------------------------------------
# Команды бота
# ---------------------------------------------------------------------------

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    is_new = await register_user(user.id, user.username, user.first_name)

    if is_new:
        text = (
            f"Привет, {user.first_name}! Вы зарегистрированы.\n\n"
            "Как только вам будет активирована подписка, вы начнёте получать "
            "уведомления об арбитражных возможностях в реальном времени."
        )
        logger.info("Новый пользователь: id=%s username=%s", user.id, user.username)
    else:
        text = f"Вы уже зарегистрированы, {user.first_name}."

    await update.message.reply_text(text)


# ---------------------------------------------------------------------------
# Форматирование уведомлений
# ---------------------------------------------------------------------------

def _format_opportunity(data: dict) -> str:
    profit = float(data.get("profitPercentage", 0))
    total_cost = float(data.get("totalCost", 0))
    match_title = data.get("matchTitle") or "—"
    legs: list[dict] = data.get("legs", [])

    legs_lines = []
    for leg in legs:
        platform = leg.get("platformName", "")
        outcome = leg.get("outcomeName", "")
        price = float(leg.get("price", 0))
        url = leg.get("url", "")
        line = f"  • <b>{outcome}</b> @ {platform}: <code>{price:.4f}</code>"
        if url:
            line += f'\n    <a href="{url}">открыть рынок</a>'
        legs_lines.append(line)

    legs_text = "\n".join(legs_lines) if legs_lines else "  —"

    return (
        f"🔔 <b>Новая арбитражная возможность</b>\n\n"
        f"📊 <b>Событие:</b> {match_title}\n"
        f"💰 <b>Прибыль:</b> {profit:.2f}%\n"
        f"💵 <b>Затраты:</b> {total_cost:.4f}\n\n"
        f"<b>Ноги:</b>\n{legs_text}"
    )


def _format_expired(data: dict) -> str:
    return f"⚠️ Арбитражная возможность <code>{data.get('id', '')[:8]}…</code> истекла."


# ---------------------------------------------------------------------------
# Рассылка
# ---------------------------------------------------------------------------

async def broadcast(app: Application, text: str) -> None:
    chat_ids = await get_subscribed_chat_ids()
    if not chat_ids:
        return
    for chat_id in chat_ids:
        try:
            await app.bot.send_message(chat_id=chat_id, text=text, parse_mode="HTML")
        except Exception as exc:
            logger.warning("Не удалось отправить сообщение %s: %s", chat_id, exc)


# ---------------------------------------------------------------------------
# Точка входа
# ---------------------------------------------------------------------------

async def main() -> None:
    await init_db()

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))

    async def on_new(data: dict) -> None:
        await broadcast(app, _format_opportunity(data))

    async def on_expired(data: dict) -> None:
        await broadcast(app, _format_expired(data))

    ws_client = ArbitrageWSClient(
        url=BACKEND_WS_URL,
        api_key=ADMIN_API_KEY,
        on_new=on_new,
        on_expired=on_expired,
    )

    async with app:
        await app.start()
        await app.updater.start_polling(drop_pending_updates=True)
        logger.info("Бот запущен. Подключаемся к WebSocket...")
        await ws_client.run_forever()  # блокирует до остановки
        await app.updater.stop()
        await app.stop()


