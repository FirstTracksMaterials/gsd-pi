import { buildProjectList } from "../../../../../../src/runtime-control/capabilities.ts";
import { admitProjectRegistration } from "../../../../../../src/runtime-control/project-registration.ts";
import { control, controlError, dynamic, readJson, runtime } from "../_shared.ts";

export { dynamic, runtime };

export async function GET(): Promise<Response> {
  const body = await buildProjectList((await control()).registration);
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await admitProjectRegistration(await control(), await readJson(request));
    return Response.json(body, {
      status: body.idempotent ? 200 : 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return controlError(error);
  }
}
