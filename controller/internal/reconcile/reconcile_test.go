package reconcile

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	"github.com/kagent-dev/kagent/go/integrations/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"github.com/pood1e/agentos-platform/controller/internal/compile"
	"github.com/pood1e/agentos-platform/controller/internal/connections"
	"github.com/pood1e/agentos-platform/controller/internal/speech"
	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func TestReconciliation(t *testing.T) {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("set KUBEBUILDER_ASSETS to run API server reconciliation tests")
	}
	root := filepath.Join("..", "..", "..")
	environment := &envtest.Environment{CRDDirectoryPaths: []string{
		filepath.Join(root, "controller/config/crd/bases"), filepath.Join(root, ".cache/chart-check/agentgateway-crds-v1.7.0.yaml"),
		filepath.Join(root, ".cache/chart-check/kagent-crds-a12c1a39b208fb16f2502703688799838bc05edf.yaml"), filepath.Join(root, ".cache/chart-check/gateway-crds-v1.6.1.yaml"),
	}, ErrorIfCRDPathMissing: true}
	config, err := environment.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := environment.Stop(); err != nil {
			t.Error(err)
		}
	})
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{core.AddToScheme, platform.AddToScheme, agw.AddToScheme, kagent.AddToScheme, gw.Install} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	c, err := client.New(config, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	ns := &core.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "reconcile-"}}
	must(t, c.Create(ctx, ns))
	t.Run("access plan recovers interrupted apply and removes orphan", func(t *testing.T) {
		p := &platform.AccessPlan{}
		must(t, json.Unmarshal([]byte(`{"metadata":{"name":"access"},"spec":{"mode":"environment","environments":[{"name":"lab","governance":"direct","issuer":"https://issuer.test"}],"toolsets":{"ops":{"readOnly":["get"],"write":["update"]}},"identities":[{"name":"reader","services":{"ops":"read"}},{"name":"catalog","services":{"ops":"read"}}],"connectors":{"ops":{"targets":[{"host":"tools.test","port":8080,"path":"/mcp"}]}}}}`), p))
		p.Namespace = ns.Name
		must(t, c.Create(ctx, p))
		compiled, err := compile.Plan(p)
		must(t, err)
		// Simulate process termination after the first apply, before any status write.
		_, err = apply(ctx, c, scheme, p, compiled.Resources[0], "agentos-access")
		must(t, err)
		p.Spec.Identities[0].Name = "other"
		must(t, c.Update(ctx, p))
		controller := &AccessPlan{Client: c, Scheme: scheme, Mode: "environment"}
		_, err = controller.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(p)})
		must(t, err)
		var backends agw.AgentgatewayBackendList
		must(t, c.List(ctx, &backends, client.InNamespace(ns.Name)))
		if len(backends.Items) != 2 || slices.ContainsFunc(backends.Items, func(backend agw.AgentgatewayBackend) bool { return backend.Name == "ops-reader" }) {
			t.Fatalf("orphan survived restart: %+v", backends.Items)
		}
		must(t, c.Get(ctx, client.ObjectKeyFromObject(p), p))
		if p.Status.ObservedGeneration != p.Generation || !meta.IsStatusConditionTrue(p.Status.Conditions, "Ready") {
			t.Fatalf("not ready: %+v", p.Status)
		}
		_, err = controller.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(p)})
		must(t, err)
	})
	t.Run("preset upgrades defaults and retains user objects", func(t *testing.T) {
		native := func(value string) runtime.RawExtension {
			data, err := json.Marshal(&core.ConfigMap{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "ConfigMap"}, ObjectMeta: metav1.ObjectMeta{Name: "defaults"}, Data: map[string]string{"value": value}})
			must(t, err)
			return runtime.RawExtension{Raw: data}
		}
		p := &platform.Preset{ObjectMeta: metav1.ObjectMeta{Name: "preset", Namespace: ns.Name}, Spec: platform.PresetSpec{Resources: []runtime.RawExtension{native("v1")}}}
		must(t, c.Create(ctx, p))
		controller := &Preset{Client: c, Scheme: scheme}
		reconcile := func() {
			t.Helper()
			_, err := controller.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(p)})
			must(t, err)
			must(t, c.Get(ctx, client.ObjectKeyFromObject(p), p))
		}
		reconcile()
		p.Spec.Resources = []runtime.RawExtension{native("v2")}
		must(t, c.Update(ctx, p))
		reconcile()
		cm := &core.ConfigMap{}
		must(t, c.Get(ctx, client.ObjectKey{Namespace: ns.Name, Name: "defaults"}, cm))
		if cm.Data["value"] != "v2" {
			t.Fatal("unmodified preset did not upgrade")
		}
		cm.Data["value"] = "user"
		must(t, c.Update(ctx, cm, client.FieldOwner("kubectl-edit")))
		p.Spec.Resources = []runtime.RawExtension{native("v3")}
		must(t, c.Update(ctx, p))
		reconcile()
		must(t, c.Get(ctx, client.ObjectKeyFromObject(cm), cm))
		if cm.Data["value"] != "user" || metav1.IsControlledBy(cm, p) || cm.Annotations[UserOwner] != "user" {
			t.Fatalf("user object overwritten or still owned: %+v", cm)
		}
		if !p.Status.Resources[0].UserOwned {
			t.Fatal("user ownership not recorded")
		}
	})
	t.Run("browser routes use native JWT, exchange and TLS contracts", func(t *testing.T) { testBrowserRoutes(t, c, ns.Name) })
	t.Run("speech publishes service account verification keys from the API", func(t *testing.T) {
		api, err := kubernetes.NewForConfig(config)
		must(t, err)
		issuer, jwks, err := speech.ServiceAccountTrust(t.Context(), api.Discovery().RESTClient())
		must(t, err)
		if issuer == "" || !json.Valid([]byte(jwks)) {
			t.Fatal("missing service account verification material")
		}
	})
	t.Run("speech uses native gateway authorization and credential references", func(t *testing.T) { testSpeech(t, c, scheme, ns.Name, config) })
	t.Run("native connections use deployed gateway CRDs", func(t *testing.T) {
		manager, err := ctrl.NewManager(config, ctrl.Options{
			Scheme: scheme, Cache: cache.Options{DefaultNamespaces: map[string]cache.Config{ns.Name: {}}},
			Metrics: metricsserver.Options{BindAddress: "0"}, HealthProbeBindAddress: "0",
		})
		must(t, err)
		gateway := connections.Config(platform.PlatformGateway{
			Name: "gateway", URL: "http://models.test:8080", MCPURL: "http://mcp.test:8080",
			ActorIssuer: "https://actors.test", ActorJWKSBackend: "actor-jwks-backend",
		})
		must(t, agentgateway.SetupWithManager(manager, gateway))
		managerContext, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		go func() { done <- manager.Start(managerContext) }()
		t.Cleanup(func() {
			cancel()
			select {
			case err := <-done:
				must(t, err)
			case <-time.After(10 * time.Second):
				t.Error("connection manager did not stop")
			}
		})
		if !manager.GetCache().WaitForCacheSync(managerContext) {
			t.Fatal("connection cache did not sync")
		}
		model := &agw.AgentgatewayModel{
			ObjectMeta: metav1.ObjectMeta{Name: "native-model", Namespace: ns.Name, Annotations: map[string]string{agentgateway.ConnectionAnnotation: "true"}},
			Spec:       agw.AgentgatewayModelSpec{Provider: new(agw.ModelProviderOpenAI), ParentRefs: []gw.ParentReference{gateway.Gateway}},
		}
		backend := &agw.AgentgatewayBackend{
			ObjectMeta: metav1.ObjectMeta{Name: "native-tools", Namespace: ns.Name, Annotations: map[string]string{agentgateway.ConnectionAnnotation: "true"}},
			Spec: agw.AgentgatewayBackendSpec{MCP: &agw.MCPBackend{Targets: []agw.McpTargetSelector{{
				Name: "tools", Static: &agw.McpTarget{Host: new("tools.test"), Port: 8080},
			}}}},
		}
		must(t, c.Create(ctx, model))
		must(t, c.Create(ctx, backend))
		deadline := time.After(15 * time.Second)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-deadline:
				t.Fatalf("native connections did not converge: model=%+v backend=%+v", model.Status, backend.Status)
			case <-ticker.C:
				must(t, c.Get(ctx, client.ObjectKeyFromObject(model), model))
				must(t, c.Get(ctx, client.ObjectKeyFromObject(backend), backend))
				ready := false
				for _, parent := range model.Status.Parents {
					ready = ready || parent.ControllerName == "kagent.dev/agentgateway-connections" && meta.IsStatusConditionTrue(parent.Conditions, agentgateway.ReadyCondition)
				}
				if ready && meta.IsStatusConditionTrue(backend.Status.Conditions, agentgateway.ReadyCondition) {
					must(t, c.Get(ctx, client.ObjectKey{Namespace: ns.Name, Name: "native-model"}, &kagent.ModelConfig{}))
					must(t, c.Get(ctx, client.ObjectKey{Namespace: ns.Name, Name: "native-tools"}, &kagent.RemoteMCPServer{}))
					must(t, c.Get(ctx, client.ObjectKey{Namespace: ns.Name, Name: "mcp-native-tools"}, &gw.HTTPRoute{}))
					must(t, c.Get(ctx, client.ObjectKey{Namespace: ns.Name, Name: "native-tools-runtime-auth"}, &agw.AgentgatewayPolicy{}))
					return
				}
			}
		}
	})
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
