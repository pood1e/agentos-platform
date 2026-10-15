{{- define "agentos.name" -}}
{{- .Release.Name | trunc 44 | trimSuffix "-" -}}
{{- end -}}
{{- define "agentos.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
app.kubernetes.io/part-of: agentos
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}
{{- define "agentos.authService" -}}
{{- include "oauth2-proxy.fullname" (index .Subcharts "oauth2-proxy") -}}
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

{{- define "agentos.gatewayToken" -}}
{{- if not (hasKey . "_gatewayToken") -}}
{{- $secret := lookup "v1" "Secret" .Release.Namespace (printf "%s-gateway" (include "agentos.name" .)) -}}
{{- $token := randAlphaNum 64 -}}
{{- if $secret }}{{- $token = index $secret.data "api-key" | b64dec -}}{{- end -}}
{{- $_ := set . "_gatewayToken" $token -}}
{{- end -}}
{{- index . "_gatewayToken" -}}
{{- end -}}
