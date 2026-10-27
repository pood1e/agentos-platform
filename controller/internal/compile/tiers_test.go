package compile

import (
	"encoding/json"
	"reflect"
	"slices"
	"testing"

	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
)

func planFor(t *testing.T, governance string) *platform.AccessPlan {
	t.Helper()
	var plan platform.AccessPlan
	data := `{"metadata":{"name":"test","namespace":"agentos"},"spec":{"mode":"platform","environments":[{"name":"lab","governance":"` + governance + `"}],"toolsets":{"ops":{"readOnly":["get"],"write":["update"],"managementReadOnly":["nodes"],"management":["drain"]}},"identities":[{"name":"reader","services":{"ops":"read"}},{"name":"operator","services":{"ops":"operate"}},{"name":"manager","services":{"ops":"manage"}}]}}`
	if err := json.Unmarshal([]byte(data), &plan); err != nil {
		t.Fatal(err)
	}
	return &plan
}

func TestCapabilityBoundaries(t *testing.T) {
	plan := planFor(t, "approval")
	before := plan.DeepCopy()
	result, err := Plan(plan)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan, before) {
		t.Fatal("compiler mutated its input")
	}
	expected := map[string][]platform.CompiledTool{
		"lab-ops-reader":           {{Name: "get"}},
		"lab-ops-operator-changes": {{Name: "update", Write: true, RequireApproval: true}},
		"lab-ops-manager":          {{Name: "get"}, {Name: "nodes"}},
		"lab-ops-manager-changes":  {{Name: "drain", Write: true, RequireApproval: true}},
	}
	for server, tools := range expected {
		index := slices.IndexFunc(result.Targets, func(target platform.CompiledTarget) bool { return target.Server == server })
		if index < 0 || !reflect.DeepEqual(result.Targets[index].Tools, tools) {
			t.Errorf("%s: got %+v, want %+v", server, result.Targets, tools)
		}
	}
	for _, target := range result.Targets {
		if target.Server == "lab-ops-reader-changes" {
			t.Fatal("read identity gained a write view")
		}
		for _, tool := range target.Tools {
			if tool.Name == "unknown" {
				t.Fatal("unknown tool admitted")
			}
		}
	}
}

func TestExplicitEmptyApprovalSurvivesRoundTrip(t *testing.T) {
	plan := planFor(t, "approval")
	set := plan.Spec.Toolsets["ops"]
	empty := []string{}
	set.Approval = &empty
	plan.Spec.Toolsets["ops"] = set
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &plan); err != nil {
		t.Fatal(err)
	}
	result, err := Plan(plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range result.Targets {
		for _, tool := range target.Tools {
			if tool.RequireApproval {
				t.Fatal("explicit empty approval list defaulted to approval")
			}
		}
	}
}

func TestInvalidPlansFailClosed(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		mutate func(*platform.AccessPlan)
	}{
		{"conflicting tiers", func(p *platform.AccessPlan) {
			set := p.Spec.Toolsets["ops"]
			set.Write = []string{"get"}
			p.Spec.Toolsets["ops"] = set
		}},
		{"approval is not a write", func(p *platform.AccessPlan) {
			set := p.Spec.Toolsets["ops"]
			values := []string{"get"}
			set.Approval = &values
			p.Spec.Toolsets["ops"] = set
		}},
		{"unknown service", func(p *platform.AccessPlan) { p.Spec.Identities[0].Services["missing"] = "manage" }},
		{"ambiguous name", func(p *platform.AccessPlan) {
			p.Spec.Servers = map[string]platform.Toolset{"lab-ops-reader": {ReadOnly: []string{"get"}}}
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			p := planFor(t, "approval")
			scenario.mutate(p)
			if _, err := Plan(p); err == nil {
				t.Fatal("invalid plan compiled")
			}
		})
	}
}

func TestDirectGovernanceDoesNotRequireApproval(t *testing.T) {
	result, err := Plan(planFor(t, "direct"))
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range result.Targets {
		for _, tool := range target.Tools {
			if tool.RequireApproval {
				t.Fatal("direct governance requires approval")
			}
		}
	}
}
