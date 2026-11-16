import type { TerminalIdentity } from "./middleware/terminal-auth";
import type { AttachmentRow, DocumentTypeModule, JobClient } from "@dulja/db";
import type { TenantContext } from "@dulja/db";
import type { Logger } from "@dulja/contracts";
import type { Sql } from "postgres";
export interface RequestContext extends TenantContext {
  readonly principalKind: "human" | "system" | "terminal";
  readonly aal: "aal1" | "aal2";
}
export type AppEnv = {
  Variables: {
    terminal: TerminalIdentity;
    db: Sql;
    ctx: RequestContext;
    withTenant: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
    logger: Logger;
    requestId: string;
    traceId: string;
    /** 2C — set by requireAttachmentRead (contracts §4.2.3). */
    attachment: { row: AttachmentRow; module: DocumentTypeModule };
    /** 2C — set by requireDocumentModuleRead (contracts §4.2.3, §4.5.9). */
    documentModule: DocumentTypeModule;
    /** 3B — postDocument step 14 enqueues inventory.cost.replay on the posting transaction (amendment A5). */
    jobs: JobClient;
  };
};
