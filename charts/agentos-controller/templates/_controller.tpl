{{- define "agentos.controller" -}}
{{- $root := .root -}}
{{- $name := printf "%s-controller" $root.Release.Name -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ $name }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ $name }}
rules:
  - apiGroups: [agentos.dev]
    resources: [accessplans{{ if eq .mode "platform" }}, presets{{ end }}]
    verbs: [get, list, watch]
  - apiGroups: [agentos.dev]
    resources: [accessplans/status{{ if eq .mode "platform" }}, presets/status{{ end }}]
    verbs: [get, update, patch]
  - apiGroups: [agentos.dev]
    resources: [accessplans/finalizers{{ if eq .mode "platform" }}, presets/finalizers{{ end }}]
    verbs: [update]
  - apiGroups: [coordination.k8s.io]
    resources: [leases]
    verbs: [get, list, watch, create, update, patch]
  - apiGroups: [agentgateway.dev]
    resources: [agentgatewaybackends, agentgatewaypolicies{{ if eq .mode "platform" }}, agentgatewaymodels{{ end }}]
    verbs: [get, list, watch, create, patch, update, delete]
  - apiGroups: [gateway.networking.k8s.io]
    resources: [httproutes]
    verbs: [get, list, watch, create, patch, update, delete]
  - apiGroups: ['']
    resources: [events]
    verbs: [create, patch]
  {{- if eq .mode "platform" }}
  - apiGroups: [api.kagent.dev]
    resources: [agents, agenttemplates, harnesses, modelconfigs, remotemcpservers]
    verbs: [get, list, watch, create, patch, update, delete]
  - apiGroups: [agentgateway.dev]
    resources: [agentgatewaybackends/status, agentgatewaymodels/status]
    verbs: [get, patch, update]
  - apiGroups: [agentgateway.dev]
    resources: [agentgatewaybackends/finalizers, agentgatewaymodels/finalizers]
    verbs: [update]
  - apiGroups: ['']
    resources: [secrets, configmaps]
    verbs: [get, list, watch, create, patch, update, delete]
  {{- end }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ $name }}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: {{ $name }}}
subjects: [{kind: ServiceAccount, name: {{ $name }}}]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels: {app.kubernetes.io/name: agentos-controller, app.kubernetes.io/instance: {{ $root.Release.Name }}}
spec:
  replicas: 2
  selector:
    matchLabels: {app.kubernetes.io/name: agentos-controller, app.kubernetes.io/instance: {{ $root.Release.Name }}}
  template:
    metadata:
      labels: {app.kubernetes.io/name: agentos-controller, app.kubernetes.io/instance: {{ $root.Release.Name }}}
    spec:
      serviceAccountName: {{ $name }}
      {{- with $root.Values.controller.imagePullSecrets }}
      imagePullSecrets: {{ toYaml . | nindent 8 }}
      {{- end }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: controller
          image: {{ $root.Values.controller.image | quote }}
          args:
            - --mode={{ .mode }}
            - --namespace={{ $root.Release.Namespace }}
            {{- range $key, $value := .options }}
            - {{ printf "--%s=%s" $key $value | quote }}
            {{- end }}
          ports: [{name: health, containerPort: 8081}]
          readinessProbe: {httpGet: {path: /readyz, port: health}}
          livenessProbe: {httpGet: {path: /healthz, port: health}}
          resources: {{ toYaml $root.Values.controller.resources | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ $name }}
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: agentos-controller, app.kubernetes.io/instance: {{ $root.Release.Name }}}
  policyTypes: [Ingress]
  ingress: []
{{- end -}}
