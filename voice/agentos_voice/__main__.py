import logging

import uvicorn

logging.basicConfig(level=logging.WARNING)
uvicorn.run("agentos_voice.app:app", host="0.0.0.0", port=8080, access_log=False)
