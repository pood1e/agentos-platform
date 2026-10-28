package speech

import (
	"encoding/json"
	"strings"
	"testing"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	console "github.com/pood1e/agentos-platform/controller/internal/proto/agentos/console/v1"
	"k8s.io/utils/ptr"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func TestCompile(t *testing.T) {
	gateway := Gateway{Namespace: "test", Name: "gateway", Subject: "system:serviceaccount:test:voice", Issuer: "https://kubernetes.test", JWKS: `{"keys":[]}`}
	configuration := &console.SpeechConfiguration{
		Transcription: &console.SpeechTranscription{Endpoint: &console.SpeechEndpoint{BaseUrl: "https://asr.test/custom/v1"}, Model: "asr", Protocol: console.SpeechTranscription_PROTOCOL_DEEPGRAM},
		Synthesis:     &console.SpeechSynthesis{Endpoint: &console.SpeechEndpoint{BaseUrl: "http://tts.test:8000/api/v1"}, Voices: []*console.SpeechVoice{{LanguageCode: "en", Model: "tts", Voice: "default"}}},
	}
	credentials := Credentials{Transcription: &agw.LocalSecretKeyRef{Name: "speech-credentials", Key: ptr.To("transcription-api-key")}}
	objects, err := Compile(gateway, "speech", configuration, credentials)
	if err != nil {
		t.Fatal(err)
	}
	if len(objects) != 6 {
		t.Fatalf("resources = %d, want 6", len(objects))
	}
	backend := objects[0].(*agw.AgentgatewayBackend)
	if backend.Spec.Static.Host != "asr.test" || backend.Spec.Static.Port != 443 || ptr.Deref(backend.Spec.Policies.TLS.Sni, "") != "asr.test" || backend.Spec.Policies.Auth.SecretRef != credentials.Transcription || *backend.Spec.Policies.Auth.Location.Header.Prefix != "Token " {
		t.Fatalf("transcription backend = %+v", backend.Spec)
	}
	route := objects[1].(*gw.HTTPRoute)
	if *route.Spec.Rules[0].Filters[0].URLRewrite.Path.ReplacePrefixMatch != "/custom" {
		t.Fatalf("route rewrite = %+v", route.Spec)
	}
	policy := objects[2].(*agw.AgentgatewayPolicy).Spec.Traffic
	if policy.JWTAuthentication.Mode != agw.JWTAuthenticationModeStrict || policy.JWTAuthentication.PreserveToken || policy.JWTAuthentication.Providers[0].Audiences[0] != "agentos-voice" || policy.Authorization.Policy.MatchExpressions[0] != `jwt.sub == "system:serviceaccount:test:voice"` {
		t.Fatalf("worker policy = %+v", policy)
	}
	backend = objects[3].(*agw.AgentgatewayBackend)
	if backend.Spec.Policies.Auth != nil || backend.Spec.Policies.TLS != nil || backend.Spec.Static.Port != 8000 {
		t.Fatalf("public synthesis backend = %+v", backend.Spec)
	}
	configuration.Transcription.Protocol = console.SpeechTranscription_PROTOCOL_WHISPERLIVEKIT
	objects, err = Compile(gateway, "speech", configuration, credentials)
	if err != nil {
		t.Fatal(err)
	}
	if *objects[0].(*agw.AgentgatewayBackend).Spec.Policies.Auth.Location.Header.Prefix != "Bearer " {
		t.Fatal("WhisperLiveKit authentication scheme")
	}
	data, err := json.Marshal(objects)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), `"key":"Bearer`) {
		t.Fatal("inline credential in gateway objects")
	}
}

func TestInvalidEndpoint(t *testing.T) {
	for _, endpoint := range []string{"file:///etc/passwd", "https://user:password@asr.test", "https://asr.test?token=private", "https://asr.test#private", "https://asr.test:0", "https://asr.test:65536"} {
		t.Run(endpoint, func(t *testing.T) {
			configuration := &console.SpeechConfiguration{Transcription: &console.SpeechTranscription{Endpoint: &console.SpeechEndpoint{BaseUrl: endpoint}, Model: "asr"}}
			if _, err := Compile(Gateway{}, "speech", configuration, Credentials{}); err == nil {
				t.Fatal("accepted invalid endpoint")
			}
		})
	}
}
