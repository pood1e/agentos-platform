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

{{- define "agentos.actorAudiences" -}}
{{- $audiences := list (printf "http://%s-gateway.%s.svc.cluster.local:8080" (include "agentos.name" .) .Release.Namespace) (printf "http://%s-mcp-gateway.%s.svc.cluster.local:8080" (include "agentos.name" .) .Release.Namespace) (include "agentos.runtimeURL" .) -}}
{{- range .Values.global.agentos.environments -}}
{{- $environment := .name -}}
{{- range $service, $_ := $.Values.global.agentos.toolsets -}}
{{- $audiences = append $audiences (printf "http://%s-%s-mcp-gateway.%s.svc.cluster.local:8080" $environment $service $.Release.Namespace) -}}
{{- end -}}
{{- end -}}
{{- $audiences | toJson -}}
{{- end -}}
{{- define "agentos.workloadAuth" -}}
{{- dict "controllerSubject" (printf "system:serviceaccount:%s:kagent-controller" .Release.Namespace) "platformSubjects" (list (printf "system:serviceaccount:%s:%s" .Release.Namespace (include "agentos.apiService" .)) (printf "system:serviceaccount:%s:%s" .Release.Namespace (include "agentos.dataplaneService" .))) "modelAudience" (printf "http://%s-gateway.%s.svc.cluster.local:8080" (include "agentos.name" .) .Release.Namespace) "mcpAudience" (printf "http://%s-mcp-gateway.%s.svc.cluster.local:8080" (include "agentos.name" .) .Release.Namespace) "executionSources" .Values.execution.sources | toJson -}}
{{- end -}}
{{- define "agentos.workloadAuthName" -}}
{{- printf "%s.%s-workload-auth" .Release.Namespace (include "agentos.name" .) -}}
{{- end -}}

{{- define "agentos.apiService" -}}
{{- printf "%s-api" (include "agentos.name" .) -}}
{{- end -}}
{{- define "agentos.dataplaneService" -}}
{{- printf "%s-dataplane" (include "agentos.name" .) -}}
{{- end -}}
{{- define "agentos.actorKeysService" -}}
{{- include "agentos.dataplaneService" . -}}
{{- end -}}
{{- define "agentos.runtimeURL" -}}
{{- printf "http://%s.%s.svc.cluster.local:9091" (include "agentos.dataplaneService" .) .Release.Namespace -}}
{{- end -}}
