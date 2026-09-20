import { buildCapabilities } from "../../../../../../src/runtime-control/capabilities.ts";
import { control, dynamic, runtime } from "../_shared.ts";

export { dynamic, runtime };

export async function GET(): Promise<Response> {
  const body = await buildCapabilities((await control()).registration);
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
