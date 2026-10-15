import type { ReactNode } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TabsContent } from "@/components/ui/tabs";

export function RoleSection({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsContent value={value} forceMount className="flex min-h-0 data-[state=inactive]:hidden">
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        {children}
      </ScrollArea>
    </TabsContent>
  );
}
