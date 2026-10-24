{{- define "agentos.environmentTools" -}}
{{- $root := .root -}}
{{- $tools := list -}}
{{- $toolsets := $root.Values.global.agentos.toolsets -}}
{{- range $target, $set := $toolsets -}}
{{- if or (not $.project) (eq $.project $target) -}}
{{- range (index $set $.access) -}}
{{- $tools = append $tools (printf "%s-%s_%s" $.environment $target .) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- toYaml $tools -}}
{{- end -}}

{{- define "agentos.environmentBindings" -}}
{{- $bindings := list -}}
{{- $identity := dict -}}
{{- range $profile := .root.Values.global.agentos.identities -}}
{{- if eq $profile.name $.engineer -}}
{{- $identity = $profile -}}
{{- end -}}
{{- end -}}
{{- if $identity -}}
{{- range $managed := .root.Values.global.agentos.environments -}}
{{- $environment := $managed.name -}}
{{- if or (not (hasKey $identity "environments")) (has $environment $identity.environments) -}}
{{- range $project, $access := $identity.services -}}
{{- $server := dict "kind" "RemoteMCPServer" "name" (printf "%s-%s-%s" $environment $project $.engineer) -}}
{{- $read := include "agentos.environmentTools" (dict "root" $.root "environment" $environment "project" $project "access" "readOnly") | fromYamlArray -}}
{{- if eq $access "manage" -}}
{{- $read = concat $read (include "agentos.environmentTools" (dict "root" $.root "environment" $environment "project" $project "access" "managementReadOnly") | fromYamlArray) -}}
{{- end -}}
{{- $bindings = append $bindings (dict "mcp" (dict "server" $server "tools" $read "requireApproval" false)) -}}
{{- if or (eq $access "operate") (eq $access "manage") -}}
{{- $write := include "agentos.environmentTools" (dict "root" $.root "environment" $environment "project" $project "access" "write") | fromYamlArray -}}
{{- if eq $access "manage" -}}
{{- $write = include "agentos.environmentTools" (dict "root" $.root "environment" $environment "project" $project "access" "management") | fromYamlArray -}}
{{- end -}}
{{- if $write -}}
{{- $changeServer := dict "kind" "RemoteMCPServer" "name" (printf "%s-changes" $server.name) -}}
{{- $toolset := index $.root.Values.global.agentos.toolsets $project -}}
{{- $approval := concat ($toolset.write | default list) ($toolset.management | default list) -}}
{{- if hasKey $toolset "approval" -}}
{{- $approval = $toolset.approval -}}
{{- end -}}
{{- range $requiresReview := list false true -}}
{{- $selected := list -}}
{{- range $tool := $write -}}
{{- $name := trimPrefix (printf "%s-%s_" $environment $project) $tool -}}
{{- if eq $requiresReview (and (eq $managed.governance "approval") (has $name $approval)) -}}
{{- $selected = append $selected $tool -}}
{{- end -}}
{{- end -}}
{{- if $selected -}}
{{- $bindings = append $bindings (dict "mcp" (dict "server" $changeServer "tools" $selected "requireApproval" $requiresReview)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- toYaml $bindings -}}
{{- end -}}
