package reconcile

import (
	"context"
	"fmt"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	console "github.com/pood1e/agentos-platform/controller/internal/proto/agentos/console/v1"
	"github.com/pood1e/agentos-platform/controller/internal/speech"
	"google.golang.org/protobuf/encoding/protojson"
	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

// Speech maintains native routes and authorization from the versioned speech settings Secret.
type Speech struct {
	client.Client
	Scheme   *runtime.Scheme
	Settings types.NamespacedName
	Gateway  speech.Gateway
	Trust    func(context.Context) (string, string, error)
}

func (r *Speech) Reconcile(ctx context.Context, _ ctrl.Request) (ctrl.Result, error) {
	var settings core.Secret
	if err := r.Get(ctx, r.Settings, &settings); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !settings.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}
	previous, err := ownedInventory(ctx, r.Client, &settings, speechKinds)
	if err != nil {
		return ctrl.Result{}, err
	}
	configuration := &console.SpeechConfiguration{}
	data := settings.Data["configuration.json"]
	if len(data) == 0 {
		data = []byte("{}")
	}
	if err := protojson.Unmarshal(data, configuration); err != nil {
		if pruneErr := prune(ctx, r.Client, &settings, previous, nil); pruneErr != nil {
			return ctrl.Result{}, pruneErr
		}
		return ctrl.Result{}, fmt.Errorf("decode speech configuration: %w", err)
	}
	if configuration.Transcription == nil && configuration.Synthesis == nil {
		err := prune(ctx, r.Client, &settings, previous, nil)
		return ctrl.Result{RequeueAfter: time.Minute}, err
	}
	var external core.Secret
	_, localTranscription := settings.Data["transcription-api-key"]
	_, localSynthesis := settings.Data["synthesis-api-key"]
	needsExternal := (configuration.Transcription != nil && !localTranscription) || (configuration.Synthesis != nil && !localSynthesis)
	if name := string(settings.Data["credentials-secret"]); name != "" && needsExternal {
		if err := r.Get(ctx, types.NamespacedName{Namespace: settings.Namespace, Name: name}, &external); err != nil {
			if pruneErr := prune(ctx, r.Client, &settings, previous, nil); pruneErr != nil {
				return ctrl.Result{}, pruneErr
			}
			return ctrl.Result{}, err
		}
	}
	credential := func(kind string) *agw.LocalSecretKeyRef {
		key := kind + "-api-key"
		source := &settings
		if _, overridden := settings.Data[key]; !overridden {
			source = &external
		}
		if len(source.Data[key]) == 0 {
			return nil
		}
		return &agw.LocalSecretKeyRef{Name: gw.ObjectName(source.Name), Key: ptr.To(key)}
	}
	gateway := r.Gateway
	trustContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	gateway.Issuer, gateway.JWKS, err = r.Trust(trustContext)
	if err != nil {
		return ctrl.Result{}, err
	}
	objects, err := speech.Compile(gateway, settings.Name, configuration, speech.Credentials{Transcription: credential("transcription"), Synthesis: credential("synthesis")})
	if err != nil {
		if pruneErr := prune(ctx, r.Client, &settings, previous, nil); pruneErr != nil {
			return ctrl.Result{}, pruneErr
		}
		return ctrl.Result{}, err
	}
	var desired []platform.ResourceReference
	for _, object := range objects {
		reference, err := apply(ctx, r.Client, r.Scheme, &settings, object, "agentos-speech")
		if err != nil {
			return ctrl.Result{}, err
		}
		desired = append(desired, reference)
	}
	if err := prune(ctx, r.Client, &settings, previous, desired); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: time.Minute}, nil
}

func (r *Speech) credentialRequests(ctx context.Context, object client.Object) []reconcile.Request {
	if client.ObjectKeyFromObject(object) == r.Settings || object.GetNamespace() != r.Settings.Namespace {
		return nil
	}
	var settings core.Secret
	if err := r.Get(ctx, r.Settings, &settings); err != nil || string(settings.Data["credentials-secret"]) != object.GetName() {
		return nil
	}
	return []reconcile.Request{{NamespacedName: r.Settings}}
}

func (r *Speech) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).Named("speech").
		For(&core.Secret{}, builder.WithPredicates(predicate.NewPredicateFuncs(func(object client.Object) bool {
			return client.ObjectKeyFromObject(object) == r.Settings
		}))).
		Watches(&core.Secret{}, handler.EnqueueRequestsFromMapFunc(r.credentialRequests)).
		Owns(&agw.AgentgatewayBackend{}).Owns(&agw.AgentgatewayPolicy{}).Owns(&gw.HTTPRoute{}).Complete(r)
}

var speechKinds = []schema.GroupVersionKind{
	agw.SchemeGroupVersion.WithKind("AgentgatewayBackend"), agw.SchemeGroupVersion.WithKind("AgentgatewayPolicy"), gw.SchemeGroupVersion.WithKind("HTTPRoute"),
}
