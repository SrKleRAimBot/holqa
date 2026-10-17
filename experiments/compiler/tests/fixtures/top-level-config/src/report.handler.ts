import app from "../infra";
import { connection } from "./db";

/** Consumes report requests using the top-level connection. */
export default app.resources.reports.consume({
  id: "reports.generate",
  handler: () => {
    void connection.url;
  }
});