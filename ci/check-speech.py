"""Validate optional speech configuration through platform and solution charts."""

import argparse
import json
import subprocess

import yaml

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("chart")
parser.add_argument("values")
parser.add_argument("--prefix", default="")
arguments = parser.parse_args()
helm = ".cache/bin/helm"
base = [helm, "template", "speech-check", arguments.chart, "-f", arguments.values]
endpoint = {"baseUrl": "https://speech.example.test/v1"}
transcription = {"endpoint": endpoint, "model": "multilingual-asr", "languageCodes": ["zh", "en", "ar"],
                 "protocol": "PROTOCOL_WHISPERLIVEKIT"}
synthesis = {"endpoint": endpoint, "protocol": "PROTOCOL_NEMO", "voices": [
    {"languageCode": language, "model": "tts-" + language, "voice": "default"}
    for language in ["zh", "en", "ar"]
]}

for input_enabled, output_enabled, authenticated in [
    (False, False, False),
    (True, False, True),
    (False, True, True),
    (True, True, True),
    (True, True, False),
]:
    configuration = {
        "transcription": transcription if input_enabled else {},
        "synthesis": synthesis if output_enabled else {},
        "secretRef": "speech-credentials" if authenticated else "",
    }
    command = [*base, "--set-json", f"{arguments.prefix}speech={json.dumps(configuration)}"]
    rendered = subprocess.check_output(command, text=True)
    resources = [item for item in yaml.safe_load_all(rendered) if item]
    deployment = next(
        item
        for item in resources
        if item["kind"] == "Deployment" and item["metadata"]["name"].endswith("-console")
    )
    pod = deployment["spec"]["template"]["spec"]
    container = pod["containers"][0]
    environment = {item["name"]: item for item in container["env"]}
    configs = [
        item
        for item in resources
        if item["kind"] == "ConfigMap" and item["metadata"]["name"].endswith("-speech")
    ]
    enabled = input_enabled or output_enabled
    assert bool(configs) == enabled
    assert ("AGENTOS_SPEECH_CONFIG" in environment) == enabled
    if not enabled:
        assert not any(item["name"].startswith("speech") for item in pod["volumes"])
        continue
    effective = json.loads(configs[0]["data"]["configuration.json"])
    assert ("transcription" in effective) == input_enabled
    assert ("synthesis" in effective) == output_enabled
    assert "checksum/speech" in deployment["spec"]["template"]["metadata"]["annotations"]
    volume = next(item for item in pod["volumes"] if item["name"] == "speech")
    credentials = [item["secret"] for item in volume["projected"]["sources"] if "secret" in item]
    assert bool(credentials) == authenticated
    for kind in ("transcription", "synthesis"):
        if kind in effective:
            assert ("apiKeyFile" in effective[kind]["endpoint"]) == authenticated
    if input_enabled:
        assert effective["transcription"]["model"] == transcription["model"]
        assert effective["transcription"]["protocol"] == transcription["protocol"]
    if output_enabled:
        assert effective["synthesis"]["voices"] == synthesis["voices"]
        assert effective["synthesis"]["protocol"] == synthesis["protocol"]
    if authenticated:
        expected = {
            kind + "-api-key" for kind in ("transcription", "synthesis") if kind in effective
        }
        secret = credentials[0]
        assert secret["name"] == "speech-credentials"
        assert {item["key"] for item in secret["items"]} == expected
        assert all(item["path"] == "credentials/" + item["key"] for item in secret["items"])
        assert all(
            item["readOnly"]
            for item in container["volumeMounts"]
            if item["name"].startswith("speech")
        )

for invalid in [
    {"transcription": {**transcription, "protocol": "unknown"}},
    {"synthesis": {**synthesis, "protocol": "unknown"}},
    {"transcription": {**transcription, "languageCodes": ["zh", "zh"]}},
    {"transcription": {**transcription, "languageCodes": ["zh-CN"]}},
    {"transcription": {"model": "asr"}},
    {"synthesis": {"endpoint": endpoint, "voices": []}},
    {"transcription": {**transcription, "endpoint": {**endpoint, "apiKey": "inline-key"}}},
    {"transcription": {**transcription, "endpoint": {"baseUrl": "file:///tmp/speech"}}},
    {"synthesis": {**synthesis, "voices": [{"languageCode": "zh", "model": "tts"}]}},
    {"voice": "removed"},
    {"unknown": True},
]:
    result = subprocess.run(
        [*base, "--set-json", f"{arguments.prefix}speech={json.dumps(invalid)}"],
        capture_output=True,
    )
    assert result.returncode != 0, f"Invalid speech values accepted: {invalid}"

print("Speech configuration validation passed")
