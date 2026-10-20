from string import Template

from agentos.automation.v1.automation_pb2 import (
    HANDLING_MODE_UNKNOWN,
    VERIFICATION_PENDING,
    CaseFact,
)
from agentos.kagent.v1.wire_pb2 import InvokeSessionOutput
from google.protobuf.json_format import MessageToDict, ParseDict
from temporalio import activity

from .platform import Platform


class CaseActivities:
    def __init__(self, config, bus):
        self.platform = Platform(config)
        self.bus = bus
        self.brief = Template(config.trigger.brief)

    @activity.defn
    async def run_case(self, reference):
        message = self.brief.safe_substitute(summary=reference["summary"])
        result = await self.platform.call("run_case", reference, message)
        return MessageToDict(result)

    @activity.defn
    async def observe_case(self, reference):
        return MessageToDict(await self.platform.call("observe_case", reference))

    @activity.defn
    async def cancel_case(self, reference):
        await self.platform.call("cancel_case", reference)

    @activity.defn
    async def publish_case(self, fact):
        data = fact["data"]
        value = CaseFact(
            case_key=fact["key"],
            environment=data["environment"],
            source_version=int(data["sourceVersion"]),
            phase=data["phase"],
            handling=HANDLING_MODE_UNKNOWN,
            verification=VERIFICATION_PENDING,
        )
        if data["native"]:
            value.native.Pack(ParseDict(data["native"], InvokeSessionOutput()))
        return await self.bus.publish(
            fact["type"], fact["key"], fact["version"], MessageToDict(value)
        )
