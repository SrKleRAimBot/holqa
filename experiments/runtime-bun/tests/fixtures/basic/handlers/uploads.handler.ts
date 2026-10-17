import { resources } from "../infra";

/** Copies the size of every object created under `incoming/` to `seen/<key>`. */
export default resources.uploads.onObjectCreated({
  id: "uploads-seen",
  prefix: "incoming/",
  handler: async ({ object }) => {
    await resources.uploads.put(`seen/${object.key}`, String(object.size));
  }
});