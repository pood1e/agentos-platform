import pytest
from aiohttp import web


@pytest.fixture
async def serve():
    runners = []

    async def start(path, handler):
        app = web.Application()
        app.router.add_route("*", path, handler)
        runner = web.AppRunner(app)
        await runner.setup()
        runners.append(runner)
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = runner.addresses[0][1]
        return f"http://127.0.0.1:{port}"

    yield start
    for runner in runners:
        await runner.cleanup()
