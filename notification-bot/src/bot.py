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

from src.backend_client import verify_api_key
from src.db import (
    create_preset,
    get_preset_by_id,
    get_presets,
    get_subscribed_users_with_active_presets,
    get_user_language,
    has_subscription,
    init_db,
    register_user,
    set_user_language,
    set_user_verified,
    toggle_preset_active,
    update_preset_by_id,
)
from src.i18n import PROFIT_FIELD_KEYS, t
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

EXCHANGES = ["Polymarket", "Probable", "Kalshi", "Predict.fun", "Opinion"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_lang(context: ContextTypes.DEFAULT_TYPE) -> str:
    return context.user_data.get("lang", "ru")


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
# Keyboards
# ---------------------------------------------------------------------------

def _language_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🇷🇺 Русский", callback_data="lang:ru")],
        [InlineKeyboardButton("🇬🇧 English", callback_data="lang:en")],
    ])


def _start_keyboard(lang: str, show_presets: bool = True) -> InlineKeyboardMarkup:
    rows = []
    if show_presets:
        rows.append([InlineKeyboardButton(t(lang, "btn_presets"), callback_data="menu:presets")])
    rows.append([InlineKeyboardButton(t(lang, "btn_change_lang"), callback_data="menu:lang")])
    return InlineKeyboardMarkup(rows)


def _presets_list_keyboard(lang: str, presets: list[dict]) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(
            f"{'🟢' if p['is_active'] else '🔴'} {p['name']}",
            callback_data=f"presets:open:{p['id']}",
        )]
        for p in presets
    ]
    rows.append([InlineKeyboardButton(t(lang, "btn_create_preset"), callback_data="presets:create")])
    rows.append([InlineKeyboardButton(t(lang, "btn_back"), callback_data="menu:back")])
    return InlineKeyboardMarkup(rows)


def _draft_keyboard(lang: str, draft: dict, mode: str) -> InlineKeyboardMarkup:
    name = draft.get("name") or t(lang, "not_set")
    save_label = t(lang, "btn_save_create") if mode == "create" else t(lang, "btn_save_edit")
    cancel_label = t(lang, "btn_cancel_create") if mode == "create" else t(lang, "btn_cancel_edit")

    rows = []
    if mode == "edit":
        is_active = draft.get("is_active", False)
        toggle_label = t(lang, "btn_deactivate") if is_active else t(lang, "btn_activate")
        rows.append([InlineKeyboardButton(toggle_label, callback_data="draft:toggle_active")])

    rows += [
        [InlineKeyboardButton(t(lang, "field_name", name), callback_data="draft:name")],
        [
            InlineKeyboardButton(
                t(lang, "field_min_usd", _fmt_val(draft.get("min_usd"))),
                callback_data="draft:min_usd",
            ),
            InlineKeyboardButton(
                t(lang, "field_max_usd", _fmt_val(draft.get("max_usd"))),
                callback_data="draft:max_usd",
            ),
        ],
        [
            InlineKeyboardButton(
                t(lang, "field_min_pct", _fmt_val(draft.get("min_pct"), "%")),
                callback_data="draft:min_pct",
            ),
            InlineKeyboardButton(
                t(lang, "field_max_pct", _fmt_val(draft.get("max_pct"), "%")),
                callback_data="draft:max_pct",
            ),
        ],
        [InlineKeyboardButton(t(lang, "btn_exchanges"), callback_data="draft:exchanges")],
        [InlineKeyboardButton(save_label, callback_data="draft:save")],
        [InlineKeyboardButton(cancel_label, callback_data="draft:cancel")],
    ]
    return InlineKeyboardMarkup(rows)


def _draft_exchanges_keyboard(lang: str, disabled: list[str]) -> InlineKeyboardMarkup:
    rows = []
    for i in range(0, len(EXCHANGES), 2):
        row = []
        for ex in EXCHANGES[i : i + 2]:
            circle = "🔴" if ex in disabled else "🟢"
            row.append(InlineKeyboardButton(f"{circle} {ex}", callback_data=f"draft:exchange:{ex}"))
        rows.append(row)
    rows.append([InlineKeyboardButton(t(lang, "btn_back"), callback_data="draft:exchange:back")])
    return InlineKeyboardMarkup(rows)


def _cancel_input_keyboard(lang: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton(t(lang, "btn_cancel_input"), callback_data="draft:input:cancel")]])


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    is_new = await register_user(user.id, user.username, user.first_name)

    lang = await get_user_language(user.id)
    context.user_data["lang"] = lang

    if is_new:
        logger.info("New user: id=%s username=%s", user.id, user.username)
        # Show language selection for new users
        await update.message.reply_text(
            "Выберите язык / Choose language:",
            reply_markup=_language_keyboard(),
        )
        return

    subscribed = await has_subscription(user.id)
    if not subscribed:
        # Existing user but not verified yet — restart onboarding
        await update.message.reply_text(
            "Выберите язык / Choose language:",
            reply_markup=_language_keyboard(),
        )
        return

    # Verified user — show main menu
    context.user_data.pop("awaiting", None)
    await update.message.reply_text(
        t(lang, "main_menu"),
        reply_markup=_start_keyboard(lang, show_presets=True),
    )


# ---------------------------------------------------------------------------
# Callback handlers
# ---------------------------------------------------------------------------

async def cb_lang(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handles language selection (both onboarding and change from main menu)."""
    query = update.callback_query
    await query.answer()
    lang = query.data.split(":")[1]

    await set_user_language(query.from_user.id, lang)
    context.user_data["lang"] = lang

    subscribed = await has_subscription(query.from_user.id)
    if subscribed:
        # Language change from main menu — just update and return to menu
        await query.edit_message_text(
            t(lang, "main_menu"),
            reply_markup=_start_keyboard(lang, show_presets=True),
        )
        return

    # Onboarding — ask for API key
    context.user_data["awaiting"] = "api_key"
    await query.edit_message_text(t(lang, "enter_api_key"))


async def cb_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    action = query.data.split(":")[1]
    lang = _get_lang(context)

    if action == "presets":
        presets = await get_presets(query.from_user.id)
        text = t(lang, "presets_header") if presets else t(lang, "no_presets")
        await query.edit_message_text(text, reply_markup=_presets_list_keyboard(lang, presets))
    elif action == "lang":
        await query.edit_message_text(
            "Выберите язык / Choose language:",
            reply_markup=_language_keyboard(),
        )
    elif action == "back":
        subscribed = await has_subscription(query.from_user.id)
        await query.edit_message_text(
            t(lang, "main_menu"),
            reply_markup=_start_keyboard(lang, show_presets=subscribed),
        )


async def cb_presets(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    lang = _get_lang(context)

    if parts[1] == "create":
        context.user_data["mode"] = "create"
        context.user_data["draft"] = _empty_draft()
        context.user_data["preset_msg_id"] = query.message.message_id
        await query.edit_message_text(
            t(lang, "preset_create_title"),
            reply_markup=_draft_keyboard(lang, context.user_data["draft"], "create"),
        )
    elif parts[1] == "open":
        preset_id = int(parts[2])
        preset = await get_preset_by_id(preset_id)
        if not preset:
            await query.answer("Preset not found.", show_alert=True)
            return
        context.user_data["mode"] = "edit"
        context.user_data["editing_id"] = preset_id
        context.user_data["draft"] = _preset_to_draft(preset)
        context.user_data["preset_msg_id"] = query.message.message_id
        await query.edit_message_text(
            t(lang, "preset_edit_title", preset["name"]),
            reply_markup=_draft_keyboard(lang, context.user_data["draft"], "edit"),
        )


async def cb_draft(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    action = parts[1]
    lang = _get_lang(context)

    draft = context.user_data.get("draft", _empty_draft())
    mode = context.user_data.get("mode", "create")

    def _draft_title() -> str:
        if mode == "create":
            return t(lang, "preset_create_title")
        return t(lang, "preset_edit_title", draft.get("name", ""))

    if action == "toggle_active":
        preset_id = context.user_data.get("editing_id")
        new_state = await toggle_preset_active(preset_id)
        draft["is_active"] = new_state
        context.user_data["draft"] = draft
        await query.edit_message_reply_markup(reply_markup=_draft_keyboard(lang, draft, mode))

    elif action == "name":
        context.user_data["awaiting"] = "name"
        await query.edit_message_text(
            t(lang, "enter_name"), reply_markup=_cancel_input_keyboard(lang)
        )

    elif action in PROFIT_FIELD_KEYS:
        label_key = PROFIT_FIELD_KEYS[action]
        context.user_data["awaiting"] = action
        await query.edit_message_text(
            t(lang, "enter_value", t(lang, label_key)),
            parse_mode="HTML",
            reply_markup=_cancel_input_keyboard(lang),
        )

    elif action == "exchanges":
        await query.edit_message_text(
            t(lang, "exchanges_title"),
            reply_markup=_draft_exchanges_keyboard(lang, draft.get("disabled_exchanges", [])),
        )

    elif action == "exchange":
        exchange = parts[2]
        if exchange == "back":
            await query.edit_message_text(
                _draft_title(), reply_markup=_draft_keyboard(lang, draft, mode)
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
                reply_markup=_draft_exchanges_keyboard(lang, disabled)
            )

    elif action == "input":
        context.user_data.pop("awaiting", None)
        await query.edit_message_text(_draft_title(), reply_markup=_draft_keyboard(lang, draft, mode))

    elif action == "save":
        name = (draft.get("name") or "").strip() or "—"
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
        text = t(lang, "presets_header") if presets else t(lang, "no_presets")
        await query.edit_message_text(text, reply_markup=_presets_list_keyboard(lang, presets))

    elif action == "cancel":
        _clear_draft(context)
        presets = await get_presets(query.from_user.id)
        text = t(lang, "presets_header") if presets else t(lang, "no_presets")
        await query.edit_message_text(text, reply_markup=_presets_list_keyboard(lang, presets))


def _clear_draft(context: ContextTypes.DEFAULT_TYPE) -> None:
    for key in ("draft", "mode", "editing_id", "awaiting", "preset_msg_id"):
        context.user_data.pop(key, None)


async def on_text_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    awaiting = context.user_data.get("awaiting")
    lang = _get_lang(context)

    # --- API key verification flow ---
    if awaiting == "api_key":
        api_key = update.message.text.strip()
        try:
            await update.message.delete()
        except Exception:
            pass

        result = await verify_api_key(api_key, update.effective_user.id)
        if result is None:
            await update.effective_chat.send_message(t(lang, "api_key_error"))
            return
        if not result:
            await update.effective_chat.send_message(
                t(lang, "api_key_invalid"),
            )
            return

        # Valid key
        await set_user_verified(update.effective_user.id)
        context.user_data.pop("awaiting", None)
        await update.effective_chat.send_message(
            t(lang, "api_key_valid"),
        )
        await update.effective_chat.send_message(
            t(lang, "main_menu"),
            reply_markup=_start_keyboard(lang, show_presets=True),
        )
        return

    # --- Draft field input ---
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
            await update.message.reply_text(t(lang, "invalid_number"))
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
            t(lang, "preset_create_title")
            if mode == "create"
            else t(lang, "preset_edit_title", draft.get("name", ""))
        )
        await context.bot.edit_message_text(
            chat_id=update.effective_chat.id,
            message_id=msg_id,
            text=title,
            reply_markup=_draft_keyboard(lang, draft, mode),
        )


# ---------------------------------------------------------------------------
# Opportunity formatting
# ---------------------------------------------------------------------------

def _format_opportunity(data: dict, lang: str, preset_name: str | None = None) -> str:
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
    preset_line = t(lang, "opp_preset", preset_name) + "\n" if preset_name else ""
    profit_usd_line = (
        t(lang, "opp_profit_usd", float(gross_profit)) + "\n" if gross_profit is not None else ""
    )
    investment_line = (
        t(lang, "opp_investment", float(total_investment)) + "\n" if total_investment is not None else ""
    )
    shares_line = (
        t(lang, "opp_shares", float(total_shares)) + "\n" if total_shares is not None else ""
    )

    legs_lines = []
    for leg in legs:
        platform = leg.get("platformName", "")
        outcome = leg.get("outcomeName", "")
        price = float(leg.get("price", 0))
        url = leg.get("url", "")
        line = f"  • <b>{outcome}</b> @ {platform}: <code>{price:.4f}</code>"
        if url:
            line += f'\n    <a href="{url}">{t(lang, "opp_open_event")}</a>'
        legs_lines.append(line)

    legs_text = "\n".join(legs_lines) if legs_lines else "  —"

    return (
        f"{t(lang, 'opp_title')}\n"
        f"{preset_line}\n"
        f"{t(lang, 'opp_event')}\n{event_lines}\n\n"
        f"{t(lang, 'opp_total_avg', total_cost)}\n"
        f"{t(lang, 'opp_profit_pct', profit_pct)}\n"
        f"{profit_usd_line}"
        f"{investment_line}"
        f"{shares_line}"
        f"\n{t(lang, 'opp_legs')}\n{legs_text}"
    )


# ---------------------------------------------------------------------------
# Preset filtering
# ---------------------------------------------------------------------------

def _matches_preset(data: dict, preset: dict) -> bool:
    profit_pct = float(data.get("profitPercentage", 0))
    gross_profit = data.get("totalGrossProfit")
    platforms = {leg.get("platformName", "") for leg in data.get("legs", [])}

    if preset["min_pct"] is not None and profit_pct < preset["min_pct"]:
        return False
    if preset["max_pct"] is not None and profit_pct > preset["max_pct"]:
        return False
    if preset["min_usd"] is not None:
        if gross_profit is None or float(gross_profit) < preset["min_usd"]:
            return False
    if preset["max_usd"] is not None:
        if gross_profit is None or float(gross_profit) > preset["max_usd"]:
            return False
    if platforms & set(preset["disabled_exchanges"]):
        return False
    return True


# ---------------------------------------------------------------------------
# Broadcast
# ---------------------------------------------------------------------------

async def broadcast_opportunity(app: Application, data: dict) -> None:
    """Broadcasts new opportunity only to users with a matching active preset."""
    users = await get_subscribed_users_with_active_presets()
    if not users:
        return

    for telegram_id, lang, active_presets in users:
        if not active_presets:
            logger.debug("Skip %s: no active presets", telegram_id)
            continue

        matched = next((p for p in active_presets if _matches_preset(data, p)), None)
        if matched is None:
            logger.debug("Skip %s: no matching preset", telegram_id)
            continue

        text = _format_opportunity(data, lang, preset_name=matched["name"])
        try:
            await app.bot.send_message(
                chat_id=telegram_id,
                text=text,
                parse_mode="HTML",
                disable_web_page_preview=True,
            )
        except Exception as exc:
            logger.warning("Failed to send message to %s: %s", telegram_id, exc)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main() -> None:
    await init_db()

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CallbackQueryHandler(cb_lang, pattern="^lang:"))
    app.add_handler(CallbackQueryHandler(cb_menu, pattern="^menu:"))
    app.add_handler(CallbackQueryHandler(cb_presets, pattern="^presets:"))
    app.add_handler(CallbackQueryHandler(cb_draft, pattern="^draft:"))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text_input))

    await app.bot.set_my_commands([
        BotCommand("start", "Start / Начать"),
    ])

    async def on_new(data: dict) -> None:
        await broadcast_opportunity(app, data)

    ws_client = ArbitrageWSClient(
        url=BACKEND_WS_URL,
        api_key=ADMIN_API_KEY,
        on_new=on_new,
    )

    async with app:
        await app.start()
        await app.updater.start_polling(drop_pending_updates=True)
        logger.info("Bot started. Connecting to WebSocket...")
        await ws_client.run_forever()
        await app.updater.stop()
        await app.stop()
