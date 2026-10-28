package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	"github.com/kagent-dev/kagent/go/integrations/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"github.com/pood1e/agentos-platform/controller/internal/connections"
	"github.com/pood1e/agentos-platform/controller/internal/reconcile"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metrics "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func run() error {
	var mode, namespace string
	var gateway platform.PlatformGateway
	flag.StringVar(&mode, "mode", "platform", "Controller mode: platform or environment")
	flag.StringVar(&namespace, "namespace", "", "Namespace to watch")
	flag.StringVar(&gateway.Name, "gateway", "agentos-gateway", "Platform Gateway name")
	flag.StringVar(&gateway.URL, "gateway-url", "http://agentos-gateway:8080", "Platform model gateway URL")
	flag.StringVar(&gateway.MCPURL, "mcp-url", "http://agentos-mcp-gateway:8080", "Platform MCP gateway URL")
	flag.StringVar(&gateway.ModelSecret, "model-secret", "agentos-model-client", "Model client placeholder Secret")
	flag.StringVar(&gateway.Dataplane, "dataplane", "agentos-dataplane", "Authorization service name")
	flag.StringVar(&gateway.ActorKeys, "actor-keys", "agentos-dataplane", "Actor JWKS service name")
	flag.StringVar(&gateway.ActorIssuer, "actor-issuer", "", "Actor token issuer")
	options := zap.Options{}
	options.BindFlags(flag.CommandLine)
	flag.Parse()
	if namespace == "" || (mode != "platform" && mode != "environment") {
		return fmt.Errorf("namespace and a valid mode are required")
	}
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&options)))
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{clientgoscheme.AddToScheme, platform.AddToScheme, agw.AddToScheme, kagent.AddToScheme, gw.Install} {
		if err := add(scheme); err != nil {
			return err
		}
	}
	manager, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{Scheme: scheme, Cache: cache.Options{DefaultNamespaces: map[string]cache.Config{namespace: {}}}, LeaderElection: true, LeaderElectionNamespace: namespace, LeaderElectionID: "agentos-" + mode + ".agentos.dev", HealthProbeBindAddress: ":8081", Metrics: metrics.Options{BindAddress: "0"}})
	if err != nil {
		return err
	}
	if err := (&reconcile.AccessPlan{Client: manager.GetClient(), Scheme: scheme, Mode: mode}).SetupWithManager(manager); err != nil {
		return err
	}
	if mode == "platform" {
		if err := (&reconcile.Preset{Client: manager.GetClient(), Scheme: scheme}).SetupWithManager(manager); err != nil {
			return err
		}
		if err := agentgateway.SetupWithManager(manager, connections.Config(gateway)); err != nil {
			return err
		}
	}
	if err := manager.AddHealthzCheck("health", healthz.Ping); err != nil {
		return err
	}
	if err := manager.AddReadyzCheck("cache", func(request *http.Request) error {
		ctx, cancel := context.WithTimeout(request.Context(), time.Second)
		defer cancel()
		if !manager.GetCache().WaitForCacheSync(ctx) {
			return fmt.Errorf("configuration cache is not synchronized")
		}
		return nil
	}); err != nil {
		return err
	}
	return manager.Start(ctrl.SetupSignalHandler())
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
