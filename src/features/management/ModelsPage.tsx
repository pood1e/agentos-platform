import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectionKind } from "../../../gen/agentos/management/v1/management_pb.js";
import { ConnectionsPage } from "./ConnectionsPage.js";
import { SpeechModelsPage } from "./SpeechModelsPage.js";

export function ModelsPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const type = search.get("type") === "speech" ? "speech" : "language";
  return (
    <Tabs
      value={type}
      onValueChange={(value) => setSearch(value === "speech" ? { type: value } : {})}
      className="gap-5"
    >
      <TabsList variant="line">
        <TabsTrigger value="language">{t("management.speech.languageModels")}</TabsTrigger>
        <TabsTrigger value="speech">{t("management.speech.models")}</TabsTrigger>
      </TabsList>
      <TabsContent value="language">
        <ConnectionsPage kind={ConnectionKind.MODEL} />
      </TabsContent>
      <TabsContent value="speech">
        <SpeechModelsPage />
      </TabsContent>
    </Tabs>
  );
}
