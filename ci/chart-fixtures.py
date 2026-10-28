"""Write the Conftest data and value scenarios derived from chart sources."""

import json
from pathlib import Path

import yaml

cache = Path(".cache/chart-check")
cache.mkdir(parents=True, exist_ok=True)


def names(directory):
    return sorted(path.stem for path in Path(directory).glob("*.yaml"))


(cache / "test-data.json").write_text(
    json.dumps(
        {
            "test": {
                "systemTemplates": names("charts/agentos/presets/system"),
                "solutionTemplates": names("tests/fixtures/solution-chart/presets/engineers"),
            }
        },
        indent=2,
    )
)
solution = yaml.safe_load(Path("tests/fixtures/solution-chart/values.yaml").read_text())
solution["global"]["agentos"]["environments"] = [{"name": "env-direct", "governance": "direct"}]
(cache / "direct-values.json").write_text(json.dumps(solution, indent=2))
