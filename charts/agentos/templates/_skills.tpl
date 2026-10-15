{{- define "agentos.skillRepositoryURL" -}}
{{- printf "http://%s-skill-gateway.%s.svc.cluster.local:8080%s" (include "agentos.name" .) .Release.Namespace .Values.global.agentos.skillRepository.path -}}
{{- end -}}

{{/* Catalog entries from global.agentos.skills; Git sources without a URL use the skill gateway. */}}
{{- define "agentos.skills" -}}
{{- $root := . -}}
{{- $items := list -}}
{{- range .Values.global.agentos.skills -}}
{{- $item := deepCopy . -}}
{{- if and (hasKey $item.skill "git") (not $item.skill.git.url) -}}
{{- $_ := set $item.skill.git "url" (include "agentos.skillRepositoryURL" $root) -}}
{{- end -}}
{{- $items = append $items $item -}}
{{- end -}}
{{- toYaml $items -}}
{{- end -}}

{{- define "agentos.presetSkill" -}}
{{- range (include "agentos.skills" .root | fromYamlArray) -}}
{{- if eq .skill.name $.name -}}
{{- toYaml (dict "name" .skill.name "source" (omit .skill "name")) -}}
{{- end -}}
{{- end -}}
{{- end -}}
