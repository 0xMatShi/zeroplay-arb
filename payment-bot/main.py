import asyncio
import os

from dotenv import load_dotenv

# ВАЖНО: загружаем .env до импорта модулей, которые используют переменные окружения
load_dotenv()

from aiogram import Bot, Dispatcher
from aiogram.exceptions import TelegramForbiddenError

from src.logger import logger
from src.payments import (
    init_db,
    deactivate_expired_subscriptions,
    get_subscriptions_requiring_notification,
    mark_notification_sent,
    kick_and_unban_user,
    SUBSCRIPTION_PLANS,
)
from src.telegram_ui import router, setup_bot_commands
from src import backend_client

CHECK_INTERVAL = 5 * 20  # 5 минут


async def check_subscription_notifications(bot: Bot) -> None:
    """Фоновая задача: проверяет подписки и отправляет уведомления."""
    from datetime import datetime, timezone, timedelta

    while True:
        await asyncio.sleep(CHECK_INTERVAL)
        try:
            notifications = get_subscriptions_requiring_notification()
            kicked_telegram_ids = []

            for notif in notifications:
                user_id = notif["user_id"]
                sub_id = notif["subscription_id"]
                notif_type = notif["notification_type"]
                expires_at = notif["expires_at"]

                expires_dt = datetime.fromisoformat(expires_at).astimezone(timezone(timedelta(hours=3)))
                expires_str = expires_dt.strftime('%d.%m.%Y %H:%M')

                if notif_type == "1day":
                    message = (
                        f"⏰ Ваша подписка истекает завтра!\n\n"
                        f"Дата окончания: {expires_str} (МСК)\n\n"
                        f"Продлите подписку, чтобы не потерять доступ.\n"
                        f"Нажмите /start → \"Оплатить подписку\""
                    )
                    try:
                        await bot.send_message(user_id, message)
                        mark_notification_sent(user_id, sub_id, notif_type)
                        logger.info(f"Sent {notif_type} notification to user {user_id}")
                    except TelegramForbiddenError:
                        mark_notification_sent(user_id, sub_id, notif_type)
                        logger.warning(f"User {user_id} blocked bot, marked {notif_type} anyway")
                    except Exception as e:
                        logger.warning(f"Failed to send {notif_type} notification to user {user_id}: {e}")

                elif notif_type == "1hour":
                    message = (
                        f"⚠️ Ваша подписка истекает через час!\n\n"
                        f"Дата окончания: {expires_str} (МСК)\n\n"
                        f"Продлите подписку прямо сейчас!\n"
                        f"Нажмите /start → \"Оплатить подписку\""
                    )
                    try:
                        await bot.send_message(user_id, message)
                        mark_notification_sent(user_id, sub_id, notif_type)
                        logger.info(f"Sent {notif_type} notification to user {user_id}")
                    except TelegramForbiddenError:
                        mark_notification_sent(user_id, sub_id, notif_type)
                        logger.warning(f"User {user_id} blocked bot, marked {notif_type} anyway")
                    except Exception as e:
                        logger.warning(f"Failed to send {notif_type} notification to user {user_id}: {e}")

                elif notif_type == "expired":
                    # Отправляем уведомление (ошибка отправки не блокирует деактивацию)
                    try:
                        await bot.send_message(
                            user_id,
                            "❌ Ваша подписка истекла. Доступ закрыт.\n\n"
                            "Чтобы возобновить доступ, оформите новую подписку:\n"
                            "/start → \"Оплатить подписку\""
                        )
                    except TelegramForbiddenError:
                        logger.warning(f"User {user_id} blocked bot on expired notification")
                    except Exception as e:
                        logger.warning(f"Failed to send expired notification to user {user_id}: {e}")

                    mark_notification_sent(user_id, sub_id, "expired")

                    # Кикаем из чатов
                    kick_results = await kick_and_unban_user(bot, user_id)
                    logger.info(f"Kicked user {user_id} from chats: {kick_results}")

                    # Добавляем в список на деактивацию бэкенда ДО любых DB-операций,
                    # которые могут упасть — чтобы API-ключ удалился в любом случае
                    kicked_telegram_ids.append(user_id)

                    try:
                        mark_notification_sent(user_id, sub_id, "kicked")
                    except Exception as e:
                        logger.error(f"Failed to mark kicked for user {user_id}: {e}")

                    logger.info(f"Processed expiry for user {user_id}")

            # Деактивируем просроченные подписки в локальной БД одним вызовом
            if kicked_telegram_ids:
                deactivate_expired_subscriptions()

            # Деактивируем API-ключи в бэкенде одним запросом
            if kicked_telegram_ids:
                await backend_client.deactivate_subscriptions(kicked_telegram_ids)
                logger.info(f"Deactivated backend subscriptions for: {kicked_telegram_ids}")

        except Exception as e:
            logger.error(f"Error in subscription notifications check: {e}")


async def main() -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        logger.error("TELEGRAM_BOT_TOKEN not found in .env")
        return

    group_id = os.getenv("PRIVATE_GROUP_ID")
    logger.info(f"Loaded PRIVATE_GROUP_ID from .env: {group_id}")

    init_db()

    bot = Bot(token=token)
    dp = Dispatcher()
    dp.include_router(router)

    await setup_bot_commands(bot)

    asyncio.create_task(check_subscription_notifications(bot))

    logger.info("Bot started")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
