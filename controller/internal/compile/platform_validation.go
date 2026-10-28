package compile

import (
	"fmt"
	"net/url"

	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
)

func validatePlatformEnvironment(gateway *platform.PlatformGateway, environment platform.Environment) error {
	if gateway == nil {
		return fmt.Errorf("platform gateway is required")
	}
	if gateway.Name == "" || gateway.ActorJWKSBackend == "" || gateway.NativeAuthorityBackend == "" || gateway.WriterRole == "" {
		return fmt.Errorf("platform gateway requires its name, authority backend, Actor JWKS backend and writer role")
	}
	for _, field := range []struct{ name, value string }{
		{"Actor issuer", gateway.ActorIssuer}, {"issuer", environment.Issuer},
		{"resource", environment.Resource}, {"JWKS URL", environment.JWKSURL},
	} {
		if !httpsURL(field.value) {
			return fmt.Errorf("%s must be an absolute HTTPS URL", field.name)
		}
	}
	if environment.Gateway.Address == "" || environment.Gateway.Host == "" || environment.Gateway.NodePort < 1 || environment.Gateway.NodePort > 65535 {
		return fmt.Errorf("environment gateway requires its address, TLS host and valid port")
	}
	discovery := environment.DiscoveryAuth
	if discovery == nil || discovery.OAuth2 == nil || discovery.ServiceAccount != nil {
		return fmt.Errorf("catalog discovery requires OAuth2 client credentials")
	}
	oauth := discovery.OAuth2
	if !httpsURL(oauth.TokenEndpoint) || oauth.ClientID == "" || oauth.ClientSecretRef.Name == "" || oauth.ClientSecretRef.Key == "" {
		return fmt.Errorf("catalog discovery requires an HTTPS token endpoint, client ID and Secret key reference")
	}
	if ca := oauth.CACertificateRef; ca != nil && (ca.Name == "" || ca.Key == "") {
		return fmt.Errorf("catalog discovery CA requires a ConfigMap key reference")
	}
	return nil
}

func httpsURL(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == ""
}
