import asyncio
from pathlib import Path

import nats
import uvicorn
from temporalio.client import Client
from temporalio.worker import Worker

from .activities import CaseActivities
from .bus import EventBus
from .config import load_config
from .consumer import consume
from .http import application
from .workflow import CaseWorkflow


async def main():
    config = load_config()
    broker = await nats.connect(
        config.nats_url,
        user=config.nats_user,
        password=(await asyncio.to_thread(Path(config.nats_password_file).read_text)).strip(),
        name="agentos-automation-" + config.environment,
    )
    bus = EventBus(broker, config.environment, config.trigger.event_namespace)
    temporal = await Client.connect(config.temporal_address, namespace=config.temporal_namespace)
    activities = CaseActivities(config, bus)
    worker = Worker(
        temporal,
        task_queue=config.task_queue,
        workflows=[CaseWorkflow],
        activities=[
            activities.run_case,
            activities.observe_case,
            activities.cancel_case,
            activities.publish_case,
        ],
    )
    server = uvicorn.Server(
        uvicorn.Config(
            application(config, bus, lambda: broker.is_connected),
            host="0.0.0.0",
            port=8080,
            access_log=False,
        )
    )
    try:
        async with worker, asyncio.TaskGroup() as tasks:
            consumer = tasks.create_task(consume(config, bus, temporal))
            await server.serve()
            consumer.cancel()
    finally:
        await broker.drain()


if __name__ == "__main__":
    asyncio.run(main())
