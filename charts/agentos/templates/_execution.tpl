{{- define "agentos.executionEnv" -}}
{{- $audiences := list (printf "http://%s-mcp-gateway.%s.svc.cluster.local:8080" (include "agentos.name" .) .Release.Namespace) (printf "http://%s-console.%s.svc.cluster.local:9091" (include "agentos.name" .) .Release.Namespace) -}}
{{- range .Values.global.agentos.environments -}}
{{- $environment := .name -}}
{{- range $service, $_ := $.Values.global.agentos.toolsets -}}
{{- $audiences = append $audiences (printf "http://%s-%s-mcp-gateway.%s.svc.cluster.local:8080" $environment $service $.Release.Namespace) -}}
{{- end -}}
{{- end -}}
- name: AGENTOS_EXECUTION_DATABASE_URL
  valueFrom:
    secretKeyRef: {name: {{ .Values.execution.databaseSecret }}, key: connectionString}
- name: AGENTOS_EXECUTION_KEY
  valueFrom:
    secretKeyRef: {name: {{ include "agentos.name" . }}-execution, key: key}
- {name: AGENTOS_EXECUTION_DATABASE_CA, value: /etc/agentos-database/ca.crt}
- {name: AGENTOS_RUNTIME_CA, value: /etc/agentos-runtime/ca.crt}
- {name: NODE_EXTRA_CA_CERTS, value: /etc/agentos-runtime/ca.crt}
- {name: AGENTOS_RUNTIME_TOKEN, value: /etc/agentos-runtime/token}
- {name: AGENTOS_SUBSTRATE_URL, value: {{ .Values.execution.substrateURL | quote }}}
- {name: AGENTOS_ACTOR_ISSUER, value: {{ .Values.execution.actorIssuer | quote }}}
- name: AGENTOS_EXECUTION_WORKSPACES
  value: {{ list .Release.Namespace | toJson | quote }}
- name: AGENTOS_ACTOR_AUDIENCES
  value: {{ $audiences | toJson | quote }}
{{- end -}}
