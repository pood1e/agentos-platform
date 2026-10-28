{{- define "agentos.apiEnv" -}}
{{- $origins := include "agentos.origins" . | fromJson -}}
{{- $name := include "agentos.name" . -}}
- {name: AGENTOS_API_ORIGIN, value: {{ $origins.api | quote }}}
- name: AGENTOS_DELEGATION_ORIGINS
  value: {{ prepend .Values.identity.returnOrigins $origins.console | uniq | toJson | quote }}
- name: AGENTOS_COOKIE_SECRET
  valueFrom:
    secretKeyRef: {name: {{ $name }}-sessions, key: delegation}
{{- with $origins.sandbox }}
- {name: AGENTOS_SANDBOX_ORIGIN, value: {{ . | quote }}}
{{- end }}
- {name: AGENTOS_ENTRY_AGENT, value: {{ .Values.entryAgent | quote }}}
- {name: AGENTOS_RELEASE, value: {{ $name }}}
- {name: AGENTOS_SPEECH_SECRET, value: {{ $name }}-speech}
{{- if .Values.voice.enabled }}
- {name: AGENTOS_VOICE_GATEWAY_URL, value: "http://{{ $name }}-mcp-gateway.{{ .Release.Namespace }}.svc.cluster.local:8080"}
- {name: AGENTOS_VOICE_AGENT, value: {{ $name }}-voice}
- {name: AGENTOS_VOICE_SUBJECT, value: "system:serviceaccount:{{ .Release.Namespace }}:{{ $name }}-voice"}
- name: AGENTOS_VOICE_SESSION_KEY
  valueFrom: {secretKeyRef: {name: {{ .Values.voice.sessionSecretRef }}, key: key}}
- {name: LIVEKIT_URL, value: {{ .Values.voice.livekitURL | quote }}}
- name: AGENTOS_LIVEKIT_URL
  value: {{ default (printf "wss://%s/livekit" .Values.route.hosts.console) .Values.voice.publicURL | quote }}
- name: LIVEKIT_API_KEY
  valueFrom: {secretKeyRef: {name: {{ .Values.voice.secretRef }}, key: api-key}}
- name: LIVEKIT_API_SECRET
  valueFrom: {secretKeyRef: {name: {{ .Values.voice.secretRef }}, key: api-secret}}
{{- end }}
- {name: AGENTOS_HARNESS, value: {{ .Values.defaultHarness | quote }}}
- {name: AGENTOS_GATEWAY_NAME, value: {{ printf "%s-gateway" $name | quote }}}
- {name: AGENTOS_MCP_GATEWAY_URL, value: "http://{{ $name }}-mcp-gateway.{{ .Release.Namespace }}.svc.cluster.local:8080"}
- {name: AGENTOS_SKILL_CATALOG, value: {{ printf "%s-skills" $name | quote }}}
{{ include "agentos.knowledgeEnv" . }}
{{- end -}}

{{- define "agentos.apiRules" -}}
- apiGroups: [api.kagent.dev]
  resources: [agents, agenttemplates, harnesses, modelconfigs, remotemcpservers]
  verbs: [get, list]
- apiGroups: [api.kagent.dev]
  resources: [agents, agenttemplates, harnesses, modelconfigs]
  verbs: [watch]
- apiGroups: [api.kagent.dev]
  resources: [remotemcpservers]
  verbs: [patch]
- apiGroups: [agentgateway.dev]
  resources: [agentgatewaymodels, agentgatewaybackends]
  verbs: [get, list, create, update, delete]
- apiGroups: [agentgateway.dev]
  resources: [agentgatewaybackends]
  verbs: [watch]
- apiGroups: [agentos.dev]
  resources: [accessplans]
  verbs: [get, list, watch]
- apiGroups: ['']
  resources: [secrets]
  verbs: [get, create, update, delete]
- apiGroups: ['']
  resources: [configmaps]
  verbs: [get, create, update, patch]
{{- end -}}

{{- define "agentos.dataplaneEnv" -}}
- {name: AGENTOS_CONTROLLER_SUBJECT, value: "system:serviceaccount:{{ .Release.Namespace }}:{{ include "agentos.name" . }}-discovery"}
{{- end -}}

{{- define "agentos.dataplaneRules" -}}
- apiGroups: [agentos.dev]
  resources: [accessplans]
  verbs: [get, list, watch]
{{- end -}}
