package compile

import (
	"encoding/json"
	"strings"
	"testing"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
)

func TestEnvironmentCredentialAndIdentityBoundaries(t *testing.T) {
	var plan platform.AccessPlan
	source := `{"metadata":{"namespace":"mcp"},"spec":{"mode":"environment","environments":[{"name":"lab","governance":"direct","issuer":"https://issuer.test"}],"toolsets":{"ops":{"readOnly":["get"],"write":["update"],"managementReadOnly":["nodes"],"management":["drain"]}},"identities":[{"name":"catalog","services":{"ops":"read"}},{"name":"manager","services":{"ops":"manage"}}],"connectors":{"ops":{"targets":[{"host":"tools.test","port":443,"auth":{"oauthTokenExchange":{"url":"<issuer>/token","grantType":"TokenExchange","clientAuth":{"clientId":"agentos-<identity>","method":"ClientSecretBasic","secretRef":{"name":"<environment>-<identity>"}}}}}]}}}}`
	if err := json.Unmarshal([]byte(source), &plan); err != nil {
		t.Fatal(err)
	}
	result, err := Plan(&plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, object := range result.Resources {
		data, err := json.Marshal(object)
		if err != nil {
			t.Fatal(err)
		}
		value := string(data)
		if strings.Contains(value, `\u003cidentity`) || strings.Contains(value, `\u003cissuer`) || strings.Contains(value, `\u003cenvironment`) {
			t.Fatal("unresolved native credential placeholder")
		}
		if object.GetName() == "ops-manager" && strings.Contains(value, "update") {
			t.Fatal("management identity gained operational write permission")
		}
		if _, backend := object.(*agw.AgentgatewayBackend); backend && object.GetName() == "ops-manager" && strings.Contains(value, "ui://") {
			t.Fatal("identity gained UI resource access")
		}
	}
	connector := plan.Spec.Connectors["ops"]
	target := connector.Targets[0]
	target.Auth = nil
	connector.Targets = append(connector.Targets, target)
	plan.Spec.Connectors["ops"] = connector
	if _, err := Plan(&plan); err == nil {
		t.Fatal("mixed credential boundaries compiled")
	}
}
