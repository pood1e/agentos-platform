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

// planCompiler accumulates one plan's output; platform mode builds gateway views, environment mode local tools.
type planCompiler struct {
	plan     *platform.AccessPlan
	platform bool
	result   Result
}

// Plan compiles a plan without accessing Kubernetes or mutating its input.
func Plan(plan *platform.AccessPlan) (Result, error) {
	if plan.Spec.Mode != "platform" && plan.Spec.Mode != "environment" {
		return Result{}, fmt.Errorf("invalid mode %s", plan.Spec.Mode)
	}
	compiler := planCompiler{plan: plan, platform: plan.Spec.Mode == "platform"}
	if err := compiler.servers(); err != nil {
		return Result{}, err
	}
	for _, environment := range plan.Spec.Environments {
		if err := compiler.environment(environment); err != nil {
			return Result{}, err
		}
	}
	result := compiler.result
	sort.Slice(result.Targets, func(i, j int) bool { return result.Targets[i].Server < result.Targets[j].Server })
	seen := make(map[string]bool)
	for _, target := range result.Targets {
		if seen[target.Server] {
			return Result{}, fmt.Errorf("ambiguous server name %s", target.Server)
		}
		seen[target.Server] = true
	}
	if compiler.platform {
		resources, err := appViews(plan, result.Targets)
		if err != nil {
			return Result{}, err
		}
		result.Resources = append(result.Resources, resources...)
	}
	return result, nil
}

func (c *planCompiler) servers() error {
	for _, server := range sortedKeys(c.plan.Spec.Servers) {
		tools, err := decisions(c.plan.Spec.Servers[server], "approval")
		if err != nil {
			return fmt.Errorf("server %s: %w", server, err)
		}
		c.result.Targets = append(c.result.Targets, platform.CompiledTarget{Server: server, Service: server, Tools: tools})
		if c.platform {
			policy, err := serverPolicy(c.plan, server, tools)
			if err != nil {
				return err
			}
			c.result.Resources = append(c.result.Resources, policy)
		}
	}
	return nil
}

func (c *planCompiler) environment(environment platform.Environment) error {
	if err := c.validateEnvironment(environment); err != nil {
		return err
	}
	if environment.Toolsets == nil {
		environment.Toolsets = c.plan.Spec.Toolsets
	}
	if environment.Identities == nil {
		environment.Identities = c.plan.Spec.Identities
	}
	for _, project := range sortedKeys(environment.Toolsets) {
		if err := c.project(environment, project); err != nil {
			return err
		}
	}
	for _, identity := range environment.Identities {
		for project := range identity.Services {
			if _, ok := environment.Toolsets[project]; !ok {
				return fmt.Errorf("identity %s references unknown service %s", identity.Name, project)
			}
		}
	}
	return nil
}

func (c *planCompiler) validateEnvironment(environment platform.Environment) error {
	if c.platform {
		if environment.Gateway == nil {
			return nil
		}
		if err := validatePlatformEnvironment(c.plan.Spec.Platform, environment); err != nil {
			return fmt.Errorf("environment %s: %w", environment.Name, err)
		}
		return nil
	}
	identities := environment.Identities
	if identities == nil {
		identities = c.plan.Spec.Identities
	}
	if !slices.ContainsFunc(identities, func(identity platform.Identity) bool {
		return identity.Name == "catalog" && (identity.Environments == nil || slices.Contains(identity.Environments, environment.Name))
	}) {
		return fmt.Errorf("environment %s requires a catalog identity", environment.Name)
	}
	return nil
}

func (c *planCompiler) project(environment platform.Environment, project string) error {
	set := environment.Toolsets[project]
	tools, err := decisions(set, environment.Governance)
	if err != nil {
		return fmt.Errorf("%s/%s: %w", environment.Name, project, err)
	}
	service := environment.Name + "-" + project
	catalog := platform.CompiledTarget{Server: service, Service: service, Project: project, Environment: environment.Name, Catalog: true, Tools: tools}
	c.result.Targets = append(c.result.Targets, catalog)
	if c.platform && environment.Gateway != nil {
		c.result.Resources = append(c.result.Resources, platformView(c.plan, environment, catalog, names(set.ReadOnly), "/mcp/"+service)...)
		c.result.Resources = append(c.result.Resources, catalogPolicy(c.plan, catalog, names(set.ReadOnly)))
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
		if c.platform {
			err = c.platformIdentity(environment, catalog, identity, read, write)
		} else {
			err = c.environmentIdentity(environment, catalog, identity, access, read, write)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// environmentIdentity builds the environment's own gateway view for one identity.
func (c *planCompiler) environmentIdentity(environment platform.Environment, catalog platform.CompiledTarget, identity platform.Identity, access platform.Access, read, write []string) error {
	allowed := append(slices.Clone(read), write...)
	resources, err := environmentView(c.plan, environment, catalog.Project, identity, access, allowed)
	if err != nil {
		return err
	}
	c.result.Resources = append(c.result.Resources, resources...)
	if identity.Name == "catalog" {
		return nil
	}
	target := catalog
	target.Server, target.Identity, target.Catalog = catalog.Project+"-"+identity.Name, identity.Name, false
	target.Access = "readOnly"
	if len(write) != 0 {
		target.Access = "write"
	}
	target.Tools = selectTools(catalog.Tools, allowed)
	c.result.Targets = append(c.result.Targets, target)
	return nil
}

// platformIdentity separates one identity's reads and writes into distinct platform servers.
func (c *planCompiler) platformIdentity(environment platform.Environment, catalog platform.CompiledTarget, identity platform.Identity, read, write []string) error {
	if identity.Name == "catalog" {
		return nil
	}
	for _, view := range []struct {
		access string
		names  []string
	}{{"readOnly", read}, {"write", write}} {
		if view.access == "write" && len(view.names) == 0 {
			continue
		}
		target := catalog
		target.Server, target.Identity, target.Catalog, target.Access = catalog.Service+"-"+identity.Name, identity.Name, false, view.access
		path := "/mcp/" + catalog.Service + "/" + identity.Name + "/readonly"
		if view.access == "write" {
			target.Server += "-changes"
			path = "/mcp/" + catalog.Service + "/" + identity.Name + "/changes"
		}
		if len(target.Server) > 63 {
			return fmt.Errorf("generated server name exceeds 63 characters: %s", target.Server)
		}
		target.Tools = selectTools(catalog.Tools, view.names)
		c.result.Targets = append(c.result.Targets, target)
		if environment.Gateway != nil {
			c.result.Resources = append(c.result.Resources, platformView(c.plan, environment, target, names(view.names), path)...)
		}
	}
	return nil
}

func selectTools(tools []platform.CompiledTool, allowed []string) []platform.CompiledTool {
	return slices.DeleteFunc(slices.Clone(tools), func(tool platform.CompiledTool) bool { return !slices.Contains(allowed, tool.Name) })
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
