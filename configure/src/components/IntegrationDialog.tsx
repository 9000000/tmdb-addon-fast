import { lazy, Suspense, ComponentType } from "react";
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

interface IntegrationDialogProps {
  id: string;
  name: string;
  icon: string;
}

const integrationsMap: Record<string, ComponentType<unknown>> = {
  gemini: lazy(() => import("../integrations/gemini")),
  groq: lazy(() => import("../integrations/groq")),
  mdblist: lazy(() => import("../integrations/mdblist")),
  rpdb: lazy(() => import("../integrations/rpdb")),
  streaming: lazy(() => import("../integrations/streaming")),
  tmdb: lazy(() => import("../integrations/tmdb")),
  topposters: lazy(() => import("../integrations/topposters")),
  trakt: lazy(() => import("../integrations/trakt")),
};

const DefaultIntegration = lazy(() => import("./DefaultIntegration"));

export function IntegrationDialog({ id, name, icon }: IntegrationDialogProps) {
  const IntegrationComponent = integrationsMap[id] || DefaultIntegration;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-lg sm:text-xl">
          <img src={icon} alt={name} className="w-5 h-5 sm:w-6 sm:h-6" />
          {name} Configuration
        </DialogTitle>
        <DialogDescription className="text-sm sm:text-base">
          Configure your {name} integration settings below.
        </DialogDescription>
      </DialogHeader>
      
      <div className="grid gap-3 sm:gap-4">
        <Suspense fallback={<Skeleton className="h-[200px] w-full" />}>
          <IntegrationComponent />
        </Suspense>
      </div>
    </>
  );
} 