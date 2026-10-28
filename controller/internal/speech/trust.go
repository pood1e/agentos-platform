package speech

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	"k8s.io/client-go/rest"
)

// ServiceAccountTrust reads public verification material through the authenticated Kubernetes API.
func ServiceAccountTrust(ctx context.Context, api rest.Interface) (string, string, error) {
	data, err := api.Get().AbsPath("/.well-known/openid-configuration").DoRaw(ctx)
	if err != nil {
		return "", "", fmt.Errorf("read service account issuer: %w", err)
	}
	var discovery struct {
		Issuer string `json:"issuer"`
	}
	if err := json.Unmarshal(data, &discovery); err != nil {
		return "", "", fmt.Errorf("decode service account issuer: %w", err)
	}
	issuer, err := url.Parse(discovery.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" {
		return "", "", fmt.Errorf("service account issuer requires HTTPS")
	}
	keys, err := api.Get().AbsPath("/openid/v1/jwks").DoRaw(ctx)
	if err != nil {
		return "", "", fmt.Errorf("read service account verification keys: %w", err)
	}
	var published struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(keys, &published); err != nil || len(published.Keys) == 0 {
		return "", "", fmt.Errorf("service account verification keys are unavailable")
	}
	return discovery.Issuer, string(keys), nil
}
