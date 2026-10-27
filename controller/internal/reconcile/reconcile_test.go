package reconcile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"github.com/pood1e/agentos-platform/controller/internal/compile"
	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func TestReconciliation(t *testing.T) {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("set KUBEBUILDER_ASSETS to run API server reconciliation tests")
	}
	root := filepath.Join("..", "..", "..")
	environment := &envtest.Environment{CRDDirectoryPaths: []string{
		filepath.Join(root, "charts/agentos/crds"), filepath.Join(root, ".cache/chart-check/agentgateway-crds-v1.6.0.yaml"),
		filepath.Join(root, ".cache/chart-check/kagent-crds-1.0.0-alpha17.yaml"), filepath.Join(root, ".cache/chart-check/gateway-crds-v1.6.1.yaml"),
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
	t.Run("model parent converges idempotently", func(t *testing.T) {
		model := "gpt-test"
		p := &agw.AgentgatewayModel{ObjectMeta: metav1.ObjectMeta{Name: "model", Namespace: ns.Name, Annotations: map[string]string{"agentos.dev/connection": "true"}}, Spec: agw.AgentgatewayModelSpec{Provider: ptr.To(agw.ModelProviderOpenAI), ParentRefs: []gw.ParentReference{{Name: "gateway"}}, Match: &agw.ModelMatch{Model: &model}}}
		must(t, c.Create(ctx, p))
		p.Spec.Policies = &agw.ModelPolicies{Auth: &agw.ModelBackendAuth{SecretRef: &agw.LocalSecretKeyRef{Name: "model-credential"}}}
		must(t, c.Update(ctx, p))
		controller := &Connection{Client: c, Scheme: scheme, Model: true, Gateway: platform.PlatformGateway{URL: "http://gateway:8080", ModelSecret: "model-client"}}
		if _, err := controller.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(p)}); err == nil {
			t.Fatal("connection became ready before its credential existed")
		}
		credential := &core.Secret{ObjectMeta: metav1.ObjectMeta{Name: "model-credential", Namespace: ns.Name}, Data: map[string][]byte{"Authorization": []byte("secret")}}
		must(t, c.Create(ctx, credential))
		for range 2 {
			_, err := controller.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(p)})
			must(t, err)
		}
		child := &kagent.ModelConfig{}
		must(t, c.Get(ctx, client.ObjectKeyFromObject(p), child))
		if child.Spec.Model != model || !metav1.IsControlledBy(child, p) {
			t.Fatal("model consumer did not converge")
		}
	})
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
