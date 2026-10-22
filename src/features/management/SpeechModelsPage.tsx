import { useQuery } from "@tanstack/react-query";
import { Mic, RefreshCw, Volume2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import { useCapability } from "../../lib/access.js";
import { managementClient } from "../../lib/console.js";
import { ResourceSheet } from "./ResourceDialog.js";
import { Failure } from "./ResourcePage.js";
import { SpeechEditor, type SpeechKind } from "./SpeechEditor.js";

export function SpeechModelsPage() {
  const { t, i18n } = useTranslation();
  const editable = useCapability(Capability.MODELS_MANAGE);
  const [editing, setEditing] = useState<SpeechKind>();
  const settings = useQuery({
    queryKey: ["management", "speech"],
    queryFn: () => managementClient.getSpeechConfiguration({}),
  });
  const languages = new Intl.DisplayNames([i18n.resolvedLanguage ?? "en"], { type: "language" });
  return (
    <div className="space-y-5" data-testid="speech-models">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("management.tabs.models")}</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void settings.refetch()}
          disabled={settings.isFetching}
        >
          <RefreshCw />
          {t("management.speech.refresh")}
        </Button>
      </div>
      <Failure error={settings.error} />
      {settings.isPending && (
        <p className="text-sm text-muted-foreground">{t("management.loading")}</p>
      )}
      {settings.data && (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          {(["transcription", "synthesis"] as const).map((kind) => {
            const provider = settings.data.configuration?.[kind];
            const credential =
              kind === "transcription"
                ? settings.data.transcriptionCredentialConfigured
                : settings.data.synthesisCredentialConfigured;
            const Icon = kind === "transcription" ? Mic : Volume2;
            return (
              <Card key={kind} data-testid={`speech-${kind}`}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Icon className="size-4" />
                    {t(`management.speech.${kind}`)}
                  </CardTitle>
                  <CardAction>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!provider && !editable}
                      onClick={() => setEditing(kind)}
                    >
                      {t(
                        !editable
                          ? "management.view"
                          : provider
                            ? "management.edit"
                            : "management.addConnection",
                      )}
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={provider ? "secondary" : "outline"}>
                      {t(
                        provider
                          ? "management.speech.configured"
                          : "management.speech.unconfigured",
                      )}
                    </Badge>
                    {provider && credential && (
                      <Badge variant="outline">{t("management.speech.credentialConfigured")}</Badge>
                    )}
                  </div>
                  {provider && (
                    <p className="break-all text-xs text-muted-foreground">
                      {provider.endpoint?.baseUrl}
                    </p>
                  )}
                  {kind === "transcription" && settings.data.configuration?.transcription && (
                    <>
                      <p className="break-all font-mono text-sm">
                        {settings.data.configuration.transcription.model}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {settings.data.configuration.transcription.languageCodes.map((code) => (
                          <Badge key={code} variant="outline">
                            {languages.of(code) ?? code}
                          </Badge>
                        ))}
                      </div>
                    </>
                  )}
                  {kind === "synthesis" && (
                    <div className="space-y-3">
                      {settings.data.configuration?.synthesis?.voices.map((voice) => (
                        <div
                          key={voice.languageCode}
                          className="flex items-start gap-3 rounded-md border p-3"
                        >
                          <Badge variant="outline">
                            {languages.of(voice.languageCode) ?? voice.languageCode}
                          </Badge>
                          <div className="min-w-0">
                            <p className="break-all font-mono text-xs">{voice.model}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{voice.voice}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <ResourceSheet
        title={t(`management.speech.${editing ?? "transcription"}`)}
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        {editing && settings.data && (
          <SpeechEditor
            kind={editing}
            settings={settings.data}
            onSaved={() => {
              setEditing(undefined);
              void settings.refetch();
            }}
          />
        )}
      </ResourceSheet>
    </div>
  );
}
