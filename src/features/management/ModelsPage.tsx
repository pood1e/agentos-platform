import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectionKind, ModelPurpose } from "../../../gen/agentos/management/v1/management_pb.js";
import { ConnectionsPage } from "./ConnectionsPage.js";
import { SpeechModelsPage } from "./SpeechModelsPage.js";

export function ModelsPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const selected = search.get("type");
  const type = selected === "speech" || selected === "embedding" ? selected : "language";
  return (
    <Tabs
      value={type}
      onValueChange={(value) => setSearch(value === "language" ? {} : { type: value })}
      className="gap-5"
    >
      <TabsList variant="line">
        <TabsTrigger value="language">{t("management.speech.languageModels")}</TabsTrigger>
        <TabsTrigger value="embedding">{t("management.embeddingModels")}</TabsTrigger>
        <TabsTrigger value="speech">{t("management.speech.models")}</TabsTrigger>
      </TabsList>
      <TabsContent value="language">
        <ConnectionsPage kind={ConnectionKind.MODEL} purpose={ModelPurpose.LANGUAGE} />
      </TabsContent>
      <TabsContent value="embedding">
        <ConnectionsPage kind={ConnectionKind.MODEL} purpose={ModelPurpose.EMBEDDING} />
      </TabsContent>
      <TabsContent value="speech">
        <SpeechModelsPage />
      </TabsContent>
    </Tabs>
  );
}
