"""Exercise OIDC discovery and connection rendering through production Ansible tasks."""

import base64
import datetime
import ipaddress
import json
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parents[1]
TASKS = ROOT / "playbooks/environments/tasks/discover-oidc.yaml"
TEMPLATES = ROOT / "playbooks/environments/templates"


class OIDCDiscoveryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test issuer")])
        now = datetime.datetime.now(datetime.UTC)
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=1))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(
                x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
                critical=False,
            )
            .sign(key, hashes.SHA256())
        )
        self.ca = self.path / "ca.pem"
        self.ca.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path = self.path / "key.pem"
        key_path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        issuer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                profile = self.path.split("/")[1]
                origin = f"{issuer.origin}/{profile}"
                metadata = {
                    "issuer": "https://wrong.test" if profile == "mismatch" else origin,
                    "jwks_uri": origin + "/keys",
                    "token_endpoint": origin + "/token",
                }
                if profile == "insecure":
                    metadata["token_endpoint"] = "http://insecure.test/token"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(metadata).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.ca, key_path)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        self.origin = f"https://127.0.0.1:{server.server_port}"
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.addCleanup(stop)

    def run_playbook(self, tasks, variables):
        playbook = self.path / "verify.yaml"
        playbook.write_text(
            yaml.safe_dump(
                [
                    {
                        "name": "Verify native identity configuration",
                        "hosts": "localhost",
                        "connection": "local",
                        "gather_facts": False,
                        "module_defaults": {"ansible.builtin.uri": {"ca_path": str(self.ca)}},
                        "vars": {
                            "ansible_python_interpreter": "{{ ansible_playbook_python }}",
                            **variables,
                        },
                        "tasks": tasks,
                    }
                ]
            )
        )
        return subprocess.run(
            ["ansible-playbook", str(playbook)], cwd=ROOT, text=True, capture_output=True
        )

    def test_native_connection_configuration_converges(self):
        output = self.path / "connections.json"
        tasks = [
            {
                "ansible.builtin.include_tasks": str(TASKS),
                "vars": {"oidc_issuer": self.origin + "/environment"},
            },
            {
                "ansible.builtin.set_fact": {
                    "environment_connection": "{{ lookup('ansible.builtin.template', '"
                    + str(TEMPLATES / "connection-values.json.j2")
                    + "') | from_json }}"
                }
            },
            {
                "ansible.builtin.include_tasks": str(TASKS),
                "vars": {"oidc_issuer": self.origin + "/platform"},
            },
            {
                "ansible.builtin.template": {
                    "src": str(TEMPLATES / "connection-release.json.j2"),
                    "dest": str(output),
                    "mode": "0600",
                }
            },
        ]
        variables = {
            "environment_name": "lab",
            "environment_governance": "direct",
            "environment_issuer": self.origin + "/environment",
            "environment_discovery_auth": {
                "oauth2": {
                    "clientId": "agentos-catalog",
                    "clientSecretRef": {"name": "lab-catalog", "key": "client-secret"},
                    "caCertificateRef": {"name": "lab-identity-ca", "key": "ca.crt"},
                }
            },
            "gateway_resource": "https://environment.test/mcp",
            "ansible_host": "192.0.2.1",
            "gateway_server_name": "environment.test",
            "gateway_node_port": 31000,
            "gateway_certificate": {
                "resources": [{"data": {"ca.crt": base64.b64encode(b"CA").decode()}}]
            },
            "toolsets": {},
            "engineer_identities": [],
            "environment_apis": [],
            "environment_connectors": {},
            "connected_environments": ["{{ environment_connection }}"],
            "platform_release": "agentos",
            "native_controller_service_account": "kagent-controller",
            "native": {"platform_actor_issuer": "https://actors.test"},
            "platform_identity": {
                "issuer": self.origin + "/platform",
                "audience": "agentos",
                "writerRole": "writer",
            },
        }
        for changed in [1, 0]:
            result = self.run_playbook(tasks, variables)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn(f"changed={changed}", result.stdout)
        values = json.loads(output.read_text())
        self.assertEqual(
            values["environments"][0]["tokenEndpointURL"], self.origin + "/environment/token"
        )
        self.assertEqual(values["environments"][0]["jwksURL"], self.origin + "/environment/keys")
        self.assertEqual(
            values["environments"][0]["discoveryAuth"],
            {
                "oauth2": {
                    **variables["environment_discovery_auth"]["oauth2"],
                    "tokenEndpoint": self.origin + "/environment/token",
                }
            },
        )
        self.assertEqual(
            values["platform"]["authentication"],
            {
                "issuer": self.origin + "/platform",
                "audiences": ["agentos"],
                "jwks": {"remote": {"url": self.origin + "/platform/keys"}},
            },
        )
        self.assertEqual(values["platform"]["writerRole"], "writer")

    def test_mismatched_or_insecure_discovery_fails_closed(self):
        for profile in ["mismatch", "insecure"]:
            with self.subTest(profile=profile):
                result = self.run_playbook(
                    [{"ansible.builtin.include_tasks": str(TASKS)}],
                    {"oidc_issuer": self.origin + "/" + profile},
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Verify identity provider endpoints", result.stdout)

    def test_native_execution_requires_explicit_scope_rules(self):
        result = self.run_playbook(
            [
                {
                    "ansible.builtin.include_tasks": str(
                        ROOT / "playbooks/deploy/tasks/execution-credentials.yaml"
                    )
                }
            ],
            {
                "site_identity": {
                    "issuer": self.origin + "/platform",
                    "audience": "agentos-api",
                    "clientId": "agentos-web",
                },
                "kagent_execution_authorization": {"scopeClaim": "roles", "rules": []},
            },
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Validate native execution authorization", result.stdout)
        self.assertNotIn("TASK [Discover", result.stdout)

    def test_native_execution_requires_gateway_audience_list(self):
        invalid = [
            {},
            {"gatewayAudience": "https://gateway.example.test"},
            {"gatewayAudiences": []},
            {"gatewayAudiences": "http://gateway.example.test"},
            {"gatewayAudiences": {"gateway": "http://gateway.example.test"}},
            {
                "gatewayAudiences": ["http://gateway.example.test"],
                "gatewayAudience": "https://gateway.example.test",
            },
        ]
        for audiences in invalid:
            with self.subTest(audiences=audiences):
                result = self.run_playbook(
                    [
                        {
                            "ansible.builtin.include_tasks": str(
                                ROOT / "playbooks/deploy/tasks/execution-credentials.yaml"
                            )
                        }
                    ],
                    {
                        "site_identity": {
                            "issuer": self.origin + "/platform",
                            "audience": "agentos-api",
                            "clientId": "agentos-web",
                        },
                        "kagent_execution_authorization": {
                            "scopeClaim": "roles",
                            "rules": [{"resourceType": "Session", "verbs": ["get"]}],
                            **audiences,
                        },
                    },
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Validate native execution authorization", result.stdout)
                self.assertNotIn("TASK [Discover", result.stdout)
