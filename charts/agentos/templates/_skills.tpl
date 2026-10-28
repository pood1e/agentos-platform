{{- define "agentos.presetSkill" -}}
{{- range .root.Values.global.agentos.skills -}}
{{- if eq .skill.name $.name -}}
{{- toYaml (dict "name" .skill.name "source" (omit .skill "name")) -}}
{{- end -}}
{{- end -}}
{{- end -}}
