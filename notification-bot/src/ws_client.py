import asyncio
import logging
from collections.abc import Awaitable, Callable

import socketio

logger = logging.getLogger(__name__)

OpportunityHandler = Callable[[dict], Awaitable[None]]

RECONNECT_DELAY = 10  # секунд между попытками подключения


class ArbitrageWSClient:
    def __init__(
        self,
        url: str,
        api_key: str,
        on_new: OpportunityHandler,
        on_updated: OpportunityHandler | None = None,
        on_expired: OpportunityHandler | None = None,
    ) -> None:
        self.url = url
        self.api_key = api_key
        self.on_new = on_new
        self.on_updated = on_updated
        self.on_expired = on_expired

    def _make_client(self) -> socketio.AsyncClient:
        sio = socketio.AsyncClient(
            reconnection=False,  # управляем переподключением вручную
            logger=False,
            engineio_logger=False,
        )

        @sio.event(namespace="/arbitrage")
        async def connect():
            logger.info("WebSocket подключён к /arbitrage")

        @sio.event(namespace="/arbitrage")
        async def disconnect():
            logger.warning("WebSocket отключён от /arbitrage")

        @sio.on("error", namespace="/arbitrage")
        async def on_error(data):
            logger.error("Ошибка от сервера: %s", data)

        @sio.on("opportunity:new", namespace="/arbitrage")
        async def on_new(data):
            logger.debug("opportunity:new: %s", data.get("id"))
            await self.on_new(data)

        if self.on_updated:
            @sio.on("opportunity:updated", namespace="/arbitrage")
            async def on_updated(data):
                logger.debug("opportunity:updated: %s", data.get("id"))
                await self.on_updated(data)

        if self.on_expired:
            @sio.on("opportunity:expired", namespace="/arbitrage")
            async def on_expired(data):
                logger.debug("opportunity:expired: %s", data.get("id"))
                await self.on_expired(data)

        return sio

    async def run_forever(self) -> None:
        """Подключается к серверу и автоматически переподключается при разрыве."""
        while True:
            sio = self._make_client()
            try:
                await sio.connect(
                    self.url,
                    namespaces=["/arbitrage"],
                    auth={"apiKey": self.api_key},
                    transports=["websocket"],
                )
                await sio.wait()
            except Exception as exc:
                logger.error("Ошибка WebSocket соединения: %s", exc)
            finally:
                try:
                    await sio.disconnect()
                except Exception:
                    pass

            logger.info("Переподключение через %s сек...", RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)
