package main

import rego.v1

templates := [r | some r in objects; r.kind == "AgentTemplate"]

expected_template_names := names if {
	data.global.agentos
	names := array.concat(data.test.systemTemplates, data.test.solutionTemplates)
} else := data.test.systemTemplates

deny contains "rendered template names differ from the source presets" if {
	{r.metadata.name | some r in templates} != {name | some name in expected_template_names}
}

deny contains sprintf("%s has a redundant display-name annotation", [template.metadata.name]) if {
	some template in templates
	template.metadata.annotations["agentos.dev/display-name"]
}

deny contains "the assistant's collaboration tools differ from the native entry contract" if {
	some template in templates
	template.metadata.name == "assistant"
	bindings := [binding.mcp | some binding in template.spec.tools; binding.mcp.server.name == "team-sessions"]
	bindings != [{"server": {"kind": "RemoteMCPServer", "name": "team-sessions"}, "tools": ["list_agents", "create_session", "search_knowledge"], "requireApproval": false}]
}

actual_bindings(template) := [binding | some group in template.spec.tools; not group.mcp.server.name in {"team-sessions", "kagent-collaboration"}; some tool in group.mcp.tools; binding := {"server": group.mcp.server.name, "tool": tool, "review": group.mcp.requireApproval}]

scoped(identity, name) if {
	not identity.environments
	name
}

scoped(identity, name) if name in identity.environments

tier_suffix("write") := "-changes"
tier_suffix("readOnly") := ""

review_required(tier, environment, tools, tool) if {
	tier == "write"
	environment.governance == "approval"
	tool in object.get(tools, "approval", array.concat(object.get(tools, "write", []), object.get(tools, "management", [])))
} else := false

expected_bindings(template) := {binding |
	some identity in data.global.agentos.identities
	identity.name == template.metadata.name
	some environment in data.global.agentos.environments
	scoped(identity, environment.name)
	some project, access in identity.services
	tools := data.global.agentos.toolsets[project]
	some tier in ["readOnly", "write"]
	some tool in data.agentos.tools_for(tools, access, tier)
	suffix := tier_suffix(tier)
	server := sprintf("%s-%s-%s%s", [environment.name, project, identity.name, suffix])
	review := review_required(tier, environment, tools, tool)
	binding := {"server": server, "tool": sprintf("%s-%s_%s", [environment.name, project, tool]), "review": review}
}

deny contains sprintf("%s duplicates a tool binding", [template.metadata.name]) if {
	some template in templates
	actual := actual_bindings(template)
	count(actual) != count({binding | some binding in actual})
}

deny contains sprintf("%s environment tools or review policy differ from its declared scope", [template.metadata.name]) if {
	data.global.agentos
	some template in templates
	{binding | some binding in actual_bindings(template)} != expected_bindings(template)
}

deny contains "skill catalog does not use the managed Git gateway" if {
	data.global.agentos
	some catalog in objects
	catalog.kind == "ConfigMap"
	endswith(catalog.metadata.name, "-skills")
	some item in json.unmarshal(catalog.data["catalog.json"]).items
	expected := sprintf("http://agentos-skill-gateway.agentos.svc.cluster.local:8080%s", [data.global.agentos.skillRepository.path])
	item.skill.git.url != expected
}

deny contains "inspection skills differ from the managed catalog" if {
	data.global.agentos
	some catalog in objects
	catalog.kind == "ConfigMap"
	endswith(catalog.metadata.name, "-skills")
	some template in templates
	template.metadata.name == "inspection"
	items := json.unmarshal(catalog.data["catalog.json"]).items
	expected := [{"name": item.skill.name, "source": object.remove(item.skill, ["name"])} | some item in items]
	template.spec.skills != expected
}

deny contains "unconfigured platform exposes a skill repository route" if {
	not data.global.agentos
	some r in objects
	r.kind == "HTTPRoute"
	endswith(r.metadata.name, "-skill-repository")
}

deny contains "Git gateway exposes more than fetch and upload-pack" if {
	data.global.agentos
	some r in objects
	r.kind == "HTTPRoute"
	endswith(r.metadata.name, "-skill-repository")
	matches := r.spec.rules[0].matches
	[{"method": m.method, "path": array.reverse(split(m.path.value, "/"))[0]} | some m in matches] != [{"method": "GET", "path": "refs"}, {"method": "POST", "path": "git-upload-pack"}]
}

deny contains "Git discovery lacks the exact upload-pack query" if {
	data.global.agentos
	some r in objects
	r.kind == "HTTPRoute"
	endswith(r.metadata.name, "-skill-repository")
	r.spec.rules[0].matches[0].queryParams != [{"type": "Exact", "name": "service", "value": "git-upload-pack"}]
}

deny contains "managed skill catalog differs from the declared preset count" if {
	data.global.agentos
	some catalog in objects
	catalog.kind == "ConfigMap"
	endswith(catalog.metadata.name, "-skills")
	count(json.unmarshal(catalog.data["catalog.json"]).items) != count(data.global.agentos.skills)
}
