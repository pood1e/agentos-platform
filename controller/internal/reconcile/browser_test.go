package reconcile

import (
	"bytes"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/pood1e/agentos-platform/controller/internal/render"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func testBrowserRoutes(t *testing.T, c client.Client, namespace string) {
	t.Helper()
	root := filepath.Join("..", "..", "..")
	command := exec.CommandContext(t.Context(), "helm", "template", "connections", "charts/agentos-connections", "-n", namespace, "-f", "charts/agentos-connections/tests/values.json")
	command.Dir = root
	data, err := command.Output()
	must(t, err)
	objects, err := render.Read(bytes.NewReader(data))
	must(t, err)
	counts := map[string]int{}
	for _, object := range objects {
		if object.GetLabels()["agentos.dev/browser-environment"] == "" {
			continue
		}
		object.SetNamespace(namespace)
		must(t, c.Create(t.Context(), object, &client.CreateOptions{FieldValidation: metav1.FieldValidationStrict}))
		counts[object.GetKind()]++
	}
	if counts["AgentgatewayBackend"] == 0 || counts["HTTPRoute"] == 0 || counts["AgentgatewayPolicy"] != counts["HTTPRoute"] {
		t.Fatalf("native browser resources missing: %v", counts)
	}
}
