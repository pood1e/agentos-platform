package compile

import (
	"net/url"
	"strconv"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"k8s.io/utils/ptr"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func backendReference(name string) agw.PolicyBackendEndpoint {
	return agw.PolicyBackendEndpoint{BackendRef: &gw.BackendObjectReference{Group: ptr.To(gw.Group("agentgateway.dev")), Kind: ptr.To(gw.Kind("AgentgatewayBackend")), Name: gw.ObjectName(name)}}
}

func environmentTransport(environment platform.Environment, target platform.CompiledTarget) *agw.BackendSimple {
	transport := &agw.BackendSimple{
		HTTP: &agw.BackendHTTP{RequestTimeout: &agw.Duration{Duration: 10 * time.Minute}},
		TLS:  &agw.BackendTLS{Sni: ptr.To(environment.Gateway.Host), CACertificateRefs: []agw.LocalCACertificateRef{{Name: gw.ObjectName(environment.Name + "-gateway-ca"), Kind: "ConfigMap"}}, VerifySubjectAltNames: []string{environment.Gateway.Host}},
	}
	if !target.Catalog {
		endpoint, _ := url.Parse(environment.DiscoveryAuth.OAuth2.TokenEndpoint)
		transport.Auth = &agw.BackendAuth{OAuthTokenExchange: &agw.OAuthTokenExchange{
			PolicyBackendEndpoint: backendReference(target.Service + "-oauth"), Path: ptr.To(endpoint.RequestURI()),
			Audiences: []string{environment.Resource}, RequestedTokenType: ptr.To(agw.OAuthTokenTypeAccessToken),
			ClientAuth: &agw.OAuthClientAuth{ClientID: "agentos-" + target.Engineer, SecretRef: &agw.LocalSecretKeyRef{Name: gw.ObjectName(environment.Name + "-" + target.Engineer), Key: ptr.To("client-secret")}},
		}}
	}
	return transport
}

func identityBackend(namespace, name, endpoint string, environment platform.Environment) (*agw.AgentgatewayBackend, string) {
	target, _ := url.Parse(endpoint) // Plan validates the HTTPS endpoints before compilation.
	port := int32(443)
	if value, err := strconv.ParseInt(target.Port(), 10, 32); err == nil {
		port = int32(value)
	}
	tls := &agw.BackendTLS{Sni: ptr.To(target.Hostname()), VerifySubjectAltNames: []string{target.Hostname()}}
	if ca := environment.DiscoveryAuth.OAuth2.CACertificateRef; ca != nil {
		tls.CACertificateRefs = []agw.LocalCACertificateRef{{Name: gw.ObjectName(ca.Name), Key: ca.Key, Kind: "ConfigMap"}}
	}
	backend := &agw.AgentgatewayBackend{ObjectMeta: metadata(namespace, name), Spec: agw.AgentgatewayBackendSpec{Static: &agw.StaticBackend{Host: target.Hostname(), Port: port}, Policies: &agw.BackendFull{BackendSimple: agw.BackendSimple{TLS: tls}}}}
	return backend, target.RequestURI()
}
