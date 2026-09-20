import { admitCommand, admitResponse, control, dynamic, errorResponse, readJson, routeParam, runtime } from "../../../_shared.ts";

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
    const status = error && typeof error === "object" && "status" in error ? Number((error as { status: number }).status) : 400;
    return errorResponse(status, {
      code: "invalid_request",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
  }
}
