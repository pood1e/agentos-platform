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
- {name: AGENTOS_EVENT_AUTOMATION_ENABLED, value: {{ .Values.automation.enabled | quote }}}
- {name: AGENTOS_RELEASE, value: {{ $name }}}
- {name: AGENTOS_SPEECH_SECRET, value: {{ $name }}-speech}
{{- if .Values.voice.enabled }}
- {name: AGENTOS_VOICE_URL, value: "http://{{ $name }}-voice:8080"}
- name: AGENTOS_VOICE_TOKEN
  valueFrom: {secretKeyRef: {name: {{ .Values.voice.secretRef }}, key: api-token}}
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
  resources: [agenttemplates]
  verbs: [create, update]
- apiGroups: [api.kagent.dev]
  resources: [agents]
  verbs: [update]
- apiGroups: [api.kagent.dev]
  resources: [harnesses]
  verbs: [create, update, delete]
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
{{ include "agentos.runtimeEnv" . }}
- {name: AGENTOS_WORKLOAD_AUTH_CONFIG, value: /etc/agentos/workloads.json}
{{ include "agentos.knowledgeEnv" . }}
{{- end -}}

{{- define "agentos.dataplaneMounts" -}}
- {name: runtime-identity, mountPath: /etc/agentos-runtime, readOnly: true}
- {name: model-identity, mountPath: /var/run/agentos-model, readOnly: true}
- {name: tools, mountPath: /etc/agentos, readOnly: true}
{{- end -}}

{{- define "agentos.dataplaneVolumes" -}}
- name: runtime-identity
  projected:
    sources:
      - serviceAccountToken:
          audience: {{ (urlParse .Values.execution.substrateURL).host | quote }}
          expirationSeconds: 600
          path: token
      - clusterTrustBundle:
          signerName: servicedns.podcert.ate.dev/identity
          labelSelector:
            matchLabels: {podcert.ate.dev/canarying: live}
          path: ca.crt
{{ include "agentos.modelIdentityVolume" . }}
- name: tools
  configMap: {name: {{ include "agentos.name" . }}-tools}
{{- end -}}

{{- define "agentos.dataplaneRules" -}}
- apiGroups: [api.kagent.dev]
  resources: [agents, agenttemplates, harnesses, modelconfigs]
  verbs: [get, list, watch]
- apiGroups: [agentgateway.dev]
  resources: [agentgatewaybackends]
  verbs: [get, list, watch]
- apiGroups: [agentos.dev]
  resources: [accessplans]
  verbs: [get, list, watch]
- apiGroups: ['']
  resources: [secrets]
  verbs: [get]
{{- end -}}

{{- define "agentos.workerRules" -}}
- apiGroups: [agentos.dev]
  resources: [accessplans]
  verbs: [get, list, watch]
- apiGroups: ['']
  resources: [secrets]
  verbs: [get]
{{- end -}}
