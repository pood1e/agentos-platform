{{- define "agentos.executionEnv" -}}
- name: AGENTOS_EXECUTION_DATABASE_URL
  valueFrom:
    secretKeyRef: {name: {{ .Values.execution.databaseSecret }}, key: connectionString}
- name: AGENTOS_EXECUTION_KEY
  valueFrom:
    secretKeyRef: {name: {{ .Values.execution.keySecret }}, key: key}
- {name: AGENTOS_EXECUTION_DATABASE_CA, value: /etc/agentos-database/ca.crt}
{{- end -}}

{{- define "agentos.runtimeEnv" -}}
{{- $audiences := include "agentos.actorAudiences" . | fromJsonArray -}}
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

{{- define "agentos.executionAuthorization" -}}
backendRef: {name: {{ include "agentos.dataplaneService" . }}, port: 9090}
failureMode: FailClosed
http:
  path: "'/authorize/executions'"
  body: "{}"
  allowedRequestHeaders: [authorization]
  allowedResponseHeaders: [authorization]
{{- end -}}
