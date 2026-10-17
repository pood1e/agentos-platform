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

{{- define "agentos.collaborationToken" -}}
{{- if not (hasKey . "_collaborationToken") -}}
{{- $secret := lookup "v1" "Secret" .Release.Namespace (printf "%s-gateway" (include "agentos.name" .)) -}}
{{- $token := randAlphaNum 64 -}}
{{- if and $secret (hasKey $secret.data "mcp-api-key") }}{{- $token = index $secret.data "mcp-api-key" | b64dec -}}{{- end -}}
{{- $_ := set . "_collaborationToken" $token -}}
{{- end -}}
{{- index . "_collaborationToken" -}}
{{- end -}}

{{- define "agentos.catalogToken" -}}
{{- if not (hasKey . "_catalogToken") -}}
{{- $secret := lookup "v1" "Secret" .Release.Namespace (printf "%s-gateway" (include "agentos.name" .)) -}}
{{- $token := randAlphaNum 64 -}}
{{- if and $secret (hasKey $secret.data "catalog-api-key") }}{{- $token = index $secret.data "catalog-api-key" | b64dec -}}{{- end -}}
{{- $_ := set . "_catalogToken" $token -}}
{{- end -}}
{{- index . "_catalogToken" -}}
{{- end -}}

{{- define "agentos.nativeToken" -}}
{{- $root := .root -}}
{{- if not (hasKey $root "_nativeTokens") }}{{- $_ := set $root "_nativeTokens" dict -}}{{- end -}}
{{- if not (hasKey $root._nativeTokens .name) -}}
{{- $secret := lookup "v1" "Secret" $root.Release.Namespace .name -}}
{{- $token := randAlphaNum 64 -}}
{{- if $secret }}{{- $token = required "Native credential is missing api-key" (index $secret.data "api-key" | b64dec) -}}{{- end -}}
{{- $_ := set $root._nativeTokens .name $token -}}
{{- end -}}
{{- index $root._nativeTokens .name -}}
{{- end -}}
