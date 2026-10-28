package render

import (
	"strings"

	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	apps "k8s.io/api/apps/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// Gateway reads explicit controller endpoint arguments from a platform Chart render.
func Gateway(objects []*unstructured.Unstructured, release, namespace string) platform.PlatformGateway {
	base, suffix := "http://"+release, "."+namespace+".svc.cluster.local:8080"
	gateway := platform.PlatformGateway{Name: release + "-gateway", URL: base + "-gateway" + suffix, MCPURL: base + "-mcp-gateway" + suffix, ModelSecret: release + "-model-client", Dataplane: release + "-dataplane", ActorJWKSBackend: release + "-actor-jwks"}
	fields := map[string]*string{"gateway": &gateway.Name, "gateway-url": &gateway.URL, "mcp-url": &gateway.MCPURL, "model-secret": &gateway.ModelSecret, "dataplane": &gateway.Dataplane, "actor-jwks-backend": &gateway.ActorJWKSBackend, "actor-issuer": &gateway.ActorIssuer}
	for _, object := range objects {
		if object.GetKind() != "Deployment" || object.GetLabels()["app.kubernetes.io/name"] != "agentos-controller" {
			continue
		}
		var deployment apps.Deployment
		if runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &deployment) != nil {
			continue
		}
		for _, container := range deployment.Spec.Template.Spec.Containers {
			for _, arg := range container.Args {
				key, value, ok := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
				if field := fields[key]; ok && field != nil {
					*field = value
				}
			}
		}
	}
	return gateway
}
