{{- define "agentos.executionEnv" -}}
{{- $audiences := include "agentos.actorAudiences" . | fromJsonArray -}}
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

{{- define "agentos.automationAuthorization" -}}
backendRef: {name: {{ include "agentos.name" . }}-console, port: 9090}
failureMode: FailClosed
http:
  path: "'/authorize/automation'"
  body: "{}"
  allowedRequestHeaders: [authorization]
  allowedResponseHeaders: [authorization]
{{- end -}}
