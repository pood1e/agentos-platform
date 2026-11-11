{{- define "agentos.apiEnv" -}}
{{- $origins := include "agentos.origins" . | fromJson -}}
{{- $name := include "agentos.name" . -}}
{{- $home := dict "namespace" .Release.Namespace "release" $name "entryAgent" .Values.entryAgent "harness" .Values.defaultHarness "kagentURL" (include "agentos.kagentEndpoint" .) -}}
- name: AGENTOS_WORKSPACES
  value: {{ concat (list $home) .Values.api.workspaces | toJson | quote }}
{{- with $origins.sandbox }}
- {name: AGENTOS_SANDBOX_ORIGIN, value: {{ . | quote }}}
{{- end }}
{{- if .Values.voice.enabled }}
- {name: AGENTOS_VOICE_GATEWAY_URL, value: "http://{{ $name }}-mcp-gateway.{{ .Release.Namespace }}.svc.cluster.local:8080"}
- {name: AGENTOS_VOICE_AGENT, value: {{ $name }}-voice}
- {name: AGENTOS_VOICE_SUBJECT, value: "system:serviceaccount:{{ .Release.Namespace }}:{{ $name }}-voice"}
- name: AGENTOS_VOICE_SESSION_KEY
  valueFrom: {secretKeyRef: {name: {{ .Values.voice.sessionSecretRef }}, key: key}}
- {name: LIVEKIT_URL, value: {{ .Values.voice.livekitURL | quote }}}
- name: AGENTOS_LIVEKIT_URL
  value: {{ default (printf "%s/livekit" (replace "https://" "wss://" .Values.route.console.origin)) .Values.voice.publicURL | quote }}
- name: LIVEKIT_API_KEY
  valueFrom: {secretKeyRef: {name: {{ .Values.voice.secretRef }}, key: api-key}}
- name: LIVEKIT_API_SECRET
  valueFrom: {secretKeyRef: {name: {{ .Values.voice.secretRef }}, key: api-secret}}
{{- end }}
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
  verbs: [get, list, create, update, patch, delete]
{{- end -}}

{{- define "agentos.dataplaneEnv" -}}
- {name: KAGENT_URL, value: {{ include "agentos.kagentEndpoint" . | quote }}}
- {name: KAGENT_NAMESPACE, value: {{ .Release.Namespace | quote }}}
- {name: AGENTOS_CONTROLLER_SUBJECT, value: "system:serviceaccount:{{ .Release.Namespace }}:{{ include "agentos.name" . }}-discovery"}
{{- end -}}

{{- define "agentos.dataplaneRules" -}}
- apiGroups: [agentos.dev]
  resources: [accessplans]
  verbs: [get, list, watch]
{{- end -}}
