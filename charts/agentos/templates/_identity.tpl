{{- define "agentos.identityVolumes" -}}
{{- with .Values.identity.caCertificateRef -}}
- name: identity-ca
  configMap:
    name: {{ required "identity.caCertificateRef.name is required" .name }}
    items: [{key: {{ required "identity.caCertificateRef.key is required" .key }}, path: ca.crt}]
{{- end -}}
{{- end -}}

{{- define "agentos.identityMounts" -}}
{{- with .Values.identity.caCertificateRef -}}
- {name: identity-ca, mountPath: /etc/agentos/identity, readOnly: true}
{{- end -}}
{{- end -}}
