{{- define "agentos-connections.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{- end -}}

{{- define "agentos-connections.transport" -}}
{{- $discovery := "!('x-substrate-actor-token' in request.headers)" -}}
backendRef: {name: {{ .root.Values.platform.release }}-console, port: 9090}
failureMode: FailClosed
http:
  path: "'/authorize/environment'"
  body: {{ printf "{'serviceNames': [%s], 'metadataContext': {'environment': %s, 'identity': %s, 'discovery': %s}}" (toJson .service) (toJson .environment) (toJson .identity) $discovery | quote }}
  allowedRequestHeaders: [x-substrate-actor-token, authorization]
  allowedResponseHeaders: [authorization]
{{- end -}}

{{- define "agentos-connections.processor" -}}
processors:
  - methods: {'*': Full}
    remote:
      backendRef: {name: {{ .root.Values.platform.release }}-console, port: 9090}
      failureMode: FailClosed
      allowedRequestHeaders: [x-substrate-actor-token]
      metadata:
        execution: 'true'
        environment: {{ .environment | squote | quote }}
        identity: {{ .identity | squote | quote }}
{{- end -}}
