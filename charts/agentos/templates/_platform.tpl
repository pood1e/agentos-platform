{{- define "agentos.platformSelector" -}}
app.kubernetes.io/name: agentos
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "agentos.telemetryEnv" -}}
{{- $metrics := .root.Values.telemetry.metrics -}}
- {name: OTEL_SERVICE_NAME, value: {{ printf "agentos-%s" .component | quote }}}
{{- if $metrics.endpoint }}
- {name: OTEL_METRICS_EXPORTER, value: otlp}
- {name: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, value: {{ $metrics.endpoint | quote }}}
- {name: OTEL_EXPORTER_OTLP_METRICS_PROTOCOL, value: {{ $metrics.protocol | quote }}}
- {name: OTEL_TRACES_EXPORTER, value: none}
- {name: OTEL_LOGS_EXPORTER, value: none}
{{- else }}
- {name: OTEL_SDK_DISABLED, value: 'true'}
{{- end }}
{{- end -}}

{{- define "agentos.platformEnv" -}}
{{- $root := .root -}}
{{- $identity := $root.Values.identity -}}
- {name: AGENTOS_HOST, value: '0.0.0.0'}
- {name: AGENTOS_PORT, value: '8080'}
- {name: AGENTOS_WORKLOAD_AUTH_CONFIG, value: /etc/agentos/workloads.json}
- {name: KAGENT_URL, value: {{ $root.Values.kagent.endpoint | quote }}}
- {name: KAGENT_NAMESPACE, value: {{ $root.Release.Namespace | quote }}}
- {name: KAGENT_USER_ID, value: {{ $root.Values.kagent.userId | quote }}}
{{ include "agentos.executionEnv" $root }}
- {name: AGENTOS_OIDC_ISSUER, value: {{ required "identity.issuer is required" $identity.issuer | quote }}}
- {name: AGENTOS_OIDC_CLIENT_ID, value: {{ required "identity.clientId is required" $identity.clientId | quote }}}
- {name: AGENTOS_OIDC_AUDIENCE, value: {{ required "identity.audience is required" $identity.audience | quote }}}
- {name: AGENTOS_OIDC_WRITER_ROLE, value: {{ required "identity.writerRole is required" $identity.writerRole | quote }}}
- name: AGENTOS_OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef: {name: {{ $identity.secretRef }}, key: client-secret}
{{- if $root.Values.global.agentos.environments }}
- {name: AGENTOS_GOVERNANCE_CONFIG, value: /etc/agentos-governance/connections.json}
- {name: AGENTOS_ENVIRONMENT_CA_DIR, value: /etc/agentos-environments}
{{- end }}
{{ include "agentos.telemetryEnv" . }}
{{- end -}}

{{- define "agentos.knowledgeEnv" -}}
- {name: AGENTOS_GATEWAY_URL, value: {{ printf "http://%s-gateway.%s.svc.cluster.local:8080" (include "agentos.name" .) .Release.Namespace | quote }}}
- {name: AGENTOS_KNOWLEDGE_TTL_DAYS, value: {{ .Values.knowledgeMemory.ttlDays | quote }}}
- {name: AGENTOS_MODEL_TOKEN_FILE, value: /var/run/agentos-model/token}
{{- end -}}

{{- define "agentos.modelIdentityVolume" -}}
- name: model-identity
  projected:
    sources:
      - serviceAccountToken:
          audience: {{ printf "http://%s-gateway.%s.svc.cluster.local:8080" (include "agentos.name" .) .Release.Namespace | quote }}
          expirationSeconds: 600
          path: token
{{- end -}}

{{- define "agentos.platformDeployment" -}}
{{- $root := .root -}}
{{- $values := index $root.Values .component -}}
{{- $environments := $root.Values.global.agentos.environments -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "agentos.name" $root }}-{{ .component }}
  labels:
    {{- include "agentos.labels" $root | nindent 4 }}
    {{- include "agentos.platformSelector" . | nindent 4 }}
spec:
  replicas: {{ $values.replicas }}
  revisionHistoryLimit: 2
  minReadySeconds: 5
  strategy:
    type: RollingUpdate
    rollingUpdate: {maxSurge: 1, maxUnavailable: 0}
  selector:
    matchLabels:
      {{- include "agentos.platformSelector" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "agentos.platformSelector" . | nindent 8 }}
      {{- with .annotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      terminationGracePeriodSeconds: 60
      serviceAccountName: {{ include "agentos.name" $root }}-{{ .component }}
      automountServiceAccountToken: true
      enableServiceLinks: false
      {{- with $root.Values.imagePullSecrets }}
      imagePullSecrets: {{ toYaml . | nindent 8 }}
      {{- end }}
      securityContext:
        {{- include "agentos.securityContext" $root | nindent 8 }}
        fsGroup: 1000
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              {{- include "agentos.platformSelector" . | nindent 14 }}
      containers:
        - name: {{ .component }}
          image: {{ printf "%s@%s" $root.Values.image.repository $root.Values.image.digest | quote }}
          command: [node, --import, ./build/server/apps/telemetry.js, {{ printf "build/server/apps/%s.js" .component }}]
          ports:
            - {name: http, containerPort: 8080}
            {{- with .ports }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          env:
            {{- include "agentos.platformEnv" . | nindent 12 }}
            {{- with .env }}
            {{- . | nindent 12 }}
            {{- end }}
          # The listener opens after identity discovery, Informer sync and schema setup.
          startupProbe:
            httpGet: {path: /healthz, port: http}
            periodSeconds: 2
            failureThreshold: 90
          readinessProbe:
            httpGet: {path: /readyz, port: http}
            periodSeconds: 3
          livenessProbe:
            httpGet: {path: /healthz, port: http}
            periodSeconds: 20
          lifecycle:
            preStop:
              sleep: {seconds: 5}
          resources:
            {{- toYaml $values.resources | nindent 12 }}
          securityContext:
            {{- include "agentos.containerSecurityContext" $root | nindent 12 }}
          volumeMounts:
            - {name: tools, mountPath: /etc/agentos, readOnly: true}
            - {name: execution-database, mountPath: /etc/agentos-database, readOnly: true}
            {{- if $environments }}
            - {name: environment-ca, mountPath: /etc/agentos-environments, readOnly: true}
            - {name: governance, mountPath: /etc/agentos-governance, readOnly: true}
            {{- end }}
            {{- with .mounts }}
            {{- . | nindent 12 }}
            {{- end }}
      volumes:
        - name: tools
          configMap: {name: {{ include "agentos.name" $root }}-tools}
        - name: execution-database
          secret:
            secretName: {{ $root.Values.execution.databaseCASecret }}
            items: [{key: ca.crt, path: ca.crt}]
        {{- if $environments }}
        - name: environment-ca
          projected:
            sources:
              {{- range $environments }}
              - configMap:
                  name: {{ .name }}-gateway-ca
                  items: [{key: ca.crt, path: {{ printf "%s/ca.crt" .name | quote }}}]
              {{- end }}
        - name: governance
          secret: {secretName: agentos-governance}
        {{- end }}
        {{- with .volumes }}
        {{- . | nindent 8 }}
        {{- end }}
{{- end -}}

{{- define "agentos.platformServiceAccount" -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "agentos.name" .root }}-{{ .component }}
  labels:
    {{- include "agentos.labels" .root | nindent 4 }}
{{- end -}}

{{- define "agentos.platformRole" -}}
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ include "agentos.name" .root }}-{{ .component }}
  labels:
    {{- include "agentos.labels" .root | nindent 4 }}
rules:
  {{- .rules | nindent 2 }}
{{- end -}}

{{- define "agentos.platformRoleBinding" -}}
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ include "agentos.name" .root }}-{{ .component }}
  labels:
    {{- include "agentos.labels" .root | nindent 4 }}
subjects:
  - kind: ServiceAccount
    name: {{ include "agentos.name" .root }}-{{ .component }}
    namespace: {{ .root.Release.Namespace }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ include "agentos.name" .root }}-{{ .component }}
{{- end -}}
