// Package speech compiles speech settings into native gateway resources.
package speech

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"buf.build/go/protovalidate"
	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	console "github.com/pood1e/agentos-platform/controller/internal/proto/agentos/console/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

// Gateway contains trusted deployment identity and the cluster's published verification keys.
type Gateway struct {
	Namespace, Name, Subject, Issuer, JWKS string
}

type Credentials struct {
	Transcription, Synthesis *agw.LocalSecretKeyRef
}

// Compile emits references to provider credentials; secret values remain in Kubernetes Secrets.
func Compile(gateway Gateway, name string, configuration *console.SpeechConfiguration, credentials Credentials) ([]client.Object, error) {
	if err := protovalidate.Validate(configuration); err != nil {
		return nil, fmt.Errorf("invalid speech configuration: %w", err)
	}
	var objects []client.Object
	if provider := configuration.GetTranscription(); provider != nil {
		prefix := "Bearer "
		if provider.GetProtocol() != console.SpeechTranscription_PROTOCOL_WHISPERLIVEKIT {
			prefix = "Token "
		}
		result, err := compileProvider(gateway, name+"-transcription", "/speech/transcription", strings.TrimSuffix(provider.GetEndpoint().GetBaseUrl(), "/v1"), credentials.Transcription, prefix)
		if err != nil {
			return nil, err
		}
		objects = append(objects, result...)
	}
	if provider := configuration.GetSynthesis(); provider != nil {
		result, err := compileProvider(gateway, name+"-synthesis", "/speech/synthesis", provider.GetEndpoint().GetBaseUrl(), credentials.Synthesis, "Bearer ")
		if err != nil {
			return nil, err
		}
		objects = append(objects, result...)
	}
	return objects, nil
}

func compileProvider(gateway Gateway, name, path, endpoint string, credential *agw.LocalSecretKeyRef, prefix string) ([]client.Object, error) {
	upstream, err := url.Parse(endpoint)
	if err != nil || upstream.Hostname() == "" || (upstream.Scheme != "http" && upstream.Scheme != "https") || upstream.User != nil || upstream.RawQuery != "" || upstream.Fragment != "" {
		return nil, fmt.Errorf("invalid speech endpoint")
	}
	port := 80
	if upstream.Scheme == "https" {
		port = 443
	}
	if upstream.Port() != "" {
		port, err = strconv.Atoi(upstream.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, fmt.Errorf("invalid speech endpoint port")
		}
	}
	metadata := metav1.ObjectMeta{Namespace: gateway.Namespace, Name: name}
	backend := &agw.AgentgatewayBackend{ObjectMeta: metadata, Spec: agw.AgentgatewayBackendSpec{
		Static:   &agw.StaticBackend{Host: upstream.Hostname(), Port: int32(port)},
		Policies: &agw.BackendFull{},
	}}
	if upstream.Scheme == "https" {
		backend.Spec.Policies.TLS = &agw.BackendTLS{Sni: ptr.To(upstream.Hostname())}
	}
	if credential != nil {
		backend.Spec.Policies.Auth = &agw.BackendAuth{SecretRef: credential, Location: &agw.AuthorizationLocation{
			AuthorizationLocationFields: agw.AuthorizationLocationFields{Header: &agw.AuthorizationHeaderLocation{Name: "Authorization", Prefix: &prefix}},
		}}
	}
	replacement := upstream.EscapedPath()
	if replacement == "" {
		replacement = "/"
	}
	route := &gw.HTTPRoute{ObjectMeta: metadata, Spec: gw.HTTPRouteSpec{
		CommonRouteSpec: gw.CommonRouteSpec{ParentRefs: []gw.ParentReference{{Name: gw.ObjectName(gateway.Name), SectionName: ptr.To(gw.SectionName("http"))}}},
		Rules: []gw.HTTPRouteRule{{
			Matches:     []gw.HTTPRouteMatch{{Path: &gw.HTTPPathMatch{Type: ptr.To(gw.PathMatchPathPrefix), Value: &path}}},
			Filters:     []gw.HTTPRouteFilter{{Type: gw.HTTPRouteFilterURLRewrite, URLRewrite: &gw.HTTPURLRewriteFilter{Path: &gw.HTTPPathModifier{Type: gw.PrefixMatchHTTPPathModifier, ReplacePrefixMatch: &replacement}}}},
			BackendRefs: []gw.HTTPBackendRef{{BackendRef: gw.BackendRef{BackendObjectReference: gw.BackendObjectReference{Group: ptr.To(gw.Group(agw.GroupVersion.Group)), Kind: ptr.To(gw.Kind("AgentgatewayBackend")), Name: gw.ObjectName(name)}}}},
		}},
	}}
	policy := &agw.AgentgatewayPolicy{ObjectMeta: metadata, Spec: agw.AgentgatewayPolicySpec{
		TargetRefs: []agw.LocalPolicyTargetReferenceWithSectionName{{Group: "gateway.networking.k8s.io", Kind: "HTTPRoute", Name: gw.ObjectName(name)}},
		Traffic: &agw.Traffic{
			JWTAuthentication: &agw.JWTAuthentication{Mode: agw.JWTAuthenticationModeStrict, Providers: []agw.JWTProvider{{Issuer: gateway.Issuer, Audiences: []string{"agentos-voice"}, JWKS: agw.JWKS{Inline: &gateway.JWKS}, Validation: &agw.JWTValidationOptions{RequiredClaims: ptr.To([]agw.JWTClaim{"sub", "exp", "aud"})}}}},
			Authorization:     &agw.Authorization{Action: agw.AuthorizationPolicyActionRequire, Policy: agw.AuthorizationPolicy{MatchExpressions: []agw.CELExpression{agw.CELExpression("jwt.sub == " + strconv.Quote(gateway.Subject))}}},
		},
	}}
	return []client.Object{backend, route, policy}, nil
}
