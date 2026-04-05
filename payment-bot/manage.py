import asyncio
import os
import secrets
import sqlite3
from datetime import datetime, timezone, timedelta

import aiohttp
from aiogram import Bot
from dotenv import load_dotenv
from InquirerPy import inquirer

# Загружаем переменные окружения
load_dotenv()

DB_PATH = "data/bot.db"


def clear() -> None:
    os.system("cls" if os.name == "nt" else "clear")
MSK = timezone(timedelta(hours=3))


async def get_bot_username() -> str:
    """Получает username бота через Telegram API."""
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        return "DAOPayment_Bot"

    try:
        bot = Bot(token=token)
        bot_info = await bot.get_me()
        await bot.session.close()
        return bot_info.username if bot_info and bot_info.username else "DAOPayment_Bot"
    except Exception as e:
        print(f"Ошибка при получении информации о боте: {e}")
        return "DAOPayment_Bot"


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_all_users() -> list[dict]:
    """Получает всех пользователей из user_profiles."""
    conn = get_connection()
    cursor = conn.cursor()

    # Берем всех пользователей из user_profiles
    cursor.execute("""
        SELECT user_id, username, first_name, last_name
        FROM user_profiles
        ORDER BY user_id
    """)
    users = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return users


def get_active_users_list() -> list[dict]:
    """Получает пользователей с активной подпиской."""
    import sys
    sys.path.insert(0, ".")
    from src.payments import get_active_users
    return get_active_users()


def get_user_subscription(user_id: int) -> dict | None:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT plan, status, expires_at FROM subscriptions "
        "WHERE user_id = ? AND status = 'active' "
        "ORDER BY created_at DESC LIMIT 1",
        (user_id,),
    )
    row = cursor.fetchone()
    conn.close()
    if row:
        return dict(row)
    return None


def format_expires(expires_at: str | None) -> str:
    if not expires_at:
        return "Навсегда"
    dt = datetime.fromisoformat(expires_at).astimezone(MSK)
    return f"{dt.strftime('%d.%m.%Y %H:%M:%S')} (по МСК)"


PLAN_LABELS = {
    "1week":   "1 неделя",
    "1month":  "1 месяц",
    "3months": "3 месяца",
}


def format_user_display(user: dict) -> str:
    """Форматирует отображение пользователя: ID | @username или ID | FirstName."""
    user_id = user["user_id"]
    username = user.get("username")
    first_name = user.get("first_name")

    if username:
        return f"{user_id} | @{username}"
    elif first_name:
        return f"{user_id} | {first_name}"
    else:
        return str(user_id)


def change_plan(user_id: int) -> None:
    plan_choices = [f"{pid} ({label})" for pid, label in PLAN_LABELS.items()]
    plan_choices.append("< Отмена")

    selected = inquirer.select(  # type: ignore
        message="Выберите новый план:",
        choices=plan_choices,
    ).execute()

    if selected == "< Отмена":
        return

    new_plan = selected.split(" (")[0]

    conn = get_connection()
    cursor = conn.cursor()

    days = {"1week": 7, "1month": 30, "3months": 90}[new_plan]
    expires_at = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()

    cursor.execute("DELETE FROM subscriptions WHERE user_id = ?", (user_id,))
    cursor.execute(
        "INSERT INTO subscriptions (user_id, plan, status, expires_at) VALUES (?, ?, 'active', ?)",
        (user_id, new_plan, expires_at),
    )

    conn.commit()
    conn.close()
    print(f"\nПлан изменён на {PLAN_LABELS[new_plan]}.\n")


def add_days(user_id: int) -> None:
    sub = get_user_subscription(user_id)
    if not sub:
        print("\nУ пользователя нет активной подписки.\n")
        return
    if not sub["expires_at"]:
        print("\nПодписка бессрочная, добавление дней не требуется.\n")
        return

    days_str = inquirer.text(message="Количество дней:").execute()  # type: ignore
    try:
        days = int(days_str)
    except ValueError:
        print("\nНекорректное число.\n")
        return

    current_expires = datetime.fromisoformat(sub["expires_at"])
    new_expires = current_expires + timedelta(days=days)

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE subscriptions SET expires_at = ? WHERE user_id = ? AND status = 'active'",
        (new_expires.isoformat(), user_id),
    )
    conn.commit()
    conn.close()
    print(f"\nДобавлено {days} дн. Новый срок: {format_expires(new_expires.isoformat())}\n")


def cancel_subscription(user_id: int) -> None:
    sub = get_user_subscription(user_id)
    if not sub:
        print("\nУ пользователя нет активной подписки.\n")
        return

    confirm = inquirer.select(  # type: ignore
        message=f"Отменить подписку \"{PLAN_LABELS.get(sub['plan'], sub['plan'])}\"?",
        choices=["Да", "Нет"],
    ).execute()

    if confirm != "Да":
        return

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM subscriptions WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()
    print("\nПодписка отменена.\n")


def show_user_detail(user: dict) -> None:
    import sys
    sys.path.insert(0, ".")
    from src.payments import get_user_referral_info, get_user_own_referral_code

    while True:
        clear()
        sub = get_user_subscription(user["user_id"])
        ref_info = get_user_referral_info(user["user_id"])

        print("=" * 50)
        print(f"  ID:          {user['user_id']}")
        if user.get("username"):
            print(f"  Username:    @{user['username']}")
        if user.get("first_name"):
            name = user['first_name']
            if user.get("last_name"):
                name += f" {user['last_name']}"
            print(f"  Имя:         {name}")
        if sub:
            print(f"  Подписка:    {PLAN_LABELS.get(sub['plan'], sub['plan'])}")
            print(f"  Истекает:    {format_expires(sub['expires_at'])}")
        else:
            print("  Подписка:    нет")

        # Показываем реферальную информацию (по какой ссылке пришёл)
        if ref_info:
            print(f"  Пришёл по:   {ref_info['code']}")
            if ref_info['name']:
                print(f"  Название:    {ref_info['name']}")
            else:
                print(f"  Название:    без названия")
        else:
            print("  Пришёл по:   нет")

        # Показываем личный реф. код пользователя
        own_code = get_user_own_referral_code(user["user_id"])
        if own_code:
            print(f"  Личный код:  {own_code}")
        else:
            print("  Личный код:  не создан")

        print("=" * 50 + "\n")

        action = inquirer.select(  # type: ignore
            message="Действие:",
            choices=["Изменить план", "Добавить дни", "Отменить подписку", "< Назад"],
        ).execute()

        if action == "< Назад":
            return
        elif action == "Изменить план":
            change_plan(user["user_id"])
        elif action == "Добавить дни":
            add_days(user["user_id"])
        elif action == "Отменить подписку":
            cancel_subscription(user["user_id"])


def menu_users() -> None:
    clear()
    users = get_all_users()
    if not users:
        print("Пользователей пока нет.\n")
        inquirer.select(message="", choices=["< Назад"]).execute() # type: ignore
        return

    while True:
        clear()
        choices = [format_user_display(u) for u in users]
        choices.append("< Назад")

        selected = inquirer.select( # type: ignore
            message="Выберите пользователя:",
            choices=choices,
        ).execute()

        if selected == "< Назад":
            return

        # Извлекаем user_id из выбранной строки (первое число до " |")
        user_id_str = selected.split(" |")[0] if " |" in selected else selected
        user = next(u for u in users if str(u["user_id"]) == user_id_str)
        show_user_detail(user)


def menu_active_users() -> None:
    """Меню активных пользователей (только с подпиской)."""
    clear()
    users = get_active_users_list()
    if not users:
        print("Активных пользователей (с подпиской) пока нет.\n")
        inquirer.select(message="", choices=["< Назад"]).execute() # type: ignore
        return

    while True:
        clear()
        print("=" * 80)
        print("АКТИВНЫЕ ПОЛЬЗОВАТЕЛИ (С ПОДПИСКОЙ)")
        print("=" * 80)
        print(f"{'ID':<12} {'Username/Имя':<25} {'План':<15} {'Истекает':<25}")
        print("-" * 80)

        choices_map = {}
        for idx, u in enumerate(users, 1):
            user_id = u["user_id"]
            username = u.get("username")
            first_name = u.get("first_name")

            # Форматируем отображение пользователя
            if username:
                user_display = f"@{username}"
            elif first_name:
                user_display = first_name
            else:
                user_display = str(user_id)

            # Форматируем план
            plan = u.get("plan", "N/A")
            plan_label = PLAN_LABELS.get(plan, plan)

            # Форматируем дату истечения
            expires_at = u.get("expires_at")
            if expires_at:
                expires_str = format_expires(expires_at)
            else:
                expires_str = "Навсегда"

            print(f"{user_id:<12} {user_display:<25} {plan_label:<15} {expires_str:<25}")

            # Для выбора
            choice_text = f"{user_id} | {user_display}"
            choices_map[choice_text] = u

        print("=" * 80 + "\n")

        choices = list(choices_map.keys())
        choices.append("< Назад")

        selected = inquirer.select( # type: ignore
            message="Выберите пользователя для деталей:",
            choices=choices,
        ).execute()

        if selected == "< Назад":
            return

        user = choices_map[selected]
        show_user_detail(user)


def menu_view_master_wallets() -> None:
    """Просмотр мастер-кошельков без экспорта."""
    clear()

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT network, wallet_address FROM master_wallets ORDER BY network"
    )
    wallets = [dict(row) for row in cursor.fetchall()]
    conn.close()

    if not wallets:
        print("Мастер-кошельки не найдены.\n")
        inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
        return

    print("=" * 80)
    print("МАСТЕР-КОШЕЛЬКИ (адреса)")
    print("=" * 80)
    for w in wallets:
        print(f"{w['network']:12} | {w['wallet_address']}")
    print("=" * 80 + "\n")

    inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore


def _is_key_wiped(private_key: str) -> bool:
    """Проверяет, был ли приватный ключ уже затёрт (заменён на пустышку)."""
    return private_key.startswith("WIPED_")


def menu_export_wallets() -> None:
    """Экспортирует мастер-кошельки и затирает приватные ключи в БД."""
    clear()

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT network, wallet_address, private_key FROM master_wallets ORDER BY network"
    )
    wallets = [dict(row) for row in cursor.fetchall()]

    if not wallets:
        conn.close()
        print("Мастер-кошельки не найдены.\n")
        inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
        return

    # Проверяем, есть ли ещё настоящие ключи
    real_keys = [w for w in wallets if not _is_key_wiped(w["private_key"])]
    if not real_keys:
        conn.close()
        print("Приватные ключи уже были экспортированы и затёрты.\n")
        print("В базе данных хранятся только пустышки.\n")
        inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
        return

    # Предупреждение
    print("=" * 80)
    print("ЭКСПОРТ МАСТЕР-КОШЕЛЬКОВ")
    print("=" * 80)
    print()
    print("После экспорта приватные ключи в базе данных будут")
    print("БЕЗВОЗВРАТНО заменены на случайные пустышки.")
    print()
    print("Сохраните экспортированный файл в надёжное место!\n")

    confirm = inquirer.select(  # type: ignore
        message="Продолжить?",
        choices=["Да, экспортировать и затереть ключи", "< Отмена"],
    ).execute()

    if confirm == "< Отмена":
        conn.close()
        return

    # Экспорт в файл
    os.makedirs("data", exist_ok=True)
    filepath = "data/master_wallets_export.txt"

    with open(filepath, "w", encoding="utf-8") as f:
        f.write("=== MASTER WALLETS ===\n")
        f.write("ВНИМАНИЕ: Храните этот файл в безопасном месте!\n\n")
        for w in wallets:
            f.write(f"Сеть: {w['network']}\n")
            f.write(f"Адрес: {w['wallet_address']}\n")
            f.write(f"Приватный ключ: {w['private_key']}\n")
            f.write("-" * 80 + "\n")

    # Затираем ключи в БД
    for w in wallets:
        if not _is_key_wiped(w["private_key"]):
            dummy = "WIPED_" + secrets.token_hex(32)
            cursor.execute(
                "UPDATE master_wallets SET private_key = ? WHERE network = ?",
                (dummy, w["network"]),
            )
    conn.commit()
    conn.close()

    print(f"\nЭкспортировано {len(wallets)} мастер-кошельков в {filepath}")
    print("Приватные ключи в БД затёрты.\n")
    inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore


def menu_new_referral() -> None:
    """Создание новой реферальной ссылки."""
    import sys
    sys.path.insert(0, ".")
    from src.payments import create_referral_link

    clear()
    print("=" * 80)
    print("СОЗДАНИЕ РЕФЕРАЛЬНОЙ ССЫЛКИ")
    print("=" * 80 + "\n")

    # Выбор типа ссылки
    link_type = inquirer.select(  # type: ignore
        message="Тип ссылки:",
        choices=[
            "Для внутреннего использования",
            "Admins (присваивает статус Admin + демо-ссылка)",
            "< Отмена"
        ]
    ).execute()

    if link_type == "< Отмена":
        return

    is_admin_link = (link_type == "Admins (присваивает статус Admin + демо-ссылка)")

    if is_admin_link:
        # Для Admin-ссылки: название и лимит использований
        name = inquirer.text(  # type: ignore
            message="Название ссылки (для идентификации):",
            default=""
        ).execute()
        name = name.strip() if name.strip() else None

        max_uses_str = inquirer.text(  # type: ignore
            message="Лимит использований (пустое = безлимит):",
            default=""
        ).execute()
        max_uses = None
        if max_uses_str.strip():
            try:
                max_uses = int(max_uses_str)
            except ValueError:
                print("\n❌ Некорректное число. Отмена.\n")
                inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
                return

        commission_str = inquirer.text(  # type: ignore
            message="Комиссия администратора от покупок (% от суммы, например 20):",
            default="20"
        ).execute()
        try:
            commission_percent = int(commission_str.strip())
            if not (0 <= commission_percent <= 100):
                raise ValueError
        except ValueError:
            print("\n❌ Некорректный процент. Отмена.\n")
            inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
            return

        # Подтверждение
        clear()
        print("=" * 80)
        print("ПОДТВЕРЖДЕНИЕ")
        print("=" * 80)
        print(f"  Тип:                 Admins (присваивает статус Admin)")
        print(f"  Название:            {name if name else 'без названия'}")
        print(f"  Лимит использований: {max_uses if max_uses else 'безлимит'}")
        print(f"  Комиссия:            {commission_percent}%")
        print("=" * 80 + "\n")

        confirm = inquirer.select(  # type: ignore
            message="Создать ссылку?",
            choices=["Да", "Нет"]
        ).execute()

        if confirm != "Да":
            return

        code = create_referral_link(
            max_uses=max_uses,
            custom_prices=None,
            name=name,
            is_admin_link=True,
            admin_commission_percent=commission_percent,
        )

        bot_username = asyncio.run(get_bot_username())
        referral_url = f"https://t.me/{bot_username}?start={code}"

        os.makedirs("data", exist_ok=True)
        filepath = f"data/referral_admin_{code}.txt"
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("Admin реферальная ссылка\n")
            f.write("=" * 80 + "\n\n")
            if name:
                f.write(f"Название: {name}\n")
            f.write(f"Код: {code}\n")
            f.write(f"Ссылка: {referral_url}\n\n")
            f.write(f"Тип: Admin (присваивает статус Admin + персональная демо-ссылка)\n")
            f.write(f"Лимит использований: {max_uses if max_uses else 'безлимит'}\n")
            f.write(f"Комиссия: {commission_percent}%\n")

        clear()
        print("=" * 80)
        print("✅ ADMIN-ССЫЛКА СОЗДАНА")
        print("=" * 80)
        if name:
            print(f"\nНазвание: {name}")
        print(f"Код: {code}")
        print(f"Ссылка: {referral_url}")
        print(f"Комиссия: {commission_percent}%")
        print(f"\nПользователь, перешедший по этой ссылке, получит статус Admin")
        print(f"и персональную демо-ссылку для раздачи 1-дневного демо-доступа.")
        print(f"\nСохранено в: {filepath}\n")
        print("=" * 80 + "\n")

        inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
        return

    # Для обычной ссылки
    # 1. Лимит пользователей
    max_uses_str = inquirer.text(  # type: ignore
        message="Лимит использований (оставьте пустым для безлимита):",
        default=""
    ).execute()

    max_uses = None
    if max_uses_str.strip():
        try:
            max_uses = int(max_uses_str)
        except ValueError:
            print("\n❌ Некорректное число. Отмена.\n")
            inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
            return

    # 2. Кастомные цены
    custom_prices_str = inquirer.text(  # type: ignore
        message="Кастомные цены через запятую (например: 35.5,90,200.99) или пустое для дефолтных:",
        default=""
    ).execute()

    custom_prices = None
    if custom_prices_str.strip():
        try:
            # Проверяем формат (поддержка float)
            prices = [float(p.strip()) for p in custom_prices_str.split(",")]
            if len(prices) != 3:
                print("\n❌ Нужно указать ровно 3 цены (для 1нед, 1мес, 3мес). Отмена.\n")
                inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
                return
            custom_prices = custom_prices_str.strip()
        except ValueError:
            print("\n❌ Некорректный формат цен. Отмена.\n")
            inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
            return

    # 3. Название ссылки
    name = inquirer.text(  # type: ignore
        message="Название ссылки (для идентификации, например 'VK реклама'):",
        default=""
    ).execute()

    name = name.strip() if name.strip() else None

    # 4. Подтверждение
    clear()
    print("=" * 80)
    print("ПОДТВЕРЖДЕНИЕ")
    print("=" * 80)
    print(f"  Тип:                 Для внутреннего использования")
    print(f"  Название:            {name if name else 'без названия'}")
    print(f"  Лимит использований: {max_uses if max_uses else 'безлимит'}")
    print(f"  Кастомные цены:      {custom_prices if custom_prices else 'дефолтные'}")
    print("=" * 80 + "\n")

    confirm = inquirer.select(  # type: ignore
        message="Создать ссылку?",
        choices=["Да", "Нет"]
    ).execute()

    if confirm != "Да":
        return

    # 5. Создание и сохранение
    code = create_referral_link(max_uses, custom_prices, name)

    # Получаем username бота и формируем ссылку
    bot_username = asyncio.run(get_bot_username())
    referral_url = f"https://t.me/{bot_username}?start={code}"

    # Сохраняем в файл
    os.makedirs("data", exist_ok=True)
    filepath = f"data/referral_{code}.txt"
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"Реферальная ссылка\n")
        f.write("=" * 80 + "\n\n")
        if name:
            f.write(f"Название: {name}\n")
        f.write(f"Код: {code}\n")
        f.write(f"Ссылка: {referral_url}\n\n")
        f.write(f"Лимит использований: {max_uses if max_uses else 'безлимит'}\n")
        f.write(f"Кастомные цены: {custom_prices if custom_prices else 'дефолтные'}\n")

    # Показываем результат
    clear()
    print("=" * 80)
    print("✅ РЕФЕРАЛЬНАЯ ССЫЛКА СОЗДАНА")
    print("=" * 80)
    if name:
        print(f"\nНазвание: {name}")
    print(f"Код: {code}")
    print(f"Ссылка: {referral_url}\n")
    print(f"Сохранено в: {filepath}\n")
    print("=" * 80 + "\n")

    inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore


# ── Check Balance ──────────────────────────────────────────

# ERC-20 balanceOf(address) selector
_BALANCE_OF_SELECTOR = "0x70a08231"


async def _evm_token_balance(rpc_url: str, token_address: str, wallet: str) -> int:
    """Получает баланс ERC-20 токена через eth_call."""
    padded_wallet = "0x" + wallet[2:].lower().zfill(64)
    data = _BALANCE_OF_SELECTOR + padded_wallet[2:]
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_call",
        "params": [{"to": token_address, "data": data}, "latest"],
        "id": 1,
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(rpc_url, json=payload, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            result = await resp.json()
    raw = result.get("result", "0x0")
    return int(raw, 16)


async def _tron_token_balance(api_url: str, token_address: str, wallet: str) -> int:
    """Получает баланс TRC-20 токена через TronGrid API.
    Поддерживает неактивированные адреса через /tokens endpoint."""
    api_key = os.getenv("TRONGRID_API_KEY", "")
    headers = {}
    if api_key:
        headers["TRON-PRO-API-KEY"] = api_key

    async with aiohttp.ClientSession(headers=headers) as session:
        # Основной запрос — работает для активированных адресов
        async with session.get(
            f"{api_url}/v1/accounts/{wallet}",
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            data = await resp.json()

        accounts = data.get("data", [])
        if accounts:
            for token_entry in accounts[0].get("trc20", []):
                if isinstance(token_entry, dict):
                    balance = token_entry.get(token_address)
                    if balance is not None:
                        return int(balance)
            return 0

        # Резервный запрос для неактивированных адресов
        async with session.get(
            f"{api_url}/v1/accounts/{wallet}/tokens",
            params={"token_id": token_address, "limit": 20},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            data = await resp.json()

    for entry in data.get("data", []):
        if entry.get("tokenId") == token_address or entry.get("token_id") == token_address:
            return int(entry.get("balance", 0))
    return 0


async def _solana_token_balance(rpc_url: str, token_mint: str, wallet: str) -> int:
    """Получает баланс SPL-токена через Solana RPC."""
    from solders.pubkey import Pubkey

    _SOL_TOKEN_PROGRAM = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    _SOL_ATA_PROGRAM = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")

    wallet_pk = Pubkey.from_string(wallet)
    mint_pk = Pubkey.from_string(token_mint)
    ata, _ = Pubkey.find_program_address(
        [bytes(wallet_pk), bytes(_SOL_TOKEN_PROGRAM), bytes(mint_pk)],
        _SOL_ATA_PROGRAM,
    )

    payload = {
        "jsonrpc": "2.0",
        "method": "getTokenAccountBalance",
        "params": [str(ata), {"commitment": "confirmed"}],
        "id": 1,
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(rpc_url, json=payload, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            data = await resp.json()

    if "error" in data:
        return 0
    return int(data.get("result", {}).get("value", {}).get("amount", "0"))


async def _fetch_all_balances() -> list[dict]:
    """Собирает балансы всех токенов на всех мастер-кошельках."""
    import sys
    sys.path.insert(0, ".")
    from src.payments import SUPPORTED_NETWORKS, SUPPORTED_TOKENS, get_master_wallet_address

    results = []

    for net_id, net_info in SUPPORTED_NETWORKS.items():
        wallet = get_master_wallet_address(net_id)
        if not wallet:
            continue

        net_type = net_info.get("type")

        for tok_id, tok_info in SUPPORTED_TOKENS.items():
            # USDC не поддерживается в Tron
            if tok_id == "usdc" and net_id == "tron":
                continue

            token_address = tok_info["addresses"].get(net_id)
            if not token_address:
                continue

            decimals = tok_info["decimals"]

            try:
                if net_type == "evm":
                    rpc_url = os.getenv(net_info["rpc_url_env"], net_info["rpc_url_default"])
                    raw = await _evm_token_balance(rpc_url, token_address, wallet)
                elif net_type == "tron":
                    api_url = os.getenv(net_info.get("api_url_env", ""), net_info.get("api_url_default", ""))
                    raw = await _tron_token_balance(api_url, token_address, wallet)
                elif net_type == "solana":
                    rpc_url = os.getenv(net_info["rpc_url_env"], net_info["rpc_url_default"])
                    raw = await _solana_token_balance(rpc_url, token_address, wallet)
                else:
                    continue

                balance = raw / (10 ** decimals)
            except Exception as e:
                balance = None
                print(f"  [!] Ошибка при запросе {tok_info['name']} на {net_info['name']}: {e}")

            results.append({
                "network": net_info["name"],
                "token": tok_info["name"],
                "wallet": wallet,
                "balance": balance,
            })

    return results


def _get_withdrawal_wallet_address() -> str | None:
    """Возвращает EVM-адрес кошелька для вывода, деривированный из .env."""
    import sys
    sys.path.insert(0, ".")
    from src.payments import get_withdrawal_wallet
    wallet = get_withdrawal_wallet()
    return wallet["address"] if wallet else None


async def _fetch_withdrawal_wallet_balances() -> list[dict]:
    """Получает балансы USDC на Base и Arbitrum для кошелька вывода."""
    import sys
    sys.path.insert(0, ".")
    from src.evm_sender import USDC_ADDRESSES, USDC_DECIMALS
    from src.payments import SUPPORTED_NETWORKS

    address = _get_withdrawal_wallet_address()
    if not address:
        return []

    networks = {
        "base": "Base",
        "arbitrum": "Arbitrum One",
    }

    results = []
    for net_id, net_name in networks.items():
        usdc_contract = USDC_ADDRESSES.get(net_id)
        if not usdc_contract:
            continue

        net_info = SUPPORTED_NETWORKS.get(net_id, {})
        rpc_url = os.getenv(net_info.get("rpc_url_env", ""), net_info.get("rpc_url_default", ""))

        try:
            raw = await _evm_token_balance(rpc_url, usdc_contract, address)
            balance = raw / (10 ** USDC_DECIMALS)
        except Exception as e:
            print(f"  [!] Ошибка при запросе USDC на {net_name}: {e}")
            balance = None

        results.append({"network": net_name, "balance": balance})

    return results


def menu_check_balance() -> None:
    """Проверка балансов USDT/USDC на мастер-кошельках и кошельке для вывода."""
    clear()
    print("Загрузка балансов...\n")

    master_results = asyncio.run(_fetch_all_balances())
    withdrawal_address = _get_withdrawal_wallet_address()
    withdrawal_balances = asyncio.run(_fetch_withdrawal_wallet_balances()) if withdrawal_address else []

    clear()
    print("=" * 70)
    print("БАЛАНСЫ МАСТЕР-КОШЕЛЬКОВ")
    print("=" * 70)
    print(f"{'Сеть':<20} {'Токен':<8} {'Баланс':>15}")
    print("-" * 70)

    total = 0.0
    for r in master_results:
        if r["balance"] is not None:
            balance_str = f"{r['balance']:.2f}"
            total += r["balance"]
        else:
            balance_str = "ошибка"
        print(f"{r['network']:<20} {r['token']:<8} {balance_str:>15}")

    print("-" * 70)
    print(f"{'ИТОГО':<29} {'$' + f'{total:.2f}':>15}")
    print("=" * 70)

    print()
    print("=" * 70)
    print("КОШЕЛЁК ДЛЯ ВЫПЛАТ (EVM)")
    print("=" * 70)
    if withdrawal_address:
        print(f"Адрес: {withdrawal_address}")
        if withdrawal_balances:
            for wb in withdrawal_balances:
                bal_str = f"{wb['balance']:.2f}$" if wb["balance"] is not None else "ошибка"
                print(f"  {wb['network']:<20} USDC  {bal_str}")
        else:
            print("  Балансы недоступны")
    else:
        print("WITHDRAWAL_WALLET_KEY не задан в .env")
    print("=" * 70 + "\n")

    inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore


def menu_admin_stats() -> None:
    """Статистика по admin-ссылкам."""
    import sys
    sys.path.insert(0, ".")
    from src.payments import get_admin_links_stats

    clear()
    stats = get_admin_links_stats()

    print("=" * 80)
    print("СТАТИСТИКА ADMIN-ССЫЛОК")
    print("=" * 80)

    if not stats:
        print("\n  Admin-ссылок нет.\n")
    else:
        print(f"\n  {'Название':<28} {'Комис.':>7} {'Переходы':>10} {'Оплатили':>10}  {'Сумма / Доля':>22}  Актив.")
        print("  " + "-" * 88)
        for s in stats:
            name = s["name"][:27] if len(s["name"]) > 27 else s["name"]
            active = "✅" if s["is_active"] else "❌"
            user_label = "" if s["admin_user_id"] else "(не использована)"
            amount_str = f"${s['total_spent']:.2f} / ${s['admin_share']:.2f}"
            print(f"  {name:<28} {s['commission_percent']:>6}% {s['clicks']:>10} {s['paid_users']:>10}  {amount_str:>22}  {active}  {user_label}")
        print()
        total_clicks = sum(s["clicks"] for s in stats)
        total_paid = sum(s["paid_users"] for s in stats)
        total_spent = sum(s["total_spent"] for s in stats)
        total_share = sum(s["admin_share"] for s in stats)
        print(f"  {'ИТОГО':<28} {'':>7} {total_clicks:>10} {total_paid:>10}  {'$' + f'{total_spent:.2f}' + ' / $' + f'{total_share:.2f}':>22}")

    print("\n" + "=" * 80 + "\n")
    inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore


def menu_referral_stats() -> None:
    """Статистика реферальных ссылок."""
    import sys
    sys.path.insert(0, ".")
    from src.payments import get_all_referral_stats

    clear()
    stats = get_all_referral_stats()

    print("=" * 80)
    print("СТАТИСТИКА РЕФЕРАЛЬНЫХ ССЫЛОК")
    print("=" * 80)

    if not stats:
        print("\n  Реферальных ссылок нет.\n")
    else:
        print(f"\n  {'Название':<28} {'Тип':<18} {'Переходы':>9} {'Оплатили':>9} {'Сумма':>12} {'Лимит':>8}  Актив.")
        print("  " + "-" * 90)
        for s in stats:
            name = s["name"][:27] if len(s["name"]) > 27 else s["name"]
            link_type = s["link_type"][:17] if len(s["link_type"]) > 17 else s["link_type"]
            max_uses = str(s["max_uses"]) if s["max_uses"] else "∞"
            active = "✅" if s["is_active"] else "❌"
            amount_str = f"${s['total_spent']:.2f}"
            print(f"  {name:<28} {link_type:<18} {s['clicks']:>9} {s['paid_users']:>9} {amount_str:>12} {max_uses:>8}  {active}")
        print()
        total_clicks = sum(s["clicks"] for s in stats)
        total_paid = sum(s["paid_users"] for s in stats)
        total_spent = sum(s["total_spent"] for s in stats)
        print(f"  {'ИТОГО':<28} {'':<18} {total_clicks:>9} {total_paid:>9} {'$' + f'{total_spent:.2f}':>12}")

    print("\n" + "=" * 80 + "\n")
    inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore


async def _do_broadcast(
    user_ids: list[int],
    text: str,
    with_invite: bool,
) -> None:
    """Выполняет рассылку: для каждого пользователя отправляет сообщение,
    при необходимости генерируя уникальную одноразовую ссылку в группу."""
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    group_id = int(os.getenv("PRIVATE_GROUP_ID", "0"))

    if not token:
        print("\n❌ TELEGRAM_BOT_TOKEN не задан в .env\n")
        return

    if with_invite and not group_id:
        print("\n❌ PRIVATE_GROUP_ID не задан в .env\n")
        return

    bot = Bot(token=token)

    sent = 0
    failed = 0
    blocked = 0

    print()
    for i, user_id in enumerate(user_ids, 1):
        try:
            if with_invite:
                invite = await bot.create_chat_invite_link(
                    chat_id=group_id,
                    member_limit=1,
                )
                full_text = f"{text}\n\n{invite.invite_link}"
            else:
                full_text = text

            await bot.send_message(chat_id=user_id, text=full_text)
            sent += 1
            print(f"  [{i}/{len(user_ids)}] ✅ {user_id}")
        except Exception as e:
            err = str(e)
            if "bot was blocked by the user" in err or "user is deactivated" in err:
                blocked += 1
                print(f"  [{i}/{len(user_ids)}] ⛔ {user_id} (заблокировал бота)")
            else:
                failed += 1
                print(f"  [{i}/{len(user_ids)}] ❌ {user_id}: {err}")

        # Небольшая пауза, чтобы не попасть под flood control
        await asyncio.sleep(0.05)

    await bot.session.close()

    print()
    print("=" * 50)
    print(f"  Отправлено:  {sent}")
    print(f"  Заблокировал: {blocked}")
    print(f"  Ошибок:      {failed}")
    print("=" * 50)


def menu_broadcast() -> None:
    """Рассылка сообщений пользователям."""
    import sys
    sys.path.insert(0, ".")

    clear()
    print("=" * 60)
    print("РАССЫЛКА СООБЩЕНИЙ")
    print("=" * 60 + "\n")

    # 1. Кому рассылать
    audience = inquirer.select(  # type: ignore
        message="Кому отправить рассылку?",
        choices=[
            "Всем пользователям",
            "Только подписчикам (активная подписка)",
            "< Отмена",
        ],
    ).execute()

    if audience == "< Отмена":
        return

    if audience == "Всем пользователям":
        users = get_all_users()
    else:
        users = get_active_users_list()

    if not users:
        print("\nНет пользователей для рассылки.\n")
        inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
        return

    # 2. Прикрепить ссылку в группу?
    invite_choice = inquirer.select(  # type: ignore
        message="Добавить уникальную ссылку-приглашение в группу?",
        choices=["Да", "Нет", "< Отмена"],
    ).execute()

    if invite_choice == "< Отмена":
        return

    with_invite = (invite_choice == "Да")

    # 3. Текст рассылки
    text = inquirer.text(  # type: ignore
        message="Текст сообщения:",
    ).execute()

    if not text or not text.strip():
        print("\n❌ Текст не может быть пустым.\n")
        inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore
        return

    text = text.strip()

    # 4. Подтверждение
    clear()
    print("=" * 60)
    print("ПОДТВЕРЖДЕНИЕ РАССЫЛКИ")
    print("=" * 60)
    print(f"  Получатели:   {len(users)} чел. ({audience})")
    print(f"  Ссылка в группу: {'Да' if with_invite else 'Нет'}")
    print(f"\n  Текст:\n  {text}\n")
    print("=" * 60 + "\n")

    confirm = inquirer.select(  # type: ignore
        message="Начать рассылку?",
        choices=["Да, отправить", "< Отмена"],
    ).execute()

    if confirm == "< Отмена":
        return

    user_ids = [u["user_id"] for u in users]

    clear()
    print("=" * 60)
    print("РАССЫЛКА...")
    print("=" * 60)
    asyncio.run(_do_broadcast(user_ids, text, with_invite))
    print()

    inquirer.select(message="", choices=["< Назад"]).execute()  # type: ignore


def main() -> None:
    clear()
    while True:
        action = inquirer.select( # type: ignore
            message="Управление ботом:",
            choices=["Users", "Active Users", "Broadcast", "Check Balance", "View Master Wallets", "Export Master Wallets", "New Referral", "Referral Stats", "Admin Stats", "Exit"],
        ).execute()

        if action == "Users":
            menu_users()
        elif action == "Active Users":
            menu_active_users()
        elif action == "Broadcast":
            menu_broadcast()
        elif action == "Check Balance":
            menu_check_balance()
        elif action == "View Master Wallets":
            menu_view_master_wallets()
        elif action == "Export Master Wallets":
            menu_export_wallets()
        elif action == "New Referral":
            menu_new_referral()
        elif action == "Referral Stats":
            menu_referral_stats()
        elif action == "Admin Stats":
            menu_admin_stats()
        elif action == "Exit":
            break


if __name__ == "__main__":
    main()
