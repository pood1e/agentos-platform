package compile

import (
	"encoding/json"
	"testing"

	"cel.dev/cel-go/cel"
	"cel.dev/cel-go/common/types"
	"cel.dev/cel-go/common/types/ref"
)

func TestAppsRejectUnknownMCPMethods(t *testing.T) {
	env, err := cel.NewEnv(cel.Variable("request", cel.DynType), cel.Variable("extauthz", cel.DynType), cel.Function("json", cel.Overload("json_string", []*cel.Type{cel.StringType}, cel.DynType, cel.UnaryBinding(func(v ref.Val) ref.Val {
		var data any
		if err := json.Unmarshal([]byte(v.Value().(string)), &data); err != nil {
			return types.NewErr("invalid JSON")
		}
		return types.DefaultTypeAdapter.NativeToValue(data)
	}))))
	if err != nil {
		t.Fatal(err)
	}
	ast, issues := env.Compile(string(appRequest("canonical")))
	if issues.Err() != nil {
		t.Fatal(issues.Err())
	}
	program, err := env.Program(ast)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, method, body string
		want               bool
	}{
		{"initialize", "POST", `{"method":"initialize"}`, true},
		{"initialized notification", "POST", `{"method":"notifications/initialized"}`, true},
		{"ping", "POST", `{"method":"ping"}`, true},
		{"selected read call", "POST", `{"method":"tools/call","params":{"name":"canonical_read"}}`, true},
		{"unselected tool", "POST", `{"method":"tools/call","params":{"name":"canonical_write"}}`, false},
		{"raw tool cannot bypass the binding", "POST", `{"method":"tools/call","params":{"name":"read"}}`, false},
		{"tools list", "POST", `{"method":"tools/list"}`, false},
		{"resource read", "POST", `{"method":"resources/read","params":{"uri":"ui://unrelated"}}`, false},
		{"unknown", "POST", `{"method":"extensions/write"}`, false},
		{"SSE connect", "GET", "", true},
		{"session close", "DELETE", "", true},
		{"other HTTP method", "PUT", `{"method":"tools/call","params":{"name":"canonical_read"}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, _, err := program.Eval(map[string]any{"request": map[string]any{"method": tc.method, "body": tc.body}, "extauthz": map[string]any{"selection": map[string]any{"server": "canonical", "tools": []string{"canonical_read"}}}})
			if err != nil || v.Value() != tc.want {
				t.Fatalf("got %v (%v), want %v", v, err, tc.want)
			}
		})
	}
}
