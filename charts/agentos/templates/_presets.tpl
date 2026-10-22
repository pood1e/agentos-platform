{{/*
Renders a team's kagent AgentTemplate and Agent presets. Solution charts that depend on this chart call
  {{ include "agentos.presets" (dict "root" . "files" (.Files.Glob "presets/engineers/*.yaml")) }}
Templates are created once and keep later console edits; Agents keep the Harness selected in the console.
Environment tool bindings are appended from global.agentos.identities.
*/}}
{{- define "agentos.presets" -}}
{{- $root := .root -}}
{{- range $path, $_ := .files }}
{{- range $raw := splitList "\n---\n" (tpl ($root.Files.Get $path) $root) }}
{{- $resource := fromYaml $raw }}
{{- $metadata := $resource.metadata }}
{{- $template := eq $resource.kind "AgentTemplate" }}
{{- if eq $resource.kind "Agent" }}
{{- $current := lookup $resource.apiVersion $resource.kind $root.Release.Namespace $metadata.name }}
{{- if $current }}
{{- if hasKey $current.spec "harnessRef" }}
{{- $_ := set $resource.spec "harnessRef" $current.spec.harnessRef }}
{{- end }}
{{- end }}
{{- end }}
{{- if or (not $template) (not (lookup $resource.apiVersion $resource.kind $root.Release.Namespace $metadata.name)) }}
{{- $_ := set $metadata "namespace" $root.Release.Namespace }}
{{- $_ := set $metadata "labels" (mergeOverwrite ($metadata.labels | default dict) (include "agentos.labels" $root | fromYaml)) }}
{{- if $template }}
{{- $_ := set $metadata "annotations" (mergeOverwrite ($metadata.annotations | default dict) (dict "helm.sh/resource-policy" "keep")) }}
{{- $bindings := include "agentos.environmentBindings" (dict "root" $root "engineer" $metadata.name) | fromYamlArray }}
{{- if $bindings }}
{{- $_ := set $resource.spec "tools" (concat $resource.spec.tools $bindings) }}
{{- end }}
{{- end }}
---
{{ toYaml $resource }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}
