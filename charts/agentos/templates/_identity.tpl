{{- define "agentos.origins" -}}
{{- $hosts := .Values.route.hosts -}}
{{- dict
  "console" (printf "https://%s" (required "route.hosts.console is required" $hosts.console))
  "api" (printf "https://%s" (required "route.hosts.api is required" $hosts.api))
  "sandbox" (ternary (printf "https://%s" $hosts.sandbox) "" (ne $hosts.sandbox ""))
  | toJson -}}
{{- end -}}

{{- define "agentos.identity" -}}
{{- $origins := include "agentos.origins" . | fromJson -}}
{{- if eq .Values.identity.mode "password" -}}
{{- dict "issuer" (printf "%s/identity" $origins.console) "clientId" "agentos" "audience" "agentos" "writerRole" "agentos-writer" "secret" (printf "%s-identity-keys" (include "agentos.name" .)) | toJson -}}
{{- else -}}
{{- with .Values.identity -}}
{{- dict "issuer" .issuer "clientId" .clientId "audience" .audience "writerRole" .writerRole "secret" .secretRef | toJson -}}
{{- end -}}
{{- end -}}
{{- end -}}
