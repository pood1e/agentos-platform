"""Immutable files in the native GitLab generic package registry."""

import hashlib
import os

import requests


class Registry:
    def __init__(self, package, version):
        self.url = f"{os.environ['CI_API_V4_URL']}/projects/{os.environ['CI_PROJECT_ID']}/packages/generic/{package}/{version}"
        self.session = requests.Session()
        self.session.headers["JOB-TOKEN"] = os.environ["CI_JOB_TOKEN"]

    def get(self, name):
        response = self.session.get(f"{self.url}/{name}", timeout=60)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.content

    def put(self, name, content):
        existing = self.get(name)
        if existing is not None:
            if hashlib.sha256(existing).digest() != hashlib.sha256(content).digest():
                raise ValueError(f"Published artifact differs: {name}")
            return
        self.session.put(f"{self.url}/{name}", data=content, timeout=120).raise_for_status()

    def close(self):
        self.session.close()
