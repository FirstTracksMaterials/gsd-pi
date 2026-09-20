import { buildProjectList } from "../../../../../../src/runtime-control/capabilities.ts";
import { control, dynamic, runtime } from "../_shared.ts";

export { dynamic, runtime };

export async function GET(): Promise<Response> {
  const body = await buildProjectList((await control()).registration);
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
