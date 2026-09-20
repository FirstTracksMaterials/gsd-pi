import { buildProjectList } from "../../../../../../src/runtime-control/index.ts";
import { control, dynamic, runtime } from "../_shared.ts";

export { dynamic, runtime };

export async function GET(): Promise<Response> {
  const body = await buildProjectList(control().registration);
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
