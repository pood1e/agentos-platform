import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { SubjectReference } from "../../../gen/kagent/api/v1/authorization_pb.js";

export function subjectName(subject: SubjectReference | undefined) {
  if (subject?.subject.case === "group") return subject.subject.value.id;
  return subject?.subject.case === "principalId" ? subject.subject.value : "";
}

export function BindingSubject({
  value,
  current,
}: {
  value: SubjectReference | undefined;
  current: string;
}) {
  const { t } = useTranslation();
  if (value?.subject.case === "group")
    return (
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{t("authorization.group")}</Badge>
          <span className="truncate font-medium">{value.subject.value.id}</span>
        </div>
        <p className="mt-1 break-all text-xs text-muted-foreground">{value.subject.value.issuer}</p>
      </div>
    );
  const id = subjectName(value);
  return (
    <div className="min-w-0">
      {id === current && <p className="font-medium">{t("authorization.myAccount")}</p>}
      <code className="block max-w-[30rem] break-all text-xs text-muted-foreground">{id}</code>
    </div>
  );
}
