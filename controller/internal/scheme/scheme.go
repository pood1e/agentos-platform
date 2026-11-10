// Package scheme registers every API group the controller and offline renderer handle.
package scheme

import (
	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

// New returns a scheme with the core, platform, agentgateway, kagent and Gateway API types.
func New() (*runtime.Scheme, error) {
	result := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{clientgoscheme.AddToScheme, platform.AddToScheme, agw.AddToScheme, kagent.AddToScheme, gw.Install} {
		if err := add(result); err != nil {
			return nil, err
		}
	}
	return result, nil
}
