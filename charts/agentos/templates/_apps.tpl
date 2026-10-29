{{- define "agentos.appJWTProvider" -}}
{{- $endpoint := urlParse (required "identity.jwksURL is required for MCP Apps" .Values.identity.jwksURL) -}}
{{- $path := $endpoint.path | default "/" -}}
{{- if $endpoint.query }}{{ $path = printf "%s?%s" $path $endpoint.query }}{{ end -}}
issuer: {{ .Values.identity.issuer | quote }}
audiences: [{{ .Values.identity.audience | quote }}]
jwks:
  remote:
    backendRef: {group: agentgateway.dev, kind: AgentgatewayBackend, name: {{ include "agentos.name" . }}-app-jwks}
    jwksPath: {{ $path | quote }}
validation: {requiredClaims: [sub, exp, aud]}
{{- end -}}
