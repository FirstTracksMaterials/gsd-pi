import { admitCommand, admitResponse, control, controlError, dynamic, readJson, routeParam, runtime } from "../../../_shared.ts";

export { dynamic, runtime };

export async function POST(
  request: Request,
  context: { params: Promise<{ job_id: string }> | { job_id: string } },
): Promise<Response> {
  try {
    const jobId = await routeParam(context.params, "job_id");
    const body = await readJson(request);
    const result = await admitCommand(await control(), jobId, body);
    return admitResponse(result);
  } catch (error) {
    return controlError(error);
  }
}
