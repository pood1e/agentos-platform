"""Converge one Cloudflare A record using the official SDK."""

import argparse
import json

from cloudflare import Cloudflare


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zone", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--address")
    parser.add_argument("--state", choices=["present", "absent"], default="present")
    args = parser.parse_args()
    if args.state == "present" and not args.address:
        parser.error("--address is required for a present record")
    with Cloudflare() as client:
        zones = list(client.zones.list(name=args.zone))
        if len(zones) != 1:
            raise RuntimeError("Expected one authorized DNS zone")
        zone_id = zones[0].id
        records = list(client.dns.records.list(zone_id=zone_id, name={"exact": args.name}))
        changed = False
        if args.state == "absent":
            for record in records:
                if record.type != "A":
                    raise RuntimeError("Conflicting DNS records; no changes applied")
            for record in records:
                client.dns.records.delete(record.id, zone_id=zone_id)
                changed = True
        elif not records:
            client.dns.records.create(
                zone_id=zone_id, type="A", name=args.name,
                content=args.address, ttl=60, proxied=False,
                comment="AgentOS platform",
            )
            changed = True
        elif len(records) == 1 and records[0].type == "A":
            record = records[0]
            if record.content != args.address or record.proxied or record.ttl != 60:
                client.dns.records.update(
                    record.id, zone_id=zone_id, type="A", name=args.name,
                    content=args.address, ttl=60, proxied=False,
                )
                changed = True
        else:
            raise RuntimeError("Conflicting DNS records; no changes applied")
        print(json.dumps({"changed": changed, "name": args.name, "address": args.address}))


if __name__ == "__main__":
    main()
