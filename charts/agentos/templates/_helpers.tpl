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
{{- define "agentos.dataplaneService" -}}
{{- printf "%s-dataplane" (include "agentos.name" .) -}}
{{- end -}}
{{- define "agentos.actorJWKSBackend" -}}
{{- printf "%s-actor-jwks" (include "agentos.name" .) -}}
{{- end -}}
{{- define "agentos.controllerSubject" -}}
{{- default (printf "system:serviceaccount:%s:kagent-controller" .Release.Namespace) .Values.kagent.controllerSubject -}}
{{- end -}}

{{- define "agentos.origins" -}}
{{- $hosts := .Values.route.hosts -}}
{{- $sandbox := regexReplaceAll ":0*443$" .Values.mcpApps.sandboxOrigin "" -}}
{{- range concat (list (printf "https://%s" $hosts.console) (printf "https://%s" $hosts.api)) .Values.identity.returnOrigins -}}
{{- if and $sandbox (eq $sandbox (regexReplaceAll ":0*443$" . "")) -}}
{{- fail "mcpApps.sandboxOrigin must be an isolated origin" -}}
{{- end -}}
{{- end -}}
{{- dict
  "console" (printf "https://%s" (required "route.hosts.console is required" $hosts.console))
  "api" (printf "https://%s" (required "route.hosts.api is required" $hosts.api))
  "sandbox" $sandbox
  | toJson -}}
{{- end -}}

{{- define "agentos.workloadAuthName" -}}
{{- printf "%s.%s-workload-auth" .Release.Namespace (include "agentos.name" .) -}}
{{- end -}}
