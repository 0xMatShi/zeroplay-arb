from aiogram import Bot, Router, F
from aiogram.types import (
    BotCommand,
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)
from aiogram.exceptions import TelegramForbiddenError
from datetime import datetime, timezone, timedelta
from aiogram.enums import ParseMode
import os
from aiogram.filters import CommandStart
from aiogram.fsm.context import FSMContext

from src.logger import logger
from src.blockchain import verify_transaction_by_hash
from src import backend_client
from src.states import PaymentStates, WithdrawalStates
from src.payments import (
    SUBSCRIPTION_PLANS,
    SUPPORTED_NETWORKS,
    SUPPORTED_TOKENS,
    cancel_user_payment_sessions,
    create_invite_links,
    create_payment_session,
    get_user_subscription,
    get_master_wallet_address,
    update_payment_session_tx_hash,
    complete_payment_session,
    record_payment,
    activate_subscription,
    activate_free_subscription,
    update_user_profile,
    get_user_profile,
    get_referral_link,
    use_referral_link,
    get_user_referral_code,
    get_user_referral_info,
    get_plan_price_for_user,
    get_user_own_referral_code,
    get_referral_balance,
    get_referral_paid_count,
    get_referral_percent,
    add_referral_balance,
    deduct_referral_balance,
    create_withdrawal_request,
    get_withdrawal_request,
    update_withdrawal_request,
    get_withdrawal_wallet,
    get_recently_expired_subscription,
    set_user_admin,
    is_user_admin,
    ensure_admin_demo_link,
    get_admin_referral_stats,
    get_user_language,
    set_user_language,
)

router = Router()

BOT_WEBSITE = os.getenv("BOT_WEBSITE_URL", "subline.space")
BOT_TELEGRAM = os.getenv("BOT_TELEGRAM_URL", "@Subline_arb")
BOT_TWITTER = os.getenv("BOT_TWITTER_URL", "")
NOTIFICATION_BOT_USERNAME = os.getenv("NOTIFICATION_BOT_USERNAME", "")

SUPPORT_USERNAME = "wrhundred"

# ─── Translations ──────────────────────────────────────────────────────────────

TEXTS: dict[str, dict[str, str]] = {
    "ru": {
        "choose_language": "Выберите язык / Choose language",
        "btn_ru": "🇷🇺 Русский",
        "btn_en": "🇬🇧 English",
        "btn_lang_toggle": "🌐 Язык: RU",
        "main_menu": (
            "Добро пожаловать в SUBLINE — сервис для арбитража между prediction markets "
            "и букмекерскими платформами.\n\n"
            "Мы создали терминал, который в реальном времени сканирует рынки, находит ценовые расхождения "
            "между площадками и показывает готовые возможности для входа. SUBLINE объединяет web2 и web3 "
            "инфраструктуру в одном интерфейсе, чтобы вы могли быстрее находить и реализовывать "
            "арбитражные сделки.\n\n"
            "Наш сайт — {website}\n"
            "Наш Telegram — {telegram}\n"
            "Наш X/Twitter — {twitter}"
        ),
        "btn_subscribe": "Оформить подписку",
        "btn_profile": "Личный кабинет",
        "btn_support": "Поддержка",
        "btn_faq": "FAQ",
        "btn_back": "< Назад",
        "btn_ask_question": "Задать вопрос",
        "subscribe_text": (
            "<b>Оформить подписку</b>\n\n"
            "SUBLINE — это профессиональный арбитражный терминал для работы с prediction markets "
            "и букмекерами.\n\n"
            "<b>С подпиской вы получаете:</b>\n\n"
            "— доступ к 4 букмекерам, 5 prediction markets и 10 видам спорта\n"
            "— калькуляторы входа, фильтры по ликвидности, профиту и ROI\n"
            "— алерты по новым возможностям как на сайте, так и в Telegram\n"
            "— инструменты для быстрого входа в сделку\n"
            "— real-time сканер спредов без задержки\n\n"
            "В тарифах PRO и MAX также входит доступ в приватную Telegram-группу с поддержкой, "
            "комьюнити, live-стримами и полезными материалами\n\n"
            "<b>Тарифы:</b>\n\n"
            "LITE — 35$ / 7 дней\n"
            "PRO — 149$ / 1 месяц + приватная группа\n"
            "MAX — 359$ / 3 месяца + приватная группа\n\n"
            "Выберите тариф для оплаты"
        ),
        "subscribe_active": (
            "📝 У вас активная подписка до {expires} (МСК)\n\n"
            "При оплате новой подписки дни будут добавлены к текущей!\n\n"
            "Выберите подписку для продления:{discount_note}"
        ),
        "subscribe_discount_note": "\n\nСкидка 20% действует, пока подписка активна.",
        "subscribe_expired_discount": (
            "Ваша подписка истекла, но скидка 20% на продление действует до {until} (МСК)!\n\n"
            "Выберите подписку для оформления:"
        ),
        "profile_title": "Личный кабинет",
        "profile_sub_none": "отсутствует",
        "profile_sub_active": "{plan} (активна до {expires} по МСК)",
        "profile_sub_label": "Ваша текущая подписка: {status}",
        "profile_ref_link": "Ваша реферальная ссылка:\n<code>{link}</code>",
        "profile_ref_balance": "Реферальный баланс: {balance}$",
        "profile_ref_count": "Приведено рефералов: {count}",
        "profile_ref_percent": "Ваш процент: 20%",
        "profile_ref_invite": "Приглашайте друзей и получайте 20% от суммы их оплаты ежемесячно!",
        "admin_status": "Статус: <b>Admin</b>",
        "admin_purchases": "Покупок: {buyers} | {share}$({pct}%)",
        "admin_demo_link": "Ваша демо-ссылка:",
        "btn_withdraw": "💸 Вывод",
        "support_text": (
            "<b>Поддержка</b>\n\n"
            "По любому вопросу касательно сервиса и не только вы можете обратиться к нам в любое время, "
            "работаем 24/7. Задать вопрос — @wrhundred\n\n"
            "<i>Если вопрос касается оплаты, пожалуйста, сразу присылайте скриншоты или ID транзакции "
            "для ускорения работы.</i>"
        ),
        "faq_text": (
            "<b>FAQ</b>\n\n"
            "<b>1. Что нужно, чтобы начать пользоваться сервисом?</b>\n\n"
            "Вам понадобится компьютер или ноутбук, подписка на сервис и аккаунты на поддерживаемых "
            "платформах: prediction markets и/или букмекерах с небольшим депозитом для работы. После этого "
            "вы сможете сразу начать отслеживать арбитражные возможности и заходить в первые сделки.\n\n"
            "<b>2. Нужен ли опыт в арбитраже?</b>\n\n"
            "Нет. Сервис сделан максимально простым и понятным для старта. Достаточно изучить обучающий "
            "гайд и немного потренироваться с небольшими суммами. Обычно пользователи осваиваются "
            "за несколько дней.\n\n"
            "<b>3. Сколько денег нужно для старта?</b>\n\n"
            "Большой депозит не требуется. Мы рекомендуем начинать с небольших сумм, чтобы спокойно "
            "привыкнуть к интерфейсу и механике работы сервиса. Начать можно даже с $10, но чтобы "
            "результат был ощутимым, комфортнее работать с депозитом от $150.\n\n"
            "<b>4. Насколько это безопасно?</b>\n\n"
            "Вы сами контролируете свои средства и работаете напрямую с платформами, а не делаете депозит "
            "на наш сервис. SubLine — это аналитический инструмент, который помогает находить арбитражные "
            "возможности и рассчитывать сделки, но все операции выполняются вами на ваших аккаунтах.\n\n"
            "<b>5. Есть ли ограничения по суммам?</b>\n\n"
            "Это зависит от конкретной платформы и ликвидности рынка. На prediction markets часто доступна "
            "хорошая ликвидность, но на отдельных событиях объём может быть ниже. Поэтому мы показываем "
            "ликвидность прямо в карточке возможности, чтобы вы сразу понимали, на какую сумму можно "
            "зайти без лишних рисков.\n\n"
            "<b>6. Есть ли сложности или нюансы в работе?</b>\n\n"
            "Да — важный момент здесь это скорость реакции. Арбитражные возможности появляются в реальном "
            "времени и могут исчезать довольно быстро. Иногда у вас есть около минуты, чтобы успеть "
            "открыть обе стороны сделки. Но это приходит с практикой: первые сделки могут занимать "
            "30–40 секунд, а со временем вы будете делать это за считанные секунды.\n\n"
            "<b>7. Сколько можно заработать?</b>\n\n"
            "Доход зависит от вашего депозита, скорости реакции, ликвидности и количества доступных "
            "возможностей в определённый день. Связки могут приносить до 40% ROI, а в течение дня сервис "
            "может находить десятки возможностей. При этом важно понимать, что результат всегда зависит "
            "от того, насколько быстро вы успеваете зайти в сделку и на какой объём входите.\n\n"
            "<b>8. Какую подписку лучше выбрать?</b>\n\n"
            "У нас есть несколько вариантов подписки. Недельная подписка подходит для того, чтобы "
            "протестировать сервис и понять, как он работает на практике. Месячная подписка — самый "
            "популярный вариант, потому что она даёт не только доступ к сервису, но и доступ к закрытому "
            "сообществу пользователей, где есть общение, обмен опытом, полезные материалы и поддержка."
        ),
        # Withdrawal
        "withdrawal_insufficient": "❌ Недостаточный баланс для вывода. Минимум: 10$",
        "withdrawal_title": "💸 Вывод средств",
        "withdrawal_balance": "Ваш баланс: {balance}$",
        "withdrawal_min": "Минимальная сумма вывода: 10$",
        "withdrawal_choose_network": "Выберите сеть для получения USDC:",
        "withdrawal_network_label": "Сеть: {network}",
        "withdrawal_enter_amount": "Введите сумму для вывода (от 10$ до {balance}$):",
        "withdrawal_enter_address": "Введите EVM-адрес кошелька (0x...) для получения USDC:",
        "withdrawal_invalid_amount": "Введите корректную сумму числом. Например: 30",
        "withdrawal_min_error": "Минимальная сумма вывода: 10$. Введите сумму ещё раз:",
        "withdrawal_insufficient_balance": "Недостаточно средств. Ваш баланс: {balance}$\nВведите сумму ещё раз:",
        "withdrawal_invalid_address": "Неверный EVM-адрес. Адрес должен начинаться с 0x и содержать 42 символа.\nПопробуйте ещё раз:",
        "withdrawal_success": (
            "✅ Запрос на вывод {amount}$ отправлен на подтверждение.\n\n"
            "Сеть: {network}\nАдрес: {address}\n\nОжидайте — средства будут переведены в течение 24 часов."
        ),
        "withdrawal_request_error": (
            "Ошибка при создании запроса. Возможно, недостаточно средств или уже есть активный запрос.\n"
            "Нажмите /start и попробуйте позже."
        ),
        # Payment
        "payment_enter_hash": (
            "Отправьте хэш транзакции для подтверждения оплаты.\n\n"
            "План: {plan}\nМонета: {token}\nСеть: {network}"
        ),
        "payment_error": "❌ Ошибка проверки транзакции:\n{error}\n\nПопробуйте ещё раз.",
        "payment_session_lost": "Ошибка: данные сессии потеряны. Начните заново.",
        "payment_success_new": (
            "✅ Оплата подтверждена!\n\nПодписка: {plan}\nСумма: {amount} {token}\nСеть: {network}\n"
            "Tx: <code>{tx}</code>"
        ),
        "payment_success_extended": (
            "✅ Оплата подтверждена!\n\nК вашей подписке добавлено {days} дней!\n\n"
            "Новая дата истечения: {expires} (МСК)\n\nСумма: {amount} {token}\nСеть: {network}\n"
            "Tx: <code>{tx}</code>"
        ),
        "payment_api_key": "\n\n🔑 Ваш ключ для входа на сайт:\n<code>{key}</code>\n\n⚠️ Сохраните ключ — он нужен для авторизации!",
        "payment_api_key_error": "\n\n⚠️ Не удалось получить ключ для входа. Обратитесь в поддержку.",
        "payment_confirm_btn": "Подтвердить оплату",
        "payment_select_sub": "Выберите одну из предложенных подписок:",
        "payment_select_token": "Оплата подписки: {plan} — {price}$\n\nВыберите монету для оплаты:",
        "payment_select_network": "Оплата подписки: {plan} — {price}$\nМонета: {token}\n\nВыберите сеть для перевода:",
        "payment_instructions": (
            "Оплата подписки: {plan}\n\nПереведите {price}$ {token} в сети {network} на адрес ниже:\n\n"
            "<code>{address}</code>\n\nПосле перевода нажмите «Подтвердить оплату» и отправьте хэш транзакции."
        ),
        # Plan button labels
        "plan_1week": "LITE — {price}$ / 7 дней",
        "plan_1month": "PRO — {price}$ / 1 месяц",
        "plan_3months": "MAX — {price}$ / 3 месяца",
        "plan_1week_discount": "LITE — {price}$ / 7 дней (было {orig}$, -20%)",
        "plan_1month_discount": "PRO — {price}$ / 1 месяц (было {orig}$, -20%)",
        "plan_3months_discount": "MAX — {price}$ / 3 месяца (было {orig}$, -20%)",
        # Referral / free subscription messages
        "admin_granted": (
            "🎉 Вам присвоен статус <b>Admin</b>!\n\nВаша персональная демо-ссылка:\n<code>{url}</code>\n\n"
            "Пользователи, которые перейдут по этой ссылке, сразу получат демо-доступ к сервису "
            "арбитража на 1 день с API-ключом."
        ),
        "ref_already_used": "❌ Эта ссылка уже была использована или недействительна.",
        "ref_already_active": (
            "❌ У вас уже есть активная подписка.\n\n"
            "Бесплатные дни предоставляются только при отсутствии действующей подписки."
        ),
        "demo_access_new": "🎉 Поздравляем!\n\nВам предоставлен демо-доступ к сервису арбитража на {days} день!",
        "demo_access_extended": "🎉 Отлично!\n\nК вашей подписке добавлено {days} дней!\n\nНовая дата истечения: {expires} (МСК)",
        "free_sub_new": "🎉 Поздравляем!\n\nВам активирована бесплатная подписка на {days} дней!",
        "free_sub_extended": "🎉 Отлично!\n\nК вашей подписке добавлено {days} дней!\n\nНовая дата истечения: {expires} (МСК)",
        "api_key_save": "\n\n🔑 Ваш API-ключ для входа на сайт:\n<code>{key}</code>\n\n⚠️ Сохраните ключ — он нужен для авторизации на сервисе!",
        "api_key_error": "\n\n⚠️ Не удалось получить API-ключ. Обратитесь в поддержку.",
        "invite_links_header": "\n\n📱 Ваши одноразовые ссылки для вступления:",
        "invite_chat": "\n\n🔹 Чат:\n{link}",
        "invite_group": "\n\n🔹 Группа:\n{link}",
        "invite_chat_error": "\n\n🔹 Чат:\n⚠️ Не удалось создать ссылку",
        "invite_group_error": "\n\n🔹 Группа:\n⚠️ Не удалось создать ссылку",
        "invite_one_use": "\n\n⚠️ Каждая ссылка станет недействительной после присоединения одного человека!",
        "invite_error": "\n\n⚠️ Не удалось создать пригласительные ссылки. Обратитесь в поддержку.",
        "notification_bot": "\n\n🤖 Бот уведомлений об арбитраже: {username}",
    },
    "en": {
        "choose_language": "Выберите язык / Choose language",
        "btn_ru": "🇷🇺 Русский",
        "btn_en": "🇬🇧 English",
        "btn_lang_toggle": "🌐 Lang: EN",
        "main_menu": (
            "Welcome to SUBLINE — an arbitrage service between prediction markets "
            "and bookmaking platforms.\n\n"
            "We built a terminal that scans markets in real time, finds price discrepancies between "
            "platforms and shows ready-to-use entry opportunities. SUBLINE combines web2 and web3 "
            "infrastructure in one interface so you can find and execute arbitrage trades faster.\n\n"
            "Our website — {website}\n"
            "Our Telegram — {telegram}\n"
            "Our X/Twitter — {twitter}"
        ),
        "btn_subscribe": "Subscribe",
        "btn_profile": "My Account",
        "btn_support": "Support",
        "btn_faq": "FAQ",
        "btn_back": "< Back",
        "btn_ask_question": "Ask a question",
        "subscribe_text": (
            "<b>Subscribe</b>\n\n"
            "SUBLINE is a professional arbitrage terminal for working with prediction markets "
            "and bookmakers.\n\n"
            "<b>With a subscription you get:</b>\n\n"
            "— access to 4 bookmakers, 5 prediction markets and 10 sports\n"
            "— entry calculators, filters by liquidity, profit and ROI\n"
            "— alerts for new opportunities both on the website and in Telegram\n"
            "— tools for quick trade entry\n"
            "— real-time spread scanner with no delay\n\n"
            "PRO and MAX plans also include access to a private Telegram group with support, "
            "community, live streams and useful materials\n\n"
            "<b>Plans:</b>\n\n"
            "LITE — $35 / 7 days\n"
            "PRO — $149 / 1 month + private group\n"
            "MAX — $359 / 3 months + private group\n\n"
            "Choose a plan to pay"
        ),
        "subscribe_active": (
            "📝 Your subscription is active until {expires} (MSK)\n\n"
            "When you pay for a new subscription, days will be added to the current one!\n\n"
            "Choose a subscription to renew:{discount_note}"
        ),
        "subscribe_discount_note": "\n\nThe 20% discount is valid while the subscription is active.",
        "subscribe_expired_discount": (
            "Your subscription has expired, but the 20% renewal discount is active until {until} (MSK)!\n\n"
            "Choose a subscription:"
        ),
        "profile_title": "My Account",
        "profile_sub_none": "none",
        "profile_sub_active": "{plan} (active until {expires} MSK)",
        "profile_sub_label": "Current subscription: {status}",
        "profile_ref_link": "Your referral link:\n<code>{link}</code>",
        "profile_ref_balance": "Referral balance: {balance}$",
        "profile_ref_count": "Referrals brought: {count}",
        "profile_ref_percent": "Your percentage: 20%",
        "profile_ref_invite": "Invite friends and earn 20% of their payment amount monthly!",
        "admin_status": "Status: <b>Admin</b>",
        "admin_purchases": "Purchases: {buyers} | {share}$({pct}%)",
        "admin_demo_link": "Your demo link:",
        "btn_withdraw": "💸 Withdraw",
        "support_text": (
            "<b>Support</b>\n\n"
            "For any questions about the service and beyond, you can reach us at any time — we work 24/7. "
            "Ask a question — @wrhundred\n\n"
            "<i>If your question concerns payment, please send screenshots or transaction ID right away "
            "to speed things up.</i>"
        ),
        "faq_text": (
            "<b>FAQ</b>\n\n"
            "<b>1. What do I need to start using the service?</b>\n\n"
            "You'll need a computer or laptop, a service subscription, and accounts on supported "
            "platforms: prediction markets and/or bookmakers with a small deposit. After that, you can "
            "immediately start tracking arbitrage opportunities and entering your first trades.\n\n"
            "<b>2. Do I need experience in arbitrage?</b>\n\n"
            "No. The service is designed to be as simple and intuitive as possible. Just study the "
            "tutorial guide and practice with small amounts. Most users get the hang of it within "
            "a few days.\n\n"
            "<b>3. How much money do I need to start?</b>\n\n"
            "You don't need a large deposit. We recommend starting with small amounts to get comfortable "
            "with the interface and mechanics. You can start with as little as $10, but for a more "
            "noticeable result, it's more comfortable to work with a deposit of $150 or more.\n\n"
            "<b>4. How safe is it?</b>\n\n"
            "You control your own funds and work directly with platforms — you don't make a deposit to "
            "our service. SubLine is an analytical tool that helps find arbitrage opportunities and "
            "calculate trades, but all operations are performed by you on your own accounts.\n\n"
            "<b>5. Are there limits on amounts?</b>\n\n"
            "It depends on the specific platform and market liquidity. Prediction markets often have good "
            "liquidity, but volume on individual events may be lower. That's why we show liquidity "
            "directly in the opportunity card, so you immediately understand how much you can enter "
            "without undue risk.\n\n"
            "<b>6. Are there any difficulties or nuances?</b>\n\n"
            "Yes — the key point here is speed of reaction. Arbitrage opportunities appear in real time "
            "and can disappear quite quickly. Sometimes you have about a minute to open both sides of "
            "a trade. But this comes with practice: first trades may take 30–40 seconds, and over time "
            "you'll do it in a matter of seconds.\n\n"
            "<b>7. How much can I earn?</b>\n\n"
            "Income depends on your deposit, reaction speed, liquidity and the number of available "
            "opportunities on a given day. Combinations can bring up to 40% ROI, and throughout the day "
            "the service can find dozens of opportunities. It's important to understand that the result "
            "always depends on how quickly you enter the trade and what volume you put in.\n\n"
            "<b>8. Which subscription is best?</b>\n\n"
            "We have several subscription options. The weekly subscription is good for testing the "
            "service and understanding how it works in practice. The monthly subscription is the most "
            "popular option, as it provides not only access to the service but also access to a closed "
            "user community with communication, experience sharing, useful materials and support."
        ),
        # Withdrawal
        "withdrawal_insufficient": "❌ Insufficient balance for withdrawal. Minimum: $10",
        "withdrawal_title": "💸 Withdrawal",
        "withdrawal_balance": "Your balance: {balance}$",
        "withdrawal_min": "Minimum withdrawal amount: $10",
        "withdrawal_choose_network": "Choose a network to receive USDC:",
        "withdrawal_network_label": "Network: {network}",
        "withdrawal_enter_amount": "Enter withdrawal amount (from $10 to {balance}$):",
        "withdrawal_enter_address": "Enter EVM wallet address (0x...) to receive USDC:",
        "withdrawal_invalid_amount": "Enter a valid amount as a number. Example: 30",
        "withdrawal_min_error": "Minimum withdrawal amount: $10. Please enter the amount again:",
        "withdrawal_insufficient_balance": "Insufficient funds. Your balance: {balance}$\nPlease enter the amount again:",
        "withdrawal_invalid_address": "Invalid EVM address. Address must start with 0x and contain 42 characters.\nPlease try again:",
        "withdrawal_success": (
            "✅ Withdrawal request for {amount}$ sent for confirmation.\n\n"
            "Network: {network}\nAddress: {address}\n\nPlease wait — funds will be transferred within 24 hours."
        ),
        "withdrawal_request_error": (
            "Error creating request. Possibly insufficient funds or an active request already exists.\n"
            "Press /start and try again later."
        ),
        # Payment
        "payment_enter_hash": (
            "Send the transaction hash to confirm payment.\n\n"
            "Plan: {plan}\nCoin: {token}\nNetwork: {network}"
        ),
        "payment_error": "❌ Transaction verification error:\n{error}\n\nPlease try again.",
        "payment_session_lost": "Error: session data lost. Please start again.",
        "payment_success_new": (
            "✅ Payment confirmed!\n\nSubscription: {plan}\nAmount: {amount} {token}\nNetwork: {network}\n"
            "Tx: <code>{tx}</code>"
        ),
        "payment_success_extended": (
            "✅ Payment confirmed!\n\n{days} days added to your subscription!\n\n"
            "New expiry date: {expires} (MSK)\n\nAmount: {amount} {token}\nNetwork: {network}\n"
            "Tx: <code>{tx}</code>"
        ),
        "payment_api_key": "\n\n🔑 Your login key for the website:\n<code>{key}</code>\n\n⚠️ Save the key — it is needed to log in to the service!",
        "payment_api_key_error": "\n\n⚠️ Failed to get login key. Please contact support.",
        "payment_confirm_btn": "Confirm payment",
        "payment_select_sub": "Choose one of the available subscriptions:",
        "payment_select_token": "Payment: {plan} — {price}$\n\nChoose a coin to pay with:",
        "payment_select_network": "Payment: {plan} — {price}$\nCoin: {token}\n\nChoose a network for transfer:",
        "payment_instructions": (
            "Payment: {plan}\n\nSend {price}$ {token} on the {network} network to the address below:\n\n"
            "<code>{address}</code>\n\nAfter sending, click «Confirm payment» and send the transaction hash."
        ),
        # Plan button labels
        "plan_1week": "LITE — {price}$ / 7 days",
        "plan_1month": "PRO — {price}$ / 1 month",
        "plan_3months": "MAX — {price}$ / 3 months",
        "plan_1week_discount": "LITE — {price}$ / 7 days (was {orig}$, -20%)",
        "plan_1month_discount": "PRO — {price}$ / 1 month (was {orig}$, -20%)",
        "plan_3months_discount": "MAX — {price}$ / 3 months (was {orig}$, -20%)",
        # Referral / free subscription messages
        "admin_granted": (
            "🎉 You have been granted <b>Admin</b> status!\n\nYour personal demo link:\n<code>{url}</code>\n\n"
            "Users who follow this link will immediately get demo access to the arbitrage service for 1 day "
            "with an API key."
        ),
        "ref_already_used": "❌ This link has already been used or is no longer valid.",
        "ref_already_active": (
            "❌ You already have an active subscription.\n\n"
            "Free days are only provided when there is no active subscription."
        ),
        "demo_access_new": "🎉 Congratulations!\n\nYou have been granted demo access to the arbitrage service for {days} day!",
        "demo_access_extended": "🎉 Great!\n\n{days} days added to your subscription!\n\nNew expiry date: {expires} (MSK)",
        "free_sub_new": "🎉 Congratulations!\n\nYour free subscription for {days} days has been activated!",
        "free_sub_extended": "🎉 Great!\n\n{days} days added to your subscription!\n\nNew expiry date: {expires} (MSK)",
        "api_key_save": "\n\n🔑 Your API key for the website:\n<code>{key}</code>\n\n⚠️ Save the key — it is needed to log in to the service!",
        "api_key_error": "\n\n⚠️ Failed to get API key. Please contact support.",
        "invite_links_header": "\n\n📱 Your one-time join links:",
        "invite_chat": "\n\n🔹 Chat:\n{link}",
        "invite_group": "\n\n🔹 Group:\n{link}",
        "invite_chat_error": "\n\n🔹 Chat:\n⚠️ Failed to create link",
        "invite_group_error": "\n\n🔹 Group:\n⚠️ Failed to create link",
        "invite_one_use": "\n\n⚠️ Each link becomes invalid after one person joins!",
        "invite_error": "\n\n⚠️ Failed to create invite links. Please contact support.",
        "notification_bot": "\n\n🤖 Arbitrage notification bot: {username}",
    },
}


# ─── Helper functions ──────────────────────────────────────────────────────────


def get_lang(user_id: int) -> str:
    """Возвращает язык пользователя, по умолчанию 'ru'."""
    return get_user_language(user_id) or "ru"


def tx(lang: str, key: str, **kwargs: object) -> str:
    """Возвращает переведённую строку для указанного языка."""
    text = TEXTS.get(lang, TEXTS["ru"]).get(key, TEXTS["ru"].get(key, key))
    if kwargs:
        return text.format(**kwargs)  # type: ignore[return-value]
    return text  # type: ignore[return-value]


def fmt_price(price: float) -> str:
    return f"{price:.2f}".rstrip("0").rstrip(".") if isinstance(price, float) else str(price)


async def safe_send_message(message: Message, text: str, **kwargs) -> Message | None:
    """Безопасная отправка сообщения с обработкой блокировки бота."""
    try:
        return await message.answer(text, **kwargs)
    except TelegramForbiddenError:
        user = message.from_user
        if user:
            logger.warning(f"User {user.id} has blocked the bot")
        return None


async def safe_edit_message(callback: CallbackQuery, text: str, **kwargs) -> None:
    """Безопасное редактирование сообщения с обработкой блокировки бота."""
    try:
        if callback.message and hasattr(callback.message, "edit_text"):
            await callback.message.edit_text(text, **kwargs)  # type: ignore
    except TelegramForbiddenError:
        user = callback.from_user
        if user:
            logger.warning(f"User {user.id} has blocked the bot")


# ─── Keyboards ─────────────────────────────────────────────────────────────────


def language_select_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🇷🇺 Русский", callback_data="set_lang:ru")],
        [InlineKeyboardButton(text="🇬🇧 English", callback_data="set_lang:en")],
    ])


def main_menu_kb(lang: str) -> InlineKeyboardMarkup:
    other_lang = "en" if lang == "ru" else "ru"
    toggle_text = tx(lang, "btn_lang_toggle")
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=tx(lang, "btn_subscribe"), callback_data="subscribe")],
        [InlineKeyboardButton(text=tx(lang, "btn_profile"), callback_data="profile")],
        [InlineKeyboardButton(text=tx(lang, "btn_support"), callback_data="support")],
        [InlineKeyboardButton(text=tx(lang, "btn_faq"), callback_data="faq")],
        [InlineKeyboardButton(text=toggle_text, callback_data=f"toggle_lang:{other_lang}")],
    ])


def plans_kb(
    lang: str,
    custom_prices: list[float] | None = None,
    show_discount: bool = False,
) -> InlineKeyboardMarkup:
    buttons = []
    plan_keys = list(SUBSCRIPTION_PLANS.keys())

    for idx, plan_id in enumerate(plan_keys):
        plan = SUBSCRIPTION_PLANS[plan_id]
        if custom_prices and idx < len(custom_prices):
            price = custom_prices[idx]
        else:
            price = plan["price"]

        price_str = fmt_price(price)

        if show_discount:
            orig_str = fmt_price(float(plan["price"]))
            key = f"plan_{plan_id}_discount"
            label = tx(lang, key, price=price_str, orig=orig_str)
        else:
            key = f"plan_{plan_id}"
            label = tx(lang, key, price=price_str)

        buttons.append([InlineKeyboardButton(text=label, callback_data=f"plan:{plan_id}")])

    buttons.append([InlineKeyboardButton(text=tx(lang, "btn_ask_question"), url=f"https://t.me/{SUPPORT_USERNAME}")])
    buttons.append([InlineKeyboardButton(text=tx(lang, "btn_back"), callback_data="back_to_main")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)


def token_kb(lang: str, plan_id: str) -> InlineKeyboardMarkup:
    buttons = []
    for token_id, token in SUPPORTED_TOKENS.items():
        buttons.append([InlineKeyboardButton(
            text=token["name"],
            callback_data=f"token:{plan_id}:{token_id}",
        )])
    buttons.append([InlineKeyboardButton(text=tx(lang, "btn_back"), callback_data="subscribe")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)


def network_kb(lang: str, plan_id: str, token: str) -> InlineKeyboardMarkup:
    buttons = []
    token_info = SUPPORTED_TOKENS.get(token)
    if token_info:
        for net_id, net in SUPPORTED_NETWORKS.items():
            if net_id in token_info["addresses"]:
                buttons.append([InlineKeyboardButton(
                    text=net["name"],
                    callback_data=f"net:{plan_id}:{token}:{net_id}",
                )])
    buttons.append([InlineKeyboardButton(text=tx(lang, "btn_back"), callback_data=f"plan:{plan_id}")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)


def payment_kb(lang: str, plan_id: str, token: str, network: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=tx(lang, "payment_confirm_btn"), callback_data=f"confirm:{plan_id}:{token}:{network}")],
        [InlineKeyboardButton(text=tx(lang, "btn_back"), callback_data=f"token:{plan_id}:{token}")],
    ])


def back_kb(lang: str, callback_data: str = "back_to_main") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=tx(lang, "btn_back"), callback_data=callback_data)],
    ])


def profile_kb(lang: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=tx(lang, "btn_withdraw"), callback_data="withdrawal_start")],
        [InlineKeyboardButton(text=tx(lang, "btn_back"), callback_data="back_to_main")],
    ])


def support_kb(lang: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=tx(lang, "btn_back"), callback_data="back_to_main")],
    ])


def faq_kb(lang: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=tx(lang, "btn_back"), callback_data="back_to_main")],
    ])


# ─── Helpers ───────────────────────────────────────────────────────────────────


def _main_menu_text(lang: str) -> str:
    return tx(lang, "main_menu", website=BOT_WEBSITE, telegram=BOT_TELEGRAM, twitter=BOT_TWITTER)


def _build_invite_links_text(lang: str, invite_links: dict) -> str:
    text = tx(lang, "invite_links_header")
    if invite_links.get("group"):
        text += tx(lang, "invite_group", link=invite_links["group"])
    else:
        text += tx(lang, "invite_group_error")
    text += tx(lang, "invite_one_use")
    return text


async def _process_instant_referral(
    send_fn,
    bot: Bot,
    user_id: int,
    ref_link: dict,
    referral_code: str,
    lang: str,
    state: FSMContext,
) -> bool:
    """Обрабатывает мгновенную (бесплатную) реферальную ссылку. Возвращает True если обработана."""
    free_days = ref_link.get("free_days")
    success = use_referral_link(user_id, referral_code)

    if not success:
        await send_fn(tx(lang, "ref_already_used"))
        await state.clear()
        cancel_user_payment_sessions(user_id)
        return True

    result = activate_free_subscription(user_id, free_days)
    action = result.get("action")

    if action == "skipped":
        await send_fn(tx(lang, "ref_already_active"))
        await state.clear()
        cancel_user_payment_sessions(user_id)
        return True

    expires_at = result.get("expires_at")
    owner_user_id = ref_link.get("owner_user_id")

    def _expires_str(exp_at):
        if exp_at:
            dt = datetime.fromisoformat(exp_at).astimezone(timezone(timedelta(hours=3)))
            return dt.strftime("%d.%m.%Y %H:%M")
        return "не определена" if lang == "ru" else "unknown"

    if owner_user_id:
        # Демо-ссылка от администратора: только API-ключ
        api_key = await backend_client.activate_subscription(user_id, "demo", expires_at)
        if api_key:
            api_key_text = tx(lang, "api_key_save", key=api_key)
        else:
            api_key_text = tx(lang, "api_key_error")
            logger.error(f"Failed to get API key from backend for demo user {user_id}")

        if action == "extended":
            text = tx(lang, "demo_access_extended", days=free_days, expires=_expires_str(expires_at))
        else:
            text = tx(lang, "demo_access_new", days=free_days)

        await send_fn(text + api_key_text, parse_mode=ParseMode.HTML)
    else:
        # Обычная бесплатная ссылка: ссылки для вступления
        try:
            invite_links = await create_invite_links(bot, user_id, f"Free {free_days}d")
            link_text = _build_invite_links_text(lang, invite_links)
        except Exception as e:
            logger.error(f"Failed to create invite links for user {user_id}: {e}")
            link_text = tx(lang, "invite_error")

        if action == "extended":
            text = tx(lang, "free_sub_extended", days=free_days, expires=_expires_str(expires_at))
        else:
            text = tx(lang, "free_sub_new", days=free_days)

        await send_fn(text + link_text)

    await state.clear()
    cancel_user_payment_sessions(user_id)
    return True


# ─── Handlers ──────────────────────────────────────────────────────────────────


@router.callback_query(F.data.startswith("set_lang:"))
async def handle_set_language(callback: CallbackQuery, state: FSMContext) -> None:
    """Пользователь выбрал язык на экране выбора языка."""
    lang = callback.data.split(":")[1]  # type: ignore
    if lang not in TEXTS:
        lang = "ru"

    user_id = callback.from_user.id
    set_user_language(user_id, lang)

    # Проверяем есть ли отложенный реферальный код
    fsm_data = await state.get_data()
    pending_referral = fsm_data.get("pending_referral")
    await state.clear()

    if pending_referral:
        ref_link = get_referral_link(pending_referral)

        if ref_link and ref_link["is_active"]:
            is_admin_link = ref_link.get("is_admin_link", 0) == 1

            if is_admin_link:
                success = use_referral_link(user_id, pending_referral)
                if success:
                    set_user_admin(user_id)
                    commission = ref_link.get("admin_commission_percent") or 0
                    demo_code = ensure_admin_demo_link(user_id, commission)
                    bot_info = await callback.bot.get_me()  # type: ignore
                    bot_username = bot_info.username or "bot"
                    demo_url = f"https://t.me/{bot_username}?start={demo_code}"
                    await callback.message.answer(  # type: ignore
                        tx(lang, "admin_granted", url=demo_url),
                        parse_mode=ParseMode.HTML,
                    )
                else:
                    await callback.message.answer(tx(lang, "ref_already_used"))  # type: ignore
                cancel_user_payment_sessions(user_id)
                await callback.answer()
                return

            is_instant = ref_link.get("is_instant", 0) == 1
            free_days = ref_link.get("free_days")

            if is_instant and free_days:
                send_fn = lambda t, **kw: callback.message.answer(t, **kw)  # type: ignore
                await _process_instant_referral(
                    send_fn, callback.bot, user_id, ref_link, pending_referral, lang, state  # type: ignore
                )
                await callback.answer()
                return
            else:
                use_referral_link(user_id, pending_referral)

    # Показываем главное меню
    cancel_user_payment_sessions(user_id)
    await safe_edit_message(callback, _main_menu_text(lang), reply_markup=main_menu_kb(lang), disable_web_page_preview=True)
    await callback.answer()


@router.callback_query(F.data.startswith("toggle_lang:"))
async def handle_toggle_language(callback: CallbackQuery) -> None:
    """Переключает язык из главного меню."""
    lang = callback.data.split(":")[1]  # type: ignore
    if lang not in TEXTS:
        lang = "ru"
    set_user_language(callback.from_user.id, lang)
    await safe_edit_message(callback, _main_menu_text(lang), reply_markup=main_menu_kb(lang), disable_web_page_preview=True)
    await callback.answer()


@router.message(CommandStart(deep_link=True))
async def cmd_start_with_referral(message: Message, state: FSMContext) -> None:
    """Обработка старта с реферальным кодом."""
    user = message.from_user  # type: ignore
    bot = message.bot  # type: ignore
    args = message.text.split(maxsplit=1)  # type: ignore
    referral_code = args[1] if len(args) > 1 else None

    logger.info(f"User {user.id} started the bot with referral code: {referral_code}")
    is_new_user = get_user_profile(user.id) is None  # type: ignore
    update_user_profile(user.id, user.username, user.first_name, user.last_name)  # type: ignore

    # Новый пользователь — сначала выбор языка
    if is_new_user:
        await state.clear()
        await state.update_data(pending_referral=referral_code)
        await safe_send_message(message, TEXTS["ru"]["choose_language"], reply_markup=language_select_kb())
        return

    lang = get_lang(user.id)  # type: ignore

    # Язык уже задан — обрабатываем реферал сразу
    if referral_code:
        ref_link = get_referral_link(referral_code)
        logger.info(f"Referral link lookup: {ref_link}")

        if ref_link and ref_link["is_active"]:
            is_admin_link = ref_link.get("is_admin_link", 0) == 1

            if is_admin_link:
                success = use_referral_link(user.id, referral_code)  # type: ignore
                if success:
                    set_user_admin(user.id)  # type: ignore
                    commission = ref_link.get("admin_commission_percent") or 0
                    demo_code = ensure_admin_demo_link(user.id, commission)  # type: ignore
                    bot_info = await bot.get_me()
                    bot_username = bot_info.username or "bot"
                    demo_url = f"https://t.me/{bot_username}?start={demo_code}"
                    await safe_send_message(
                        message,
                        tx(lang, "admin_granted", url=demo_url),
                        parse_mode=ParseMode.HTML,
                    )
                else:
                    await safe_send_message(message, tx(lang, "ref_already_used"))
                await state.clear()
                cancel_user_payment_sessions(user.id)  # type: ignore
                return

            is_instant = ref_link.get("is_instant", 0) == 1
            free_days = ref_link.get("free_days")

            if is_instant and free_days:
                send_fn = lambda t, **kw: safe_send_message(message, t, **kw)
                handled = await _process_instant_referral(
                    send_fn, bot, user.id, ref_link, referral_code, lang, state  # type: ignore
                )
                if handled:
                    return
            else:
                success = use_referral_link(user.id, referral_code)  # type: ignore
                if success:
                    logger.info(f"User {user.id} used referral code {referral_code}")
                else:
                    logger.warning(f"User {user.id} failed to use referral code {referral_code}")
        else:
            logger.warning(f"Referral link {referral_code} not found or inactive")

    await state.clear()
    cancel_user_payment_sessions(user.id)  # type: ignore
    await safe_send_message(message, _main_menu_text(lang), reply_markup=main_menu_kb(lang), disable_web_page_preview=True)


@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext) -> None:
    """Обработка обычного старта без параметров."""
    user = message.from_user  # type: ignore
    logger.info(f"User {user.id} started the bot")
    is_new_user = get_user_profile(user.id) is None  # type: ignore
    update_user_profile(user.id, user.username, user.first_name, user.last_name)  # type: ignore

    if is_new_user:
        await state.clear()
        await state.update_data(pending_referral=None)
        await safe_send_message(message, TEXTS["ru"]["choose_language"], reply_markup=language_select_kb())
        return

    await state.clear()
    cancel_user_payment_sessions(user.id)  # type: ignore
    lang = get_lang(user.id)  # type: ignore
    await safe_send_message(message, _main_menu_text(lang), reply_markup=main_menu_kb(lang), disable_web_page_preview=True)


@router.callback_query(F.data == "back_to_main")
async def back_to_main(callback: CallbackQuery) -> None:
    user = callback.from_user
    update_user_profile(user.id, user.username, user.first_name, user.last_name)
    cancel_user_payment_sessions(user.id)
    lang = get_lang(user.id)
    await safe_edit_message(callback, _main_menu_text(lang), reply_markup=main_menu_kb(lang), disable_web_page_preview=True)
    await callback.answer()


@router.callback_query(F.data == "support")
async def show_support(callback: CallbackQuery) -> None:
    lang = get_lang(callback.from_user.id)
    await safe_edit_message(
        callback,
        tx(lang, "support_text"),
        reply_markup=support_kb(lang),
        parse_mode=ParseMode.HTML,
    )
    await callback.answer()


@router.callback_query(F.data == "faq")
async def show_faq(callback: CallbackQuery) -> None:
    lang = get_lang(callback.from_user.id)
    await safe_edit_message(
        callback,
        tx(lang, "faq_text"),
        reply_markup=faq_kb(lang),
        parse_mode=ParseMode.HTML,
    )
    await callback.answer()


@router.callback_query(F.data == "subscribe")
async def show_plans(callback: CallbackQuery) -> None:
    user = callback.from_user
    update_user_profile(user.id, user.username, user.first_name, user.last_name)
    lang = get_lang(user.id)
    logger.info(f"User {user.id} opened subscription plans")

    subscription = get_user_subscription(user.id)
    custom_prices = None

    referral_code = get_user_referral_code(user.id)
    if referral_code:
        ref_link = get_referral_link(referral_code)
        if ref_link and ref_link["custom_prices"]:
            try:
                custom_prices = [float(p.strip()) for p in ref_link["custom_prices"].split(",")]
            except ValueError:
                logger.warning(f"Failed to parse custom prices: {ref_link['custom_prices']}")

    if subscription and subscription["expires_at"]:
        expires_dt = datetime.fromisoformat(subscription["expires_at"])
        expires_msk = expires_dt.astimezone(timezone(timedelta(hours=3)))
        message_text = tx(
            lang, "subscribe_active",
            expires=expires_msk.strftime("%d.%m.%Y %H:%M"),
            discount_note="",
        )
    else:
        message_text = tx(lang, "subscribe_text")

    await safe_edit_message(
        callback,
        message_text,
        reply_markup=plans_kb(lang, custom_prices, show_discount=False),
        parse_mode=ParseMode.HTML,
    )
    await callback.answer()


@router.callback_query(F.data.startswith("plan:"))
async def show_token_selection(callback: CallbackQuery) -> None:
    """Показывает выбор токена (монеты) после выбора плана."""
    plan_id = callback.data.split(":")[1]  # type: ignore
    plan = SUBSCRIPTION_PLANS.get(plan_id)
    if not plan:
        await callback.answer("Unknown plan", show_alert=True)
        return

    user_id = callback.from_user.id
    lang = get_lang(user_id)
    price = get_plan_price_for_user(user_id, plan_id)
    price_str = fmt_price(price)

    logger.info(f"User {user_id} selected plan {plan_id}, price: {price}")
    await safe_edit_message(
        callback,
        tx(lang, "payment_select_token", plan=plan["label"], price=price_str),
        reply_markup=token_kb(lang, plan_id),
    )
    await callback.answer()


@router.callback_query(F.data.regexp(r"^token:[^:]+:[^:]+$"))
async def show_network_selection(callback: CallbackQuery) -> None:
    """Показывает выбор сети после выбора токена."""
    _, plan_id, token = callback.data.split(":")  # type: ignore
    plan = SUBSCRIPTION_PLANS.get(plan_id)
    tok = SUPPORTED_TOKENS.get(token)
    if not plan or not tok:
        await callback.answer("Unknown parameter", show_alert=True)
        return

    user_id = callback.from_user.id
    lang = get_lang(user_id)
    cancel_user_payment_sessions(user_id)

    price = get_plan_price_for_user(user_id, plan_id)
    price_str = fmt_price(price)

    await safe_edit_message(
        callback,
        tx(lang, "payment_select_network", plan=plan["label"], price=price_str, token=tok["name"]),
        reply_markup=network_kb(lang, plan_id, token),
    )
    await callback.answer()


@router.callback_query(F.data.startswith("net:"))
async def show_payment(callback: CallbackQuery, state: FSMContext) -> None:
    """Показывает платежную информацию после выбора сети."""
    parts = callback.data.split(":")  # type: ignore
    if len(parts) != 4:
        await callback.answer("Unknown parameter", show_alert=True)
        return

    _, plan_id, token, network = parts
    plan = SUBSCRIPTION_PLANS.get(plan_id)
    net = SUPPORTED_NETWORKS.get(network)
    tok = SUPPORTED_TOKENS.get(token)
    if not plan or not net or not tok:
        await callback.answer("Unknown parameter", show_alert=True)
        return

    user_id = callback.from_user.id
    lang = get_lang(user_id)

    wallet_address = get_master_wallet_address(network)
    if not wallet_address:
        await callback.answer("Wallet not configured", show_alert=True)
        return

    session_id = create_payment_session(user_id, plan_id, network, token, 0)
    await state.update_data(plan_id=plan_id, network=network, token=token, session_id=session_id)

    price = get_plan_price_for_user(user_id, plan_id)
    price_str = fmt_price(price)

    text = tx(
        lang, "payment_instructions",
        plan=plan["label"], price=price_str, token=tok["name"],
        network=net["name"], address=wallet_address,
    )

    logger.info(f"User {user_id} selected {tok['name']} on {net['name']}, master wallet: {wallet_address}")
    await safe_edit_message(
        callback, text,
        reply_markup=payment_kb(lang, plan_id, token, network),
        parse_mode=ParseMode.HTML,
    )
    await callback.answer()


@router.callback_query(F.data.startswith("confirm:"))
async def confirm_payment_handler(callback: CallbackQuery, state: FSMContext) -> None:
    """Хендлер кнопки «Подтвердить оплату» — переводит в режим ожидания хэша."""
    parts = callback.data.split(":")  # type: ignore
    if len(parts) != 4:
        await callback.answer("Data format error", show_alert=True)
        return

    _, plan_id, token, network = parts
    user_id = callback.from_user.id
    lang = get_lang(user_id)

    plan = SUBSCRIPTION_PLANS.get(plan_id, {})
    net = SUPPORTED_NETWORKS.get(network, {})
    tok = SUPPORTED_TOKENS.get(token, {})

    await state.update_data(plan_id=plan_id, network=network, token=token)

    text = tx(
        lang, "payment_enter_hash",
        plan=plan.get("label", plan_id),
        token=tok.get("name", token),
        network=net.get("name", network),
    )

    await safe_edit_message(callback, text, reply_markup=None)
    await state.set_state(PaymentStates.waiting_for_tx_hash)
    await callback.answer()
    logger.info(f"User {user_id} entered tx hash input mode for {plan_id}/{token}/{network}")


@router.message(PaymentStates.waiting_for_tx_hash, F.text)
async def process_tx_hash(message: Message, state: FSMContext, bot: Bot) -> None:
    """Обработка хэша транзакции от пользователя."""
    user_id = message.from_user.id  # type: ignore
    tx_hash = message.text.strip()  # type: ignore
    lang = get_lang(user_id)

    data = await state.get_data()
    plan_id = data.get("plan_id")
    network = data.get("network")
    token = data.get("token")
    session_id = data.get("session_id")

    if not plan_id or not network or not token:
        await safe_send_message(
            message,
            tx(lang, "payment_session_lost"),
            reply_markup=back_kb(lang),
        )
        await state.clear()
        return

    await bot.send_chat_action(message.chat.id, "typing")

    logger.info(f"User {user_id} submitted tx_hash: {tx_hash} for {network}/{token}")
    is_valid, error_msg, amount = await verify_transaction_by_hash(
        tx_hash=tx_hash,
        network=network,
        token=token,
        plan=plan_id,
        user_id=user_id,
    )

    if not is_valid:
        await safe_send_message(message, tx(lang, "payment_error", error=error_msg))
        logger.warning(f"Transaction verification failed for user {user_id}: {error_msg}")
        return

    plan = SUBSCRIPTION_PLANS.get(plan_id, {})
    tok = SUPPORTED_TOKENS.get(token, {})
    net = SUPPORTED_NETWORKS.get(network, {})

    record_payment(user_id, amount, plan_id, network, token, tx_hash)
    result = activate_subscription(user_id, plan_id, amount)
    action = result.get("action")
    expires_at = result.get("expires_at")
    days_added = result.get("days_added")

    if session_id:
        update_payment_session_tx_hash(session_id, tx_hash)
        complete_payment_session(session_id)

    api_key = await backend_client.activate_subscription(user_id, plan_id, expires_at)
    if api_key:
        api_key_text = tx(lang, "payment_api_key", key=api_key)
    else:
        api_key_text = tx(lang, "payment_api_key_error")
        logger.error(f"Failed to get API key from backend for user {user_id}")

    needs_invite = plan.get("invite_links", False)
    link_text = ""
    if needs_invite:
        try:
            invite_links = await create_invite_links(bot, user_id, plan.get("label", plan_id))
            link_text = _build_invite_links_text(lang, invite_links)
        except Exception as e:
            logger.error(f"Failed to create invite links for user {user_id}: {e}")
            link_text = tx(lang, "invite_error")
        if NOTIFICATION_BOT_USERNAME:
            link_text += tx(lang, "notification_bot", username=NOTIFICATION_BOT_USERNAME)

    if action == "extended" and expires_at and days_added:
        expires_dt = datetime.fromisoformat(expires_at).astimezone(timezone(timedelta(hours=3)))
        success_text = tx(
            lang, "payment_success_extended",
            days=days_added,
            expires=expires_dt.strftime("%d.%m.%Y %H:%M"),
            amount=amount, token=tok.get("name", token), network=net.get("name", network), tx=tx_hash,
        )
    else:
        success_text = tx(
            lang, "payment_success_new",
            plan=plan.get("label", plan_id), amount=amount,
            token=tok.get("name", token), network=net.get("name", network), tx=tx_hash,
        )

    await safe_send_message(
        message,
        success_text + api_key_text + link_text,
        parse_mode=ParseMode.HTML,
    )

    # Нотификация администратора
    admin_chat_id = os.getenv("ADMIN_CHAT_ID")
    if admin_chat_id:
        try:
            profile = get_user_profile(user_id)
            user_display = f"{user_id}"
            if profile:
                if profile.get("username"):
                    user_display += f" | @{profile['username']}"
                elif profile.get("first_name"):
                    user_display += f" | {profile['first_name']}"

            ref_info = get_user_referral_info(user_id)
            ref_text = ""
            if ref_info:
                ref_name = ref_info.get("name") or "без названия"
                ref_text = f"\nРеф. ссылка: {ref_name} ({ref_info['code']})"

            await bot.send_message(
                int(admin_chat_id),
                f"💰 Новая оплата:\n"
                f"Пользователь: {user_display}\n"
                f"План: {plan.get('label', plan_id)}\n"
                f"Сумма: {amount} {tok.get('name', token)}\n"
                f"Сеть: {net.get('name', network)}\n"
                f"Tx: {tx_hash}"
                f"{ref_text}",
            )
        except Exception as e:
            logger.error(f"Failed to send admin notification: {e}")

    await state.clear()
    logger.info(f"Payment confirmed for user {user_id}: {amount} {token} on {network}, tx={tx_hash}")


@router.callback_query(F.data == "profile")
async def show_profile(callback: CallbackQuery) -> None:
    user_id = callback.from_user.id
    lang = get_lang(user_id)
    subscription = get_user_subscription(user_id)

    # Статус подписки
    if subscription:
        plan_info = SUBSCRIPTION_PLANS.get(subscription["plan"], {})
        plan_label = plan_info.get("label", subscription["plan"])
        if subscription["expires_at"]:
            expires_utc = datetime.fromisoformat(subscription["expires_at"])
            expires_msk = expires_utc.astimezone(timezone(timedelta(hours=3)))
            status = tx(lang, "profile_sub_active", plan=plan_label, expires=expires_msk.strftime("%d.%m.%Y %H:%M"))
        else:
            status = plan_label
    else:
        status = tx(lang, "profile_sub_none")

    sub_line = tx(lang, "profile_sub_label", status=status)

    if is_user_admin(user_id):
        demo_code = ensure_admin_demo_link(user_id)
        bot_info = await callback.bot.get_me()  # type: ignore
        bot_username = bot_info.username or "bot"
        demo_url = f"https://t.me/{bot_username}?start={demo_code}"

        stats = get_admin_referral_stats(user_id)
        buyers = stats["buyers"]
        admin_share = stats["admin_share"]
        commission_pct = stats["commission_percent"]
        plan_counts = stats.get("plan_counts", {"1week": 0, "1month": 0, "3months": 0})

        text = (
            f"{tx(lang, 'profile_title')}\n\n"
            f"{tx(lang, 'admin_status')}\n"
            f"{tx(lang, 'admin_purchases', buyers=buyers, share=f'{admin_share:.2f}', pct=commission_pct)}\n"
            f"LITE: {plan_counts.get('1week', 0)}\n"
            f"PRO: {plan_counts.get('1month', 0)}\n"
            f"MAX: {plan_counts.get('3months', 0)}\n\n"
            f"{tx(lang, 'admin_demo_link')}\n<code>{demo_url}</code>"
        )
    else:
        # Реферальный блок для обычных пользователей
        own_code = get_user_own_referral_code(user_id)
        if own_code:
            bot_info = await callback.bot.get_me()  # type: ignore
            bot_username = bot_info.username or "bot"
            ref_url = f"https://t.me/{bot_username}?start={own_code}"
        else:
            ref_url = "—"

        balance = get_referral_balance(user_id)
        paid_count = get_referral_paid_count(user_id)

        ref_block = (
            f"\n\n{tx(lang, 'profile_ref_link', link=ref_url)}\n"
            f"{tx(lang, 'profile_ref_balance', balance=f'{balance:.2f}')}\n"
            f"{tx(lang, 'profile_ref_count', count=paid_count)}\n"
            f"{tx(lang, 'profile_ref_percent')}\n\n"
            f"{tx(lang, 'profile_ref_invite')}"
        )
        text = (
            f"{tx(lang, 'profile_title')}\n\n"
            f"{sub_line}"
            f"{ref_block}"
        )

    logger.info(f"User {user_id} opened profile")
    await safe_edit_message(
        callback, text,
        reply_markup=profile_kb(lang),
        parse_mode=ParseMode.HTML,
    )
    await callback.answer()


# ─── Вывод реферального баланса ───────────────────────────────────────────────


_WITHDRAWAL_NETWORKS = {
    "base": "Base",
    "arbitrum": "Arbitrum One",
}


@router.callback_query(F.data == "withdrawal_start")
async def withdrawal_start(callback: CallbackQuery, state: FSMContext) -> None:
    """Начало процесса вывода: выбор сети."""
    user_id = callback.from_user.id
    lang = get_lang(user_id)
    balance = get_referral_balance(user_id)

    if balance < 10 and not is_user_admin(user_id):
        await callback.answer(tx(lang, "withdrawal_insufficient"), show_alert=True)
        return

    await state.update_data(withdrawal_balance=balance)
    await state.set_state(WithdrawalStates.waiting_for_network)

    network_kb_markup = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Base", callback_data="withdrawal_net:base")],
        [InlineKeyboardButton(text="Arbitrum One", callback_data="withdrawal_net:arbitrum")],
        [InlineKeyboardButton(text=tx(lang, "btn_back"), callback_data="profile")],
    ])

    text = (
        f"{tx(lang, 'withdrawal_title')}\n\n"
        f"{tx(lang, 'withdrawal_balance', balance=f'{balance:.2f}')}\n\n"
        f"{tx(lang, 'withdrawal_min')}\n\n"
        f"{tx(lang, 'withdrawal_choose_network')}"
    )
    await safe_edit_message(callback, text, reply_markup=network_kb_markup)
    await callback.answer()


@router.callback_query(WithdrawalStates.waiting_for_network, F.data.startswith("withdrawal_net:"))
async def withdrawal_network_selected(callback: CallbackQuery, state: FSMContext) -> None:
    """Пользователь выбрал сеть — просим ввести сумму."""
    network = callback.data.split(":")[1]  # type: ignore
    if network not in _WITHDRAWAL_NETWORKS:
        await callback.answer("Unknown network", show_alert=True)
        return

    lang = get_lang(callback.from_user.id)
    data = await state.get_data()
    balance = data.get("withdrawal_balance", 0.0)

    await state.update_data(withdrawal_network=network)
    await state.set_state(WithdrawalStates.waiting_for_amount)

    net_name = _WITHDRAWAL_NETWORKS[network]
    await safe_edit_message(
        callback,
        f"{tx(lang, 'withdrawal_title')}\n\n"
        f"{tx(lang, 'withdrawal_network_label', network=net_name)}\n"
        f"{tx(lang, 'withdrawal_balance', balance=f'{balance:.2f}')}\n\n"
        f"{tx(lang, 'withdrawal_enter_amount', balance=f'{balance:.2f}')}",
        reply_markup=None,
    )
    await callback.answer()


@router.message(WithdrawalStates.waiting_for_amount, F.text)
async def process_withdrawal_amount(message: Message, state: FSMContext) -> None:
    """Обработка введённой суммы вывода."""
    user_id = message.from_user.id  # type: ignore
    lang = get_lang(user_id)
    data = await state.get_data()
    network = data.get("withdrawal_network", "")
    net_name = _WITHDRAWAL_NETWORKS.get(network, network)

    try:
        amount = float(message.text.strip().replace(",", "."))  # type: ignore
    except ValueError:
        await safe_send_message(message, tx(lang, "withdrawal_invalid_amount"))
        return

    if amount < 10 and not is_user_admin(user_id):
        await safe_send_message(message, tx(lang, "withdrawal_min_error"))
        return

    actual_balance = get_referral_balance(user_id)
    if amount > actual_balance:
        await safe_send_message(
            message,
            tx(lang, "withdrawal_insufficient_balance", balance=f"{actual_balance:.2f}"),
        )
        return

    await state.update_data(withdrawal_amount=amount, withdrawal_balance=actual_balance)
    await state.set_state(WithdrawalStates.waiting_for_address)

    await safe_send_message(
        message,
        f"{tx(lang, 'withdrawal_network_label', network=net_name)}: {amount:.2f}$\n\n"
        f"{tx(lang, 'withdrawal_enter_address')}",
    )


@router.message(WithdrawalStates.waiting_for_address, F.text)
async def process_withdrawal_address(message: Message, state: FSMContext, bot: Bot) -> None:
    """Обработка EVM-адреса — создаём запрос и отправляем уведомление админам."""
    import re

    user_id = message.from_user.id  # type: ignore
    lang = get_lang(user_id)
    evm_address = message.text.strip()  # type: ignore

    if not re.match(r"^0x[0-9a-fA-F]{40}$", evm_address):
        await safe_send_message(message, tx(lang, "withdrawal_invalid_address"))
        return

    data = await state.get_data()
    amount = data.get("withdrawal_amount", 0.0)
    network = data.get("withdrawal_network", "")
    net_name = _WITHDRAWAL_NETWORKS.get(network, network)

    request_id = create_withdrawal_request(user_id, amount, evm_address, network)
    if request_id is None:
        await safe_send_message(message, tx(lang, "withdrawal_request_error"))
        await state.clear()
        return

    profile = get_user_profile(user_id)
    username = profile.get("username") if profile else None
    user_display = f"@{username}" if username else f"id:{user_id}"

    now_msk = datetime.now(timezone(timedelta(hours=3)))
    time_str = now_msk.strftime("%H:%M:%S")

    notification_text = (
        f"Пользователь {user_display} оставил запрос на вывод.\n"
        f"Сумма: {amount:.0f}$\n"
        f"Сеть: {net_name}\n"
        f"Адрес: {evm_address}\n"
        f"Время: {time_str} (МСК)"
    )

    confirm_kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Подтвердить", callback_data=f"confirm_withdrawal:{request_id}")]
    ])

    withdrawal_chat_id_str = os.getenv("WITHDRAWAL_CHAT_ID", "").strip()
    if not withdrawal_chat_id_str:
        logger.error("WITHDRAWAL_CHAT_ID не задан в .env")
        add_referral_balance(user_id, amount)
        update_withdrawal_request(request_id, status="failed")
        await safe_send_message(message, "Ошибка конфигурации бота. Обратитесь в поддержку.\nБаланс восстановлен.")
        await state.clear()
        return

    withdrawal_chat_id = int(withdrawal_chat_id_str)

    try:
        sent_msg = await bot.send_message(withdrawal_chat_id, notification_text, reply_markup=confirm_kb)
        update_withdrawal_request(
            request_id,
            notification_message_id=sent_msg.message_id,
            notification_chat_id=withdrawal_chat_id,
        )
        logger.info(f"Запрос на вывод #{request_id} отправлен в чат {withdrawal_chat_id}")
    except Exception as e:
        logger.error(f"Не удалось отправить уведомление о выводе: {e}")
        add_referral_balance(user_id, amount)
        update_withdrawal_request(request_id, status="failed")
        await safe_send_message(message, "Не удалось отправить запрос администратору. Баланс восстановлен.\nПопробуйте позже.")
        await state.clear()
        return

    await safe_send_message(
        message,
        tx(lang, "withdrawal_success", amount=f"{amount:.0f}", network=net_name, address=evm_address),
    )
    await state.clear()
    logger.info(f"Пользователь {user_id} оформил вывод #{request_id}: {amount}$ → {evm_address} ({network})")


@router.callback_query(F.data.startswith("confirm_withdrawal:"))
async def confirm_withdrawal_admin(callback: CallbackQuery) -> None:
    """Администратор подтверждает вывод — отправляем USDC пользователю."""
    raw_id = callback.data.split(":")[1]  # type: ignore
    if not raw_id.isdigit():
        await callback.answer("Неверный формат запроса", show_alert=True)
        return

    request_id = int(raw_id)
    request = get_withdrawal_request(request_id)

    if not request:
        await callback.answer("Запрос не найден", show_alert=True)
        return

    if request["status"] != "pending":
        await callback.answer("Запрос уже обработан", show_alert=True)
        return

    if callback.message and hasattr(callback.message, "edit_text"):
        try:
            await callback.message.edit_text(  # type: ignore
                "Запрос на вывод подтверждается — ожидание...",
                reply_markup=None,
            )
        except Exception:
            pass

    await callback.answer()
    update_withdrawal_request(request_id, status="confirming")

    withdrawal_wallet = get_withdrawal_wallet()
    if not withdrawal_wallet:
        logger.error("WITHDRAWAL_WALLET_KEY не задан в .env")
        add_referral_balance(request["user_id"], request["amount"])
        update_withdrawal_request(request_id, status="failed")
        if callback.message and hasattr(callback.message, "edit_text"):
            try:
                await callback.message.edit_text(  # type: ignore
                    "❌ Ошибка: кошелёк для вывода не настроен. Баланс пользователя восстановлен."
                )
            except Exception:
                pass
        return

    network = request.get("network") or "base"
    net_name = _WITHDRAWAL_NETWORKS.get(network, network)
    evm_address = request["evm_address"]

    try:
        from src.evm_sender import send_erc20_usdc

        tx_hash = await send_erc20_usdc(
            withdrawal_wallet["private_key"],
            evm_address,
            request["amount"],
            network,
        )

        update_withdrawal_request(request_id, status="completed", tx_hash=tx_hash)

        profile = get_user_profile(request["user_id"])
        username = profile.get("username") if profile else None
        user_display = f"@{username}" if username else f"id:{request['user_id']}"

        if callback.message and hasattr(callback.message, "edit_text"):
            try:
                await callback.message.edit_text(  # type: ignore
                    f"Запрос на вывод для {user_display} успешно подтвержден — средства отправлены!\n"
                    f"Адрес получателя: {evm_address}\n"
                    f"Сеть: {net_name}\n"
                    f"Tx_Hash: {tx_hash}"
                )
            except Exception:
                pass

        try:
            user_lang = get_lang(request["user_id"])
            await callback.bot.send_message(  # type: ignore
                request["user_id"],
                f"✅ {'Вывод средств выполнен!' if user_lang == 'ru' else 'Withdrawal completed!'}\n\n"
                f"{'Сумма' if user_lang == 'ru' else 'Amount'}: {request['amount']:.0f}$\n"
                f"{'Сеть' if user_lang == 'ru' else 'Network'}: {net_name}\n"
                f"{'Адрес' if user_lang == 'ru' else 'Address'}: {evm_address}\n"
                f"Tx Hash: {tx_hash}",
            )
        except Exception as e:
            logger.warning(f"Не удалось уведомить пользователя {request['user_id']} о выводе: {e}")

        logger.info(f"Вывод #{request_id} выполнен: {request['amount']}$ → {evm_address} ({network}), tx={tx_hash}")

    except Exception as e:
        logger.error(f"Ошибка при отправке USDC для вывода #{request_id}: {e}")
        add_referral_balance(request["user_id"], request["amount"])
        update_withdrawal_request(request_id, status="failed")

        if callback.message and hasattr(callback.message, "edit_text"):
            try:
                await callback.message.edit_text(  # type: ignore
                    f"❌ Ошибка при отправке средств!\n"
                    f"Адрес: {evm_address}\n"
                    f"Сеть: {net_name}\n"
                    f"Сумма: {request['amount']:.0f}$\n\n"
                    f"Баланс пользователя восстановлен.\n"
                    f"Ошибка: {e}"
                )
            except Exception:
                pass


# ─── Настройка команд бота ────────────────────────────────────────────────────


async def setup_bot_commands(bot: Bot) -> None:
    await bot.set_my_commands([
        BotCommand(command="start", description="Перезапустить бота / Restart bot"),
    ])
    logger.info("Bot commands configured")
