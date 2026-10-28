package reconcile

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	"github.com/pood1e/agentos-platform/controller/internal/speech"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	metrics "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

func testSpeech(t *testing.T, c client.Client, scheme *runtime.Scheme, namespace string, config *rest.Config) {
	ctx := t.Context()
	settings := &core.Secret{ObjectMeta: metav1.ObjectMeta{Name: "speech", Namespace: namespace}, Data: map[string][]byte{
		"configuration.json": []byte(`{"transcription":{"endpoint":{"baseUrl":"https://asr.test/v1"},"model":"asr"},"synthesis":{"endpoint":{"baseUrl":"https://tts.test/v1"},"voices":[{"languageCode":"en","model":"tts","voice":"default"}]}}`),
		"credentials-secret": []byte("speech-credentials"),
	}}
	external := &core.Secret{ObjectMeta: metav1.ObjectMeta{Name: "speech-credentials", Namespace: namespace}, Data: map[string][]byte{"transcription-api-key": []byte("private-external")}}
	must(t, c.Create(ctx, settings))
	must(t, c.Create(ctx, external))
	keys := `{"keys":[{"kid":"first"}]}`
	r := &Speech{Client: c, Scheme: scheme, Settings: types.NamespacedName{Namespace: namespace, Name: settings.Name}, Gateway: speech.Gateway{Namespace: namespace, Name: "gateway", Subject: "system:serviceaccount:test:voice"}, Trust: func(context.Context) (string, string, error) { return "https://kubernetes.test", keys, nil }}
	reconcile := func() {
		t.Helper()
		result, err := r.Reconcile(ctx, ctrl.Request{})
		must(t, err)
		if result.RequeueAfter != time.Minute {
			t.Fatalf("key refresh interval = %v", result.RequeueAfter)
		}
	}
	if requests := r.credentialRequests(ctx, external); len(requests) != 1 || requests[0].NamespacedName != r.Settings {
		t.Fatalf("credential change requests = %+v", requests)
	}
	if requests := r.credentialRequests(ctx, settings); len(requests) != 0 {
		t.Fatal("settings event mapped twice")
	}
	if requests := r.credentialRequests(ctx, &core.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: "unrelated"}}); len(requests) != 0 {
		t.Fatal("unrelated secret triggers speech refresh")
	}
	reconcile()
	backend := &agw.AgentgatewayBackend{}
	key := client.ObjectKey{Namespace: namespace, Name: "speech-transcription"}
	must(t, c.Get(ctx, key, backend))
	if string(backend.Spec.Policies.Auth.SecretRef.Name) != external.Name || !metav1.IsControlledBy(backend, settings) {
		t.Fatalf("credential reference or ownership = %+v", backend)
	}
	settings.Data["transcription-api-key"] = []byte("private-override")
	must(t, c.Update(ctx, settings))
	reconcile()
	must(t, c.Get(ctx, key, backend))
	if string(backend.Spec.Policies.Auth.SecretRef.Name) != settings.Name || *backend.Spec.Policies.Auth.SecretRef.Key != "transcription-api-key" {
		t.Fatal("local credential override was not selected")
	}
	settings.Data["transcription-api-key"] = nil
	must(t, c.Update(ctx, settings))
	reconcile()
	must(t, c.Get(ctx, key, backend))
	if backend.Spec.Policies.Auth != nil {
		t.Fatal("cleared credential fell back to external secret")
	}
	keys = `{"keys":[{"kid":"first"},{"kid":"second"}]}`
	reconcile()
	policy := &agw.AgentgatewayPolicy{}
	must(t, c.Get(ctx, key, policy))
	if *policy.Spec.Traffic.JWTAuthentication.Providers[0].JWKS.Inline != keys {
		t.Fatal("published keys did not rotate")
	}
	settings.Data["configuration.json"] = []byte(strings.ReplaceAll(string(settings.Data["configuration.json"]), "https://asr.test/v1", "https://user:password@asr.test/v1"))
	must(t, c.Update(ctx, settings))
	if _, err := r.Reconcile(ctx, ctrl.Request{}); err == nil {
		t.Fatal("accepted credential-bearing endpoint")
	}
	if err := c.Get(ctx, key, backend); !apierrors.IsNotFound(err) {
		t.Fatalf("invalid settings retained active backend: %v", err)
	}
	r.Trust = func(context.Context) (string, string, error) { return "", "", errors.New("API unavailable") }
	settings.Data["configuration.json"] = []byte(`{}`)
	must(t, c.Update(ctx, settings))
	reconcile()
	inventory, err := ownedInventory(ctx, c, settings, speechKinds)
	must(t, err)
	if len(inventory) != 0 {
		t.Fatalf("disabled providers retain %d resources", len(inventory))
	}
	manager, err := ctrl.NewManager(config, ctrl.Options{Scheme: scheme, Cache: cache.Options{DefaultNamespaces: map[string]cache.Config{namespace: {}}}, Metrics: metrics.Options{BindAddress: "0"}, HealthProbeBindAddress: "0"})
	must(t, err)
	watcher := &Speech{Client: manager.GetClient(), Scheme: scheme, Settings: r.Settings, Gateway: r.Gateway, Trust: func(context.Context) (string, string, error) { return "https://kubernetes.test", keys, nil }}
	must(t, watcher.SetupWithManager(manager))
	runContext, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- manager.Start(runContext) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			must(t, err)
		case <-time.After(10 * time.Second):
			t.Error("speech manager did not stop")
		}
	})
	if !manager.GetCache().WaitForCacheSync(runContext) {
		t.Fatal("speech cache did not sync")
	}
	settings.Data["configuration.json"] = []byte(`{"transcription":{"endpoint":{"baseUrl":"https://asr.test/v1"},"model":"asr"}}`)
	delete(settings.Data, "transcription-api-key")
	must(t, c.Update(ctx, settings))
	waitCredential := func(enabled bool) {
		t.Helper()
		deadline := time.After(10 * time.Second)
		for {
			err := c.Get(ctx, key, backend)
			if err == nil && (backend.Spec.Policies.Auth != nil) == enabled {
				return
			}
			select {
			case <-deadline:
				t.Fatalf("speech credential watch did not converge: %v", err)
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	waitCredential(true)
	external.Data["transcription-api-key"] = nil
	must(t, c.Update(ctx, external))
	waitCredential(false)
	external.Data["transcription-api-key"] = []byte("rotated-provider")
	must(t, c.Update(ctx, external))
	waitCredential(true)

}
