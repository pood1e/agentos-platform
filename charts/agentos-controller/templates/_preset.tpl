{{- define "agentos.preset" -}}
apiVersion: agentos.dev/v1alpha1
kind: Preset
metadata:
  name: {{ .name }}
spec:
  resources:
    {{- range $path, $_ := .files }}
    {{- range $raw := splitList "\n---\n" (tpl ($.root.Files.Get $path) $.root) }}
    - {{ fromYaml $raw | toYaml | nindent 6 | trim }}
    {{- end }}
    {{- end }}
{{- end -}}
