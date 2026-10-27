// Package compile resolves AccessPlans into native resources and authorization decisions.
package compile

import (
	"fmt"
	"slices"
	"sort"

	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// Result contains the complete desired inventory and runtime decisions.
type Result struct {
	Resources []client.Object
	Targets   []platform.CompiledTarget
}

// Plan compiles a plan without accessing Kubernetes or mutating its input.
func Plan(plan *platform.AccessPlan) (Result, error) {
	var result Result
	if plan.Spec.Mode != "platform" && plan.Spec.Mode != "environment" {
		return result, fmt.Errorf("invalid mode %s", plan.Spec.Mode)
	}
	for _, server := range sortedKeys(plan.Spec.Servers) {
		tools, err := decisions(plan.Spec.Servers[server], "approval")
		if err != nil {
			return result, fmt.Errorf("server %s: %w", server, err)
		}
		result.Targets = append(result.Targets, platform.CompiledTarget{Server: server, Service: server, Tools: tools})
	}
	for _, environment := range plan.Spec.Environments {
		if plan.Spec.Mode == "environment" {
			identities := environment.Identities
			if identities == nil {
				identities = plan.Spec.Identities
			}
			if !slices.ContainsFunc(identities, func(identity platform.Identity) bool {
				return identity.Name == "catalog" && (identity.Environments == nil || slices.Contains(identity.Environments, environment.Name))
			}) {
				return result, fmt.Errorf("environment %s requires a catalog identity", environment.Name)
			}
		}
		if environment.Toolsets == nil {
			environment.Toolsets = plan.Spec.Toolsets
		}
		if environment.Identities == nil {
			environment.Identities = plan.Spec.Identities
		}
		for _, project := range sortedKeys(environment.Toolsets) {
			set := environment.Toolsets[project]
			tools, err := decisions(set, environment.Governance)
			if err != nil {
				return result, fmt.Errorf("%s/%s: %w", environment.Name, project, err)
			}
			service := environment.Name + "-" + project
			catalog := platform.CompiledTarget{Server: service, Service: service, Project: project, Environment: environment.Name, Catalog: true, Tools: tools}
			if plan.Spec.Mode == "platform" {
				result.Targets = append(result.Targets, catalog)
				if environment.Gateway != nil {
					if plan.Spec.Platform == nil {
						return result, fmt.Errorf("platform gateway is required")
					}
					result.Resources = append(result.Resources, platformView(plan, environment, catalog, names(set.ReadOnly), "/mcp/"+service)...)
					result.Resources = append(result.Resources, catalogPolicy(plan, catalog, names(set.ReadOnly)))
				}
			}
			for _, identity := range environment.Identities {
				if identity.Environments != nil && !slices.Contains(identity.Environments, environment.Name) {
					continue
				}
				access, ok := identity.Services[project]
				if !ok {
					continue
				}
				read, write := capabilities(set, access)
				if plan.Spec.Mode == "environment" {
					resources, err := environmentView(plan, environment, project, identity, access, append(slices.Clone(read), write...))
					if err != nil {
						return result, err
					}
					result.Resources = append(result.Resources, resources...)
					continue
				}
				if identity.Name == "catalog" {
					continue
				}
				for _, view := range []struct {
					access string
					names  []string
				}{{"readOnly", read}, {"write", write}} {
					if view.access == "write" && len(view.names) == 0 {
						continue
					}
					target := catalog
					target.Server, target.Engineer, target.Catalog, target.Access = service+"-"+identity.Name, identity.Name, false, view.access
					path := "/mcp/" + service + "/" + identity.Name + "/readonly"
					if view.access == "write" {
						target.Server += "-changes"
						path = "/mcp/" + service + "/" + identity.Name + "/changes"
					}
					if len(target.Server) > 63 {
						return result, fmt.Errorf("generated server name exceeds 63 characters: %s", target.Server)
					}
					target.Tools = slices.DeleteFunc(slices.Clone(tools), func(tool platform.CompiledTool) bool { return !slices.Contains(view.names, tool.Name) })
					result.Targets = append(result.Targets, target)
					if environment.Gateway != nil {
						result.Resources = append(result.Resources, platformView(plan, environment, target, names(view.names), path)...)
					}
				}
			}
		}
		for _, identity := range environment.Identities {
			for project := range identity.Services {
				if _, ok := environment.Toolsets[project]; !ok {
					return result, fmt.Errorf("identity %s references unknown service %s", identity.Name, project)
				}
			}
		}
	}
	sort.Slice(result.Targets, func(i, j int) bool { return result.Targets[i].Server < result.Targets[j].Server })
	seen := make(map[string]bool)
	for _, target := range result.Targets {
		if seen[target.Server] {
			return Result{}, fmt.Errorf("ambiguous server name %s", target.Server)
		}
		seen[target.Server] = true
	}
	return result, nil
}

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func names(values []string) []string { return append([]string{}, values...) }

func capabilities(set platform.Toolset, access platform.Access) ([]string, []string) {
	read := slices.Clone(set.ReadOnly)
	switch access {
	case "manage":
		return append(read, set.ManagementReadOnly...), slices.Clone(set.Management)
	case "operate":
		return read, slices.Clone(set.Write)
	default:
		return read, nil
	}
}

func decisions(set platform.Toolset, governance string) ([]platform.CompiledTool, error) {
	read := append(slices.Clone(set.ReadOnly), set.ManagementReadOnly...)
	write := append(slices.Clone(set.Write), set.Management...)
	approval := write
	if set.Approval != nil {
		approval = *set.Approval
	}
	for _, tool := range read {
		if slices.Contains(write, tool) {
			return nil, fmt.Errorf("tool %s has conflicting tiers", tool)
		}
	}
	for _, tool := range approval {
		if !slices.Contains(write, tool) {
			return nil, fmt.Errorf("approval tool %s is not writable", tool)
		}
	}
	tools := append(slices.Clone(read), write...)
	slices.Sort(tools)
	tools = slices.Compact(tools)
	result := make([]platform.CompiledTool, 0, len(tools))
	for _, tool := range tools {
		result = append(result, platform.CompiledTool{Name: tool, Write: slices.Contains(write, tool), RequireApproval: governance == "approval" && slices.Contains(approval, tool)})
	}
	return result, nil
}
