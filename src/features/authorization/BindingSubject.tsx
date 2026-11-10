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
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">{t("authorization.group")}</Badge>
          <span className="truncate font-medium" title={value.subject.value.id}>
            {value.subject.value.id}
          </span>
        </div>
        <p
          className="mt-1 truncate text-xs text-muted-foreground"
          title={value.subject.value.issuer}
        >
          {value.subject.value.issuer}
        </p>
      </div>
    );
  const id = subjectName(value);
  return (
    <div className="min-w-0">
      {id === current && <p className="font-medium">{t("authorization.myAccount")}</p>}
      <code className="block truncate text-xs text-muted-foreground" title={id}>
        {id}
      </code>
    </div>
  );
}
