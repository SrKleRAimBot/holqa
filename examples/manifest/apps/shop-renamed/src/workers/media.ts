import { handles } from "@/apps/shop-renamed/infra";

/** The reindex consumer under a new export name. */
export const refreshSearch = handles.productReindexQueue.consume({ id: "catalog.reindex", handler: () => {} });

/** The thumbnail handler under a new export name. */
export const resizePhotos = handles.productPhotos.onObjectCreated({ id: "catalog.thumbnail", prefix: "uploads/", handler: () => {} });

/** The nightly handler, moved into this module. */
export const nightlyJob = handles.cron.handle({ id: "reports.nightly", handler: () => {} });