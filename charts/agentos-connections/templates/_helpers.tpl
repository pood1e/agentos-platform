{{- define "agentos-connections.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{- end -}}

{{- define "agentos-connections.browserBackend" -}}
http: {requestTimeout: 30s}
tls:
  sni: {{ .environment.gateway.host | quote }}
  caCertificateRefs: [{name: {{ .environment.name }}-gateway-ca, kind: ConfigMap}]
  verifySubjectAltNames: [{{ .environment.gateway.host | quote }}]
auth:
  oauthTokenExchange:
    url: {{ required "environment.tokenEndpointURL is required" .environment.tokenEndpointURL | quote }}
    audiences: [{{ .environment.resource | quote }}]
    requestedTokenType: AccessToken
    clientAuth:
      clientId: {{ printf "agentos-%s" .identity | quote }}
      secretRef: {name: {{ printf "%s-%s" .environment.name .identity }}, key: client-secret}
{{- end -}}

{{- define "agentos-connections.browserTraffic" -}}
{{- $provider := deepCopy .root.Values.platform.authentication -}}
{{- $_ := set $provider "validation" (dict "requiredClaims" (list "sub" "exp" "aud")) -}}
headerModifiers:
  request:
    remove: [cookie, proxy-authorization, x-forwarded-access-token, x-auth-request-access-token, x-substrate-actor-token]
  response:
    remove: [set-cookie]
    set: [{name: Cache-Control, value: no-store}]
jwtAuthentication:
  mode: Strict
  preserveToken: true
  location: {header: {name: Authorization, prefix: 'Bearer '}}
  providers:
    - {{ toYaml $provider | nindent 6 }}
authorization:
  action: Require
  policy:
    matchExpressions:
      - {{ .expression | quote }}
{{- end -}}

{{- define "agentos-connections.viewer" -}}
has(jwt.sub) && jwt.sub.matches('[^[:space:]]') && has(jwt.iat) && (type(jwt.iat) == int || type(jwt.iat) == uint || type(jwt.iat) == double)
{{- end -}}

{{- define "agentos-connections.apiMethod" -}}
{{- $path := printf "/environments/%s/rpc/%s/%s" .environment.name .service .method -}}
{{- $name := printf "%s-api-%s" .environment.name ($path | sha256sum | trunc 16) -}}
{{- $expression := printf "%s && 'content-type' in request.headers && request.headers['content-type'].matches('^application/json(;.*)?$')" (include "agentos-connections.viewer" .) -}}
{{- if .write -}}
{{- $expression = printf "%s && has(jwt.roles) && %s in jwt.roles" $expression (.root.Values.platform.writerRole | toJson) -}}
{{- end }}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ $name }}
  labels:
    {{- include "agentos-connections.labels" .root | nindent 4 }}
    agentos.dev/browser-environment: {{ .environment.name }}
spec:
  parentRefs: [{name: {{ .root.Values.platform.release }}-gateway, sectionName: http}]
  rules:
    - matches: [{method: POST, path: {type: Exact, value: {{ $path | quote }}}}]
      filters:
        - type: URLRewrite
          urlRewrite:
            path: {type: ReplaceFullPath, replaceFullPath: {{ printf "/%s/%s" .service .method | quote }}}
      backendRefs: [{group: agentgateway.dev, kind: AgentgatewayBackend, name: {{ .environment.name }}-browser-api}]
---
apiVersion: agentgateway.dev/v1alpha1
kind: AgentgatewayPolicy
metadata:
  name: {{ $name }}
  labels:
    {{- include "agentos-connections.labels" .root | nindent 4 }}
    agentos.dev/browser-environment: {{ .environment.name }}
spec:
  targetRefs: [{group: gateway.networking.k8s.io, kind: HTTPRoute, name: {{ $name }}}]
  traffic:
    {{- include "agentos-connections.browserTraffic" (dict "root" .root "expression" $expression) | nindent 4 }}
{{- end -}}
