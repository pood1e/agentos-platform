"""Validate optional speech configuration through platform and solution charts."""

import argparse
import base64
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
    secret = next(
        item for item in resources
        if item["kind"] == "Secret" and item["metadata"]["name"].endswith("-speech")
    )
    assert environment["AGENTOS_SPEECH_SECRET"]["value"] == secret["metadata"]["name"]
    assert "AGENTOS_SPEECH_CONFIG" not in environment
    assert not any(item["name"].startswith("speech") for item in pod.get("volumes", []))
    assert not any(item["name"].startswith("speech") for item in container.get("volumeMounts", []))
    effective = json.loads(base64.b64decode(secret["data"]["configuration.json"]))
    assert ("transcription" in effective) == input_enabled
    assert ("synthesis" in effective) == output_enabled
    assert ("credentials-secret" in secret["data"]) == authenticated
    if authenticated:
        assert base64.b64decode(secret["data"]["credentials-secret"]).decode() == "speech-credentials"
    if input_enabled:
        assert effective["transcription"] == transcription
    if output_enabled:
        assert effective["synthesis"] == synthesis

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

for enabled in [False, True]:
    voice = {"enabled": enabled, "image": "registry.example.com/voice@sha256:" + "1" * 64}
    resources = [item for item in yaml.safe_load_all(subprocess.check_output(
        [*base, "--set-json", f"{arguments.prefix}voice={json.dumps(voice)}"], text=True)) if item]
    workers = [item for item in resources if item['kind'] == 'Deployment' and item['metadata']['name'].endswith('-voice')]
    assert len(workers) == int(enabled)
    console = next(item for item in resources if item['kind'] == 'Deployment' and item['metadata']['name'].endswith('-console'))
    environment = {entry['name']: entry for entry in console['spec']['template']['spec']['containers'][0]['env']}
    assert ('AGENTOS_VOICE_URL' in environment) == enabled
    assert ('AGENTOS_VOICE_TOKEN' in environment) == enabled
    if enabled:
        pod = workers[0]['spec']['template']['spec']
        assert not pod['automountServiceAccountToken']
        assert pod['containers'][0]['securityContext']['readOnlyRootFilesystem']
        assert pod['containers'][0]['readinessProbe']['exec']['command']
        assert any(item['kind'] == 'NetworkPolicy' and item['metadata']['name'].endswith('-voice') for item in resources)

print("Speech and voice configuration validation passed")
