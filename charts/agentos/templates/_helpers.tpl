{{- define "agentos.name" -}}
{{- .Release.Name | trunc 44 | trimSuffix "-" -}}
{{- end -}}
{{- define "agentos.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
app.kubernetes.io/part-of: agentos
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}
{{- define "agentos.securityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
seccompProfile: {type: RuntimeDefault}
{{- end -}}
{{- define "agentos.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: {drop: [ALL]}
{{- end -}}

{{- define "agentos.apiService" -}}
{{- printf "%s-api" (include "agentos.name" .) -}}
{{- end -}}
{{- define "agentos.actorJWKSBackend" -}}
{{- printf "%s-actor-jwks" (include "agentos.name" .) -}}
{{- end -}}
{{- define "agentos.kagentEndpoint" -}}
{{- $endpoint := urlParse (trimSuffix "/" .Values.kagent.endpoint) -}}
{{- $hostname := regexFind "^\\[[^]]+\\]|^[^:]+" $endpoint.host -}}
{{- if regexMatch "^[a-zA-Z][a-zA-Z0-9-]*$" $hostname -}}
  {{- $_ := set $endpoint "host" (printf "%s.%s.svc.cluster.local%s" $hostname .Release.Namespace (trimPrefix $hostname $endpoint.host)) -}}
{{- end -}}
{{- urlJoin $endpoint -}}
{{- end -}}

{{- define "agentos.origins" -}}
{{- $route := .Values.route -}}
{{- $sandbox := regexReplaceAll ":0*443$" .Values.mcpApps.sandboxOrigin "" -}}
{{- range list $route.console.origin $route.api.origin -}}
{{- if and $sandbox (eq $sandbox (regexReplaceAll ":0*443$" . "")) -}}
{{- fail "mcpApps.sandboxOrigin must be an isolated origin" -}}
{{- end -}}
{{- end -}}
{{- dict
  "console" (required "route.console.origin is required" $route.console.origin)
  "api" (required "route.api.origin is required" $route.api.origin)
  "sandbox" $sandbox
  | toJson -}}
{{- end -}}

{{/* Route hostnames for a public origin; an IP origin is selected by its listener. */}}
{{- define "agentos.routeHostnames" -}}
{{- $host := regexReplaceAll "^https://([^/:]+)(:[0-9]+)?$" . "${1}" -}}
{{- if not (regexMatch "^[0-9.]+$" $host) -}}
hostnames: [{{ $host | quote }}]
{{- end -}}
{{- end -}}

{{- define "agentos.workloadAuthName" -}}
{{- printf "%s.%s-workload-auth" .Release.Namespace (include "agentos.name" .) -}}
{{- end -}}
