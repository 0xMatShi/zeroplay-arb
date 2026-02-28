import asyncio
import logging
import os

from dotenv import load_dotenv
from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

from src.db import get_preset, get_subscribed_chat_ids, init_db, register_user, toggle_exchange, update_preset
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
# Клавиатуры
# ---------------------------------------------------------------------------

EXCHANGES = ["Polymarket", "Probable", "Kalshi", "Predict.Fun"]

PROFIT_LABELS = {
    "min_usd": "Min Profit($)",
    "max_usd": "Max Profit($)",
    "min_pct": "Min Profit(%)",
    "max_pct": "Max Profit(%)",
}


def _start_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("Пресеты", callback_data="menu:presets")]])


def _presets_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("Min Profit($)", callback_data="preset:min_usd"),
            InlineKeyboardButton("Max Profit($)", callback_data="preset:max_usd"),
        ],
        [
            InlineKeyboardButton("Min Profit(%)", callback_data="preset:min_pct"),
            InlineKeyboardButton("Max Profit(%)", callback_data="preset:max_pct"),
        ],
        [InlineKeyboardButton("Биржи", callback_data="preset:exchanges")],
        [InlineKeyboardButton("← Назад", callback_data="menu:back")],
    ])


def _exchanges_keyboard(disabled: list[str]) -> InlineKeyboardMarkup:
    rows = []
    for i in range(0, len(EXCHANGES), 2):
        row = []
        for ex in EXCHANGES[i : i + 2]:
            circle = "🔴" if ex in disabled else "🟢"
            row.append(InlineKeyboardButton(f"{circle} {ex}", callback_data=f"exchange:{ex}"))
        rows.append(row)
    rows.append([InlineKeyboardButton("← Назад", callback_data="exchange:back")])
    return InlineKeyboardMarkup(rows)


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

    await update.message.reply_text(text, reply_markup=_start_keyboard())


# ---------------------------------------------------------------------------
# Callback-обработчики inline-кнопок
# ---------------------------------------------------------------------------

_START_TEXT = "Главное меню"


async def cb_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    action = query.data.split(":")[1]

    if action == "presets":
        await query.edit_message_text(
            "Создайте и настройте пресеты для уведомлений",
            reply_markup=_presets_keyboard(),
        )
    elif action == "back":
        await query.edit_message_text(_START_TEXT, reply_markup=_start_keyboard())


async def cb_preset(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    action = parts[1]

    if action in PROFIT_LABELS:
        label = PROFIT_LABELS[action]
        context.user_data["awaiting"] = action
        context.user_data["preset_msg_id"] = query.message.message_id
        await query.edit_message_text(
            f"Введите значение для <b>{label}</b>:\n\nОтправьте число (или 0 для отключения фильтра)",
            parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton("Отмена", callback_data="preset:cancel")]]
            ),
        )
    elif action == "exchanges":
        preset = await get_preset(query.from_user.id)
        await query.edit_message_text(
            "Выберите биржи для отслеживания:",
            reply_markup=_exchanges_keyboard(preset["disabled_exchanges"]),
        )
    elif action == "cancel":
        context.user_data.pop("awaiting", None)
        context.user_data.pop("preset_msg_id", None)
        await query.edit_message_text(
            "Создайте и настройте пресеты для уведомлений",
            reply_markup=_presets_keyboard(),
        )


async def cb_exchange(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    exchange = query.data.split(":", 1)[1]

    if exchange == "back":
        await query.edit_message_text(
            "Создайте и настройте пресеты для уведомлений",
            reply_markup=_presets_keyboard(),
        )
    else:
        await toggle_exchange(query.from_user.id, exchange)
        preset = await get_preset(query.from_user.id)
        await query.edit_message_reply_markup(
            reply_markup=_exchanges_keyboard(preset["disabled_exchanges"])
        )


async def on_text_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    awaiting = context.user_data.get("awaiting")
    if not awaiting:
        return

    try:
        value = float(update.message.text.replace(",", "."))
    except ValueError:
        await update.message.reply_text("Пожалуйста, введите число.")
        return

    await update_preset(update.effective_user.id, awaiting, value)

    try:
        await update.message.delete()
    except Exception:
        pass

    msg_id = context.user_data.pop("preset_msg_id", None)
    context.user_data.pop("awaiting", None)

    if msg_id:
        await context.bot.edit_message_text(
            chat_id=update.effective_chat.id,
            message_id=msg_id,
            text="Создайте и настройте пресеты для уведомлений",
            reply_markup=_presets_keyboard(),
        )


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
    app.add_handler(CallbackQueryHandler(cb_menu, pattern="^menu:"))
    app.add_handler(CallbackQueryHandler(cb_preset, pattern="^preset:"))
    app.add_handler(CallbackQueryHandler(cb_exchange, pattern="^exchange:"))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text_input))

    await app.bot.set_my_commands([
        BotCommand("start", "Зарегистрироваться и получать уведомления"),
    ])

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


