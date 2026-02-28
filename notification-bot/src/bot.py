import asyncio
import logging
import os

from dotenv import load_dotenv
from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from src.db import (
    create_preset,
    get_preset_by_id,
    get_presets,
    get_subscribed_chat_ids,
    get_subscribed_users_with_active_presets,
    has_subscription,
    init_db,
    register_user,
    toggle_preset_active,
    update_preset_by_id,
)
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

EXCHANGES = ["Polymarket", "Probable", "Kalshi", "Predict.Fun"]

PROFIT_LABELS = {
    "min_usd": "Min Profit($)",
    "max_usd": "Max Profit($)",
    "min_pct": "Min Profit(%)",
    "max_pct": "Max Profit(%)",
}

_START_TEXT = "Главное меню"


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def _fmt_val(val: float | None, suffix: str = "") -> str:
    return f"{val:.2f}{suffix}" if val is not None else "—"


def _empty_draft() -> dict:
    return {
        "name": "",
        "min_usd": None,
        "max_usd": None,
        "min_pct": None,
        "max_pct": None,
        "disabled_exchanges": [],
    }


def _preset_to_draft(preset: dict) -> dict:
    return {
        "name": preset["name"],
        "is_active": preset["is_active"],
        "min_usd": preset["min_usd"],
        "max_usd": preset["max_usd"],
        "min_pct": preset["min_pct"],
        "max_pct": preset["max_pct"],
        "disabled_exchanges": list(preset["disabled_exchanges"]),
    }


# ---------------------------------------------------------------------------
# Клавиатуры
# ---------------------------------------------------------------------------

def _start_keyboard(show_presets: bool = True) -> InlineKeyboardMarkup:
    if show_presets:
        return InlineKeyboardMarkup([[InlineKeyboardButton("Пресеты", callback_data="menu:presets")]])
    return InlineKeyboardMarkup([])


def _presets_list_keyboard(presets: list[dict]) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(
            f"{'🟢' if p['is_active'] else '🔴'} {p['name']}",
            callback_data=f"presets:open:{p['id']}",
        )]
        for p in presets
    ]
    rows.append([InlineKeyboardButton("➕ Создать пресет", callback_data="presets:create")])
    rows.append([InlineKeyboardButton("← Назад", callback_data="menu:back")])
    return InlineKeyboardMarkup(rows)


def _draft_keyboard(draft: dict, mode: str) -> InlineKeyboardMarkup:
    name = draft.get("name") or "не задано"
    save_label = "✅ Создать пресет" if mode == "create" else "✅ Применить изменения"
    cancel_label = "❌ Отменить создание" if mode == "create" else "❌ Отменить изменения"

    rows = []
    if mode == "edit":
        is_active = draft.get("is_active", False)
        toggle_label = "🔴 Деактивировать пресет" if is_active else "🟢 Активировать пресет"
        rows.append([InlineKeyboardButton(toggle_label, callback_data="draft:toggle_active")])

    rows += [
        [InlineKeyboardButton(f"Название: {name}", callback_data="draft:name")],
        [
            InlineKeyboardButton(
                f"Min Profit($): {_fmt_val(draft.get('min_usd'))}",
                callback_data="draft:min_usd",
            ),
            InlineKeyboardButton(
                f"Max Profit($): {_fmt_val(draft.get('max_usd'))}",
                callback_data="draft:max_usd",
            ),
        ],
        [
            InlineKeyboardButton(
                f"Min Profit(%): {_fmt_val(draft.get('min_pct'), '%')}",
                callback_data="draft:min_pct",
            ),
            InlineKeyboardButton(
                f"Max Profit(%): {_fmt_val(draft.get('max_pct'), '%')}",
                callback_data="draft:max_pct",
            ),
        ],
        [InlineKeyboardButton("Биржи", callback_data="draft:exchanges")],
        [InlineKeyboardButton(save_label, callback_data="draft:save")],
        [InlineKeyboardButton(cancel_label, callback_data="draft:cancel")],
    ]
    return InlineKeyboardMarkup(rows)


def _draft_exchanges_keyboard(disabled: list[str]) -> InlineKeyboardMarkup:
    rows = []
    for i in range(0, len(EXCHANGES), 2):
        row = []
        for ex in EXCHANGES[i : i + 2]:
            circle = "🔴" if ex in disabled else "🟢"
            row.append(InlineKeyboardButton(f"{circle} {ex}", callback_data=f"draft:exchange:{ex}"))
        rows.append(row)
    rows.append([InlineKeyboardButton("← Назад", callback_data="draft:exchange:back")])
    return InlineKeyboardMarkup(rows)


def _cancel_input_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("Отмена", callback_data="draft:input:cancel")]])


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

    subscribed = await has_subscription(user.id)
    await update.message.reply_text(text, reply_markup=_start_keyboard(show_presets=subscribed))


# ---------------------------------------------------------------------------
# Callback-обработчики
# ---------------------------------------------------------------------------

async def cb_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    action = query.data.split(":")[1]

    if action == "presets":
        presets = await get_presets(query.from_user.id)
        text = "Ваши пресеты:" if presets else "У вас пока нет пресетов."
        await query.edit_message_text(text, reply_markup=_presets_list_keyboard(presets))
    elif action == "back":
        subscribed = await has_subscription(query.from_user.id)
        await query.edit_message_text(_START_TEXT, reply_markup=_start_keyboard(show_presets=subscribed))


async def cb_presets(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")

    if parts[1] == "create":
        context.user_data["mode"] = "create"
        context.user_data["draft"] = _empty_draft()
        context.user_data["preset_msg_id"] = query.message.message_id
        await query.edit_message_text(
            "Создание нового пресета",
            reply_markup=_draft_keyboard(context.user_data["draft"], "create"),
        )
    elif parts[1] == "open":
        preset_id = int(parts[2])
        preset = await get_preset_by_id(preset_id)
        if not preset:
            await query.answer("Пресет не найден.", show_alert=True)
            return
        context.user_data["mode"] = "edit"
        context.user_data["editing_id"] = preset_id
        context.user_data["draft"] = _preset_to_draft(preset)
        context.user_data["preset_msg_id"] = query.message.message_id
        await query.edit_message_text(
            f"Редактирование пресета «{preset['name']}»",
            reply_markup=_draft_keyboard(context.user_data["draft"], "edit"),
        )


async def cb_draft(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    action = parts[1]

    draft = context.user_data.get("draft", _empty_draft())
    mode = context.user_data.get("mode", "create")

    def _draft_title() -> str:
        if mode == "create":
            return "Создание нового пресета"
        return f"Редактирование пресета «{draft.get('name', '')}»"

    if action == "toggle_active":
        preset_id = context.user_data.get("editing_id")
        new_state = await toggle_preset_active(preset_id)
        draft["is_active"] = new_state
        context.user_data["draft"] = draft
        await query.edit_message_reply_markup(reply_markup=_draft_keyboard(draft, mode))

    elif action == "name":
        context.user_data["awaiting"] = "name"
        await query.edit_message_text(
            "Введите название пресета:", reply_markup=_cancel_input_keyboard()
        )

    elif action in PROFIT_LABELS:
        label = PROFIT_LABELS[action]
        context.user_data["awaiting"] = action
        await query.edit_message_text(
            f"Введите значение для <b>{label}</b>:\n\nОтправьте число (или 0 для отключения фильтра)",
            parse_mode="HTML",
            reply_markup=_cancel_input_keyboard(),
        )

    elif action == "exchanges":
        await query.edit_message_text(
            "Выберите биржи для отслеживания:",
            reply_markup=_draft_exchanges_keyboard(draft.get("disabled_exchanges", [])),
        )

    elif action == "exchange":
        exchange = parts[2]
        if exchange == "back":
            await query.edit_message_text(
                _draft_title(), reply_markup=_draft_keyboard(draft, mode)
            )
        else:
            disabled = draft.get("disabled_exchanges", [])
            if exchange in disabled:
                disabled.remove(exchange)
            else:
                disabled.append(exchange)
            draft["disabled_exchanges"] = disabled
            context.user_data["draft"] = draft
            await query.edit_message_reply_markup(
                reply_markup=_draft_exchanges_keyboard(disabled)
            )

    elif action == "input":
        # отмена ввода текста/числа
        context.user_data.pop("awaiting", None)
        await query.edit_message_text(_draft_title(), reply_markup=_draft_keyboard(draft, mode))

    elif action == "save":
        name = (draft.get("name") or "").strip() or "Без названия"
        if mode == "create":
            await create_preset(
                query.from_user.id,
                name,
                draft.get("min_usd"),
                draft.get("max_usd"),
                draft.get("min_pct"),
                draft.get("max_pct"),
                draft.get("disabled_exchanges", []),
            )
        else:
            await update_preset_by_id(
                context.user_data["editing_id"],
                name,
                draft.get("min_usd"),
                draft.get("max_usd"),
                draft.get("min_pct"),
                draft.get("max_pct"),
                draft.get("disabled_exchanges", []),
            )
        _clear_draft(context)
        presets = await get_presets(query.from_user.id)
        text = "Ваши пресеты:" if presets else "У вас пока нет пресетов."
        await query.edit_message_text(text, reply_markup=_presets_list_keyboard(presets))

    elif action == "cancel":
        _clear_draft(context)
        presets = await get_presets(query.from_user.id)
        text = "Ваши пресеты:" if presets else "У вас пока нет пресетов."
        await query.edit_message_text(text, reply_markup=_presets_list_keyboard(presets))


def _clear_draft(context: ContextTypes.DEFAULT_TYPE) -> None:
    for key in ("draft", "mode", "editing_id", "awaiting", "preset_msg_id"):
        context.user_data.pop(key, None)


async def on_text_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    awaiting = context.user_data.get("awaiting")
    if not awaiting:
        return

    draft = context.user_data.get("draft", _empty_draft())
    mode = context.user_data.get("mode", "create")

    if awaiting == "name":
        draft["name"] = update.message.text.strip()
    else:
        try:
            raw = float(update.message.text.replace(",", "."))
            draft[awaiting] = raw if raw > 0 else None
        except ValueError:
            await update.message.reply_text("Пожалуйста, введите число.")
            return

    context.user_data["draft"] = draft
    context.user_data.pop("awaiting", None)

    try:
        await update.message.delete()
    except Exception:
        pass

    msg_id = context.user_data.get("preset_msg_id")
    if msg_id:
        title = (
            "Создание нового пресета"
            if mode == "create"
            else f"Редактирование пресета «{draft.get('name', '')}»"
        )
        await context.bot.edit_message_text(
            chat_id=update.effective_chat.id,
            message_id=msg_id,
            text=title,
            reply_markup=_draft_keyboard(draft, mode),
        )


# ---------------------------------------------------------------------------
# Форматирование уведомлений
# ---------------------------------------------------------------------------

def _format_opportunity(data: dict, preset_name: str | None = None) -> str:
    profit_pct = float(data.get("profitPercentage", 0))
    total_cost = float(data.get("totalCost", 0))
    gross_profit = data.get("totalGrossProfit")
    total_investment = data.get("totalInvestment")
    total_shares = data.get("totalShares")
    legs: list[dict] = data.get("legs", [])

    event_lines = "\n".join(
        f"{leg.get('eventTitle') or '—'} ({leg.get('platformName', '')})"
        for leg in legs
    )
    preset_line = f"Пресет: «{preset_name}»\n" if preset_name else ""
    profit_usd_line = (
        f"Прибыль($): <b>${float(gross_profit):.2f}</b>\n" if gross_profit is not None else ""
    )
    investment_line = (
        f"Затраты: <b>${float(total_investment):.2f}</b>\n" if total_investment is not None
        else f"Затраты: <code>{total_cost:.4f}</code>\n"
    )
    shares_line = (
        f"Купить акций: <b>{float(total_shares):.2f}</b>\n" if total_shares is not None else ""
    )

    legs_lines = []
    for leg in legs:
        platform = leg.get("platformName", "")
        outcome = leg.get("outcomeName", "")
        price = float(leg.get("price", 0))
        url = leg.get("url", "")
        line = f"  • <b>{outcome}</b> @ {platform}: <code>{price:.4f}</code>"
        if url:
            line += f'\n    <a href="{url}">Открыть событие</a>'
        legs_lines.append(line)

    legs_text = "\n".join(legs_lines) if legs_lines else "  —"

    return (
        f"🔔 <b>Новая арбитражная возможность</b>\n"
        f"{preset_line}\n"
        f"📊 <b>Событие:</b>\n{event_lines}\n\n"
        f"Total Avg: <code>{total_cost:.4f}</code>\n"
        f"Прибыль(%): <b>{profit_pct:.2f}%</b>\n"
        f"{profit_usd_line}"
        f"{investment_line}"
        f"{shares_line}"
        f"\n<b>Ноги:</b>\n{legs_text}"
    )


def _format_expired(data: dict) -> str:
    return f"⚠️ Арбитражная возможность <code>{data.get('id', '')[:8]}…</code> истекла."


# ---------------------------------------------------------------------------
# Фильтрация по пресетам
# ---------------------------------------------------------------------------

def _matches_preset(data: dict, preset: dict) -> bool:
    profit_pct = float(data.get("profitPercentage", 0))
    total_cost = float(data.get("totalCost", 0))
    platforms = {leg.get("platformName", "") for leg in data.get("legs", [])}

    if preset["min_pct"] is not None and profit_pct < preset["min_pct"]:
        return False
    if preset["max_pct"] is not None and profit_pct > preset["max_pct"]:
        return False
    if preset["min_usd"] is not None and total_cost < preset["min_usd"]:
        return False
    if preset["max_usd"] is not None and total_cost > preset["max_usd"]:
        return False
    if platforms & set(preset["disabled_exchanges"]):
        return False
    return True


# ---------------------------------------------------------------------------
# Рассылка
# ---------------------------------------------------------------------------

async def broadcast_opportunity(app: Application, data: dict) -> None:
    """Рассылает новую возможность только пользователям с активным пресетом, который совпал."""
    users = await get_subscribed_users_with_active_presets()
    if not users:
        return

    for telegram_id, active_presets in users:
        if not active_presets:
            logger.debug("Пропуск %s: нет активных пресетов", telegram_id)
            continue

        matched = next((p for p in active_presets if _matches_preset(data, p)), None)
        if matched is None:
            logger.debug("Пропуск %s: ни один пресет не совпал", telegram_id)
            continue

        text = _format_opportunity(data, preset_name=matched["name"])
        try:
            await app.bot.send_message(
                chat_id=telegram_id,
                text=text,
                parse_mode="HTML",
                disable_web_page_preview=True,
            )
        except Exception as exc:
            logger.warning("Не удалось отправить сообщение %s: %s", telegram_id, exc)


async def broadcast_expired(app: Application, data: dict) -> None:
    """Рассылает истечение возможности всем подписчикам без фильтрации."""
    chat_ids = await get_subscribed_chat_ids()
    text = _format_expired(data)
    for chat_id in chat_ids:
        try:
            await app.bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode="HTML",
                disable_web_page_preview=True,
            )
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
    app.add_handler(CallbackQueryHandler(cb_presets, pattern="^presets:"))
    app.add_handler(CallbackQueryHandler(cb_draft, pattern="^draft:"))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text_input))

    await app.bot.set_my_commands([
        BotCommand("start", "Зарегистрироваться и получать уведомления"),
    ])

    async def on_new(data: dict) -> None:
        await broadcast_opportunity(app, data)

    async def on_expired(data: dict) -> None:
        await broadcast_expired(app, data)

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
